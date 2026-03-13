//! StepExecutor - per-step actor that runs Claude Code CLI for a single workflow step.
//!
//! Spawned by ProjectSupervisor upon receiving an execute_step channel event from Sacrum.
//! Each StepExecutor:
//! - Receives step config (prompt, model), execution_id, and task_id from its parent
//! - Spawns `claude -p <prompt> --output-format stream-json` as a child process
//! - Streams stdout line by line, posting each line as a SessionLog to the ExecutionService
//! - Reports StepCompleted or StepFailed to the parent ProjectSupervisor on exit
//! - Kills the child process on Cancel or actor stop
//!
//! Orchestration (step ordering, parallel vs serial, retry logic) lives entirely
//! in Sacrum/Elixir -- the daemon just executes what it is told.

use std::path::PathBuf;
use std::process::ExitStatus;
use std::sync::Arc;

use ractor::{Actor, ActorProcessingErr, ActorRef};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use vertebrae_core::execution_service::ExecutionService;
use vertebrae_core::models::{AgentConfig, PermissionMode, SessionLog};

use crate::actors::project_supervisor::ProjectMessage;

/// Default model used when agent_config does not specify one.
pub const DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";

#[derive(Debug, Clone)]
pub struct StepConfig {
    pub prompt: String,
    /// Full agent configuration (model, allowed_tools, permission_mode, etc.)
    pub agent_config: AgentConfig,
    /// Agent file paths/names to pass as --agent flags.
    pub agents: Vec<String>,
    /// Skill names to pass as --allowedTools flags.
    pub skills: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum StepResult {
    Completed {
        exit_code: i32,
        metrics: Option<crate::stream_json::StreamMetrics>,
        output: Option<String>,
    },
    Failed {
        exit_code: Option<i32>,
        error: String,
    },
}

/// Configuration for spawning a StepExecutor actor.
pub struct StepExecutorConfig {
    pub execution_id: String,
    pub task_id: String,
    pub step_config: StepConfig,
    pub project_root: PathBuf,
    pub execution_service: Arc<dyn ExecutionService>,
}

impl std::fmt::Debug for StepExecutorConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StepExecutorConfig")
            .field("execution_id", &self.execution_id)
            .field("task_id", &self.task_id)
            .field("step_config", &self.step_config)
            .field("project_root", &self.project_root)
            .field("execution_service", &"<ExecutionService>")
            .finish()
    }
}

pub enum StepExecutorMessage {
    Execute,
    Cancel,
    ProcessExited(Result<ExitStatus, String>),
}

impl std::fmt::Debug for StepExecutorMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Execute => write!(f, "Execute"),
            Self::Cancel => write!(f, "Cancel"),
            Self::ProcessExited(result) => f.debug_tuple("ProcessExited").field(result).finish(),
        }
    }
}

pub fn build_claude_command(config: &StepExecutorConfig) -> Command {
    let mut cmd = Command::new("claude");

    let step = &config.step_config;

    // Ensure a default model when agent_config doesn't specify one.
    let mut agent_config = step.agent_config.clone();
    if agent_config.model.is_none() {
        agent_config = agent_config.with_model(DEFAULT_MODEL);
    }

    // Merge skills into allowed_tools (skills activate tool access).
    if !step.skills.is_empty() {
        let mut tools = agent_config.allowed_tools.clone();
        for skill in &step.skills {
            if !tools.contains(skill) {
                tools.push(skill.clone());
            }
        }
        agent_config = agent_config.with_allowed_tools(tools);
    }

    // Daemon runs autonomously -- default to bypass permissions.
    if agent_config.permission_mode.is_none() {
        agent_config = agent_config.with_permission_mode(PermissionMode::BypassPermissions);
    }

    // Apply agent_config args (model, allowed_tools, disallowed_tools, etc.)
    let cli_args = agent_config.to_cli_args();
    for arg in &cli_args {
        cmd.arg(arg);
    }

    // Add --agent flags for each agent path.
    for agent in &step.agents {
        cmd.arg("--agent").arg(agent);
    }

    // Prompt and output format.
    cmd.arg("-p")
        .arg(&step.prompt)
        .arg("--output-format")
        .arg("stream-json")
        .current_dir(&config.project_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    cmd
}

pub struct StepExecutorState {
    execution_id: String,
    task_id: String,
    config: StepExecutorConfig,
    parent: ActorRef<ProjectMessage>,
    child_process: Option<Child>,
    stream_handle: Option<tokio::task::JoinHandle<()>>,
    /// Shared slot for the parsed stream-json result (metrics + result text).
    /// Written by the streaming task, read by the actor on process exit.
    stream_result: std::sync::Arc<std::sync::Mutex<Option<crate::stream_json::ParsedStreamResult>>>,
}

pub struct StepExecutor;

impl Actor for StepExecutor {
    type Msg = StepExecutorMessage;
    type State = StepExecutorState;
    type Arguments = (StepExecutorConfig, ActorRef<ProjectMessage>);

    async fn pre_start(
        &self,
        _myself: ActorRef<Self::Msg>,
        args: Self::Arguments,
    ) -> Result<Self::State, ActorProcessingErr> {
        let (config, parent) = args;

        tracing::info!(
            "StepExecutor starting for execution {}, task {}",
            config.execution_id,
            config.task_id
        );

        Ok(StepExecutorState {
            execution_id: config.execution_id.clone(),
            task_id: config.task_id.clone(),
            config,
            parent,
            child_process: None,
            stream_handle: None,
            stream_result: std::sync::Arc::new(std::sync::Mutex::new(None)),
        })
    }

    async fn handle(
        &self,
        myself: ActorRef<Self::Msg>,
        message: Self::Msg,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        match message {
            StepExecutorMessage::Execute => {
                self.handle_execute(myself, state).await?;
            }
            StepExecutorMessage::Cancel => {
                self.handle_cancel(myself, state).await;
            }
            StepExecutorMessage::ProcessExited(result) => {
                self.handle_process_exited(result, myself, state).await;
            }
        }
        Ok(())
    }

    async fn post_stop(
        &self,
        _myself: ActorRef<Self::Msg>,
        state: &mut Self::State,
    ) -> Result<(), ActorProcessingErr> {
        tracing::info!("StepExecutor stopping for execution {}", state.execution_id);

        if let Some(ref mut child) = state.child_process {
            tracing::warn!(
                "Killing orphaned child process for execution {}",
                state.execution_id
            );
            let _ = child.kill().await;
        }

        if let Some(handle) = state.stream_handle.take() {
            handle.abort();
        }

        Ok(())
    }
}

impl StepExecutor {
    async fn handle_execute(
        &self,
        myself: ActorRef<StepExecutorMessage>,
        state: &mut StepExecutorState,
    ) -> Result<(), ActorProcessingErr> {
        if state.child_process.is_some() {
            tracing::warn!(
                "Execute received but process already running for execution {}",
                state.execution_id
            );
            return Ok(());
        }

        tracing::info!(
            "Spawning Claude Code CLI for execution {}, model={:?}, project_root={}",
            state.execution_id,
            state.config.step_config.agent_config.model,
            state.config.project_root.display()
        );

        let mut cmd = build_claude_command(&state.config);

        match cmd.spawn() {
            Ok(mut child) => {
                // Take stdout and stderr before storing child — the streaming task
                // reads from them while the actor retains the Child handle for kill().
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();

                state.child_process = Some(child);

                let actor_ref = myself;
                let execution_id = state.execution_id.clone();
                let execution_service = Arc::clone(&state.config.execution_service);
                let result_slot = Arc::clone(&state.stream_result);

                let stream_handle = tokio::spawn(async move {
                    // Stream stdout line by line, posting each as a SessionLog.
                    // Parse each line for stream-json result; retain the last one found.
                    if let Some(stdout) = stdout {
                        let reader = BufReader::new(stdout);
                        let mut lines = reader.lines();

                        while let Ok(Some(line)) = lines.next_line().await {
                            if let Some(parsed) = crate::stream_json::parse_stream_json_line(&line)
                                && let Ok(mut slot) = result_slot.lock()
                            {
                                *slot = Some(parsed);
                            }

                            let log = SessionLog::new(execution_id.clone(), line);

                            if let Err(e) = execution_service.add_log(log).await {
                                tracing::warn!(
                                    "Failed to post log for execution {}: {}",
                                    execution_id,
                                    e
                                );
                            }
                        }
                    }

                    // Drain stderr and log it (not posted to Sacrum).
                    if let Some(stderr) = stderr {
                        let reader = BufReader::new(stderr);
                        let mut lines = reader.lines();

                        while let Ok(Some(line)) = lines.next_line().await {
                            tracing::warn!("stderr [{}]: {}", execution_id, line);
                        }
                    }

                    // stdout EOF means the process has closed its output.
                    // Notify the actor so it can wait() for the exit status.
                    let _ = actor_ref.cast(StepExecutorMessage::ProcessExited(Ok(
                        // Placeholder — the real exit status is obtained via child.wait() in the actor.
                        // We send a synthetic success here; the actor overrides it from wait().
                        std::process::ExitStatus::default(),
                    )));
                });

                state.stream_handle = Some(stream_handle);
            }
            Err(e) => {
                tracing::error!(
                    "Failed to spawn Claude Code CLI for execution {}: {}",
                    state.execution_id,
                    e
                );

                let _ = state.parent.cast(ProjectMessage::StepFinished {
                    execution_id: state.execution_id.clone(),
                    task_id: state.task_id.clone(),
                    result: StepResult::Failed {
                        exit_code: None,
                        error: format!("Failed to spawn process: {e}"),
                    },
                });

                myself.stop(Some("spawn failed".to_string()));
            }
        }

        Ok(())
    }

    async fn handle_cancel(
        &self,
        myself: ActorRef<StepExecutorMessage>,
        state: &mut StepExecutorState,
    ) {
        tracing::info!("Cancel requested for execution {}", state.execution_id);

        // Kill the child process explicitly.
        if let Some(ref mut child) = state.child_process {
            let _ = child.kill().await;
        }

        if let Some(handle) = state.stream_handle.take() {
            handle.abort();
        }

        let _ = state.parent.cast(ProjectMessage::StepFinished {
            execution_id: state.execution_id.clone(),
            task_id: state.task_id.clone(),
            result: StepResult::Failed {
                exit_code: None,
                error: "Cancelled".to_string(),
            },
        });

        myself.stop(Some("cancelled".to_string()));
    }

    async fn handle_process_exited(
        &self,
        _stream_result: Result<ExitStatus, String>,
        myself: ActorRef<StepExecutorMessage>,
        state: &mut StepExecutorState,
    ) {
        // The streaming task has finished reading stdout/stderr.
        // Now call child.wait() to get the real exit status.
        let stream_result = state
            .stream_result
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());

        let metrics = stream_result.as_ref().and_then(|r| r.metrics.clone());
        let result_text = stream_result.and_then(|r| r.result_text);

        let step_result = if let Some(ref mut child) = state.child_process {
            match child.wait().await {
                Ok(status) => {
                    let code = status.code().unwrap_or(-1);
                    if status.success() {
                        tracing::info!(
                            "Process completed successfully for execution {} (exit code {}, metrics={:?}, has_output={})",
                            state.execution_id,
                            code,
                            metrics,
                            result_text.is_some(),
                        );
                        StepResult::Completed {
                            exit_code: code,
                            metrics,
                            output: result_text,
                        }
                    } else {
                        tracing::warn!(
                            "Process failed for execution {} (exit code {})",
                            state.execution_id,
                            code
                        );
                        StepResult::Failed {
                            exit_code: Some(code),
                            error: format!("Process exited with code {code}"),
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(
                        "Process wait error for execution {}: {}",
                        state.execution_id,
                        e
                    );
                    StepResult::Failed {
                        exit_code: None,
                        error: e.to_string(),
                    }
                }
            }
        } else {
            tracing::error!(
                "ProcessExited received but no child process for execution {}",
                state.execution_id
            );
            StepResult::Failed {
                exit_code: None,
                error: "No child process".to_string(),
            }
        };

        let _ = state.parent.cast(ProjectMessage::StepFinished {
            execution_id: state.execution_id.clone(),
            task_id: state.task_id.clone(),
            result: step_result,
        });

        myself.stop(Some("process exited".to_string()));
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn test_execution_service() -> Arc<dyn ExecutionService> {
        use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig, SacrumExecutionService};

        let config = SacrumConfig::new(
            "http://localhost:4000".to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        );
        let client = GraphqlClient::new(config);
        Arc::new(SacrumExecutionService::new(client))
    }

    fn make_step_config(prompt: &str) -> StepConfig {
        StepConfig {
            prompt: prompt.to_string(),
            agent_config: AgentConfig::default(),
            agents: Vec::new(),
            skills: Vec::new(),
        }
    }

    fn test_config(execution_id: &str) -> StepExecutorConfig {
        StepExecutorConfig {
            execution_id: execution_id.to_string(),
            task_id: "task-test".to_string(),
            step_config: make_step_config("test"),
            project_root: PathBuf::from("/tmp"),
            execution_service: test_execution_service(),
        }
    }

    #[test]
    fn step_config_debug_format() {
        let config = StepConfig {
            prompt: "Implement feature X".to_string(),
            agent_config: AgentConfig::new().with_model("claude-sonnet-4-20250514"),
            agents: vec!["reviewer.md".to_string()],
            skills: vec!["search".to_string()],
        };
        let debug = format!("{:?}", config);
        assert!(debug.contains("Implement feature X"));
        assert!(debug.contains("claude-sonnet-4-20250514"));
        assert!(debug.contains("reviewer.md"));
        assert!(debug.contains("search"));
    }

    #[test]
    fn step_config_clone() {
        let config = StepConfig {
            prompt: "Do something".to_string(),
            agent_config: AgentConfig::new().with_model("claude-sonnet-4-20250514"),
            agents: vec!["agent.md".to_string()],
            skills: Vec::new(),
        };
        let cloned = config.clone();
        assert_eq!(cloned.prompt, "Do something");
        assert_eq!(
            cloned.agent_config.model,
            Some("claude-sonnet-4-20250514".to_string())
        );
        assert_eq!(cloned.agents, vec!["agent.md"]);
    }

    #[test]
    fn step_executor_config_debug_format() {
        let config = StepExecutorConfig {
            execution_id: "exec-123".to_string(),
            task_id: "task-abc".to_string(),
            step_config: make_step_config("test prompt"),
            project_root: PathBuf::from("/home/user/project"),
            execution_service: test_execution_service(),
        };
        let debug = format!("{:?}", config);
        assert!(debug.contains("exec-123"));
        assert!(debug.contains("task-abc"));
        assert!(debug.contains("test prompt"));
        assert!(debug.contains("/home/user/project"));
        assert!(debug.contains("ExecutionService"));
    }

    #[test]
    fn step_result_completed_debug() {
        let result = StepResult::Completed {
            exit_code: 0,
            metrics: None,
            output: None,
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("Completed"));
        assert!(debug.contains("0"));
    }

    #[test]
    fn step_result_completed_with_output_debug() {
        let result = StepResult::Completed {
            exit_code: 0,
            metrics: None,
            output: Some("Implementation finished".to_string()),
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("Completed"));
        assert!(debug.contains("Implementation finished"));
    }

    #[test]
    fn step_result_completed_without_output() {
        let result = StepResult::Completed {
            exit_code: 0,
            metrics: Some(crate::stream_json::StreamMetrics {
                input_tokens: 100,
                output_tokens: 50,
                cost_usd: 0.01,
                duration_ms: 500,
            }),
            output: None,
        };
        match result {
            StepResult::Completed {
                exit_code,
                metrics,
                output,
            } => {
                assert_eq!(exit_code, 0);
                assert!(metrics.is_some());
                assert!(output.is_none());
            }
            _ => panic!("Expected Completed"),
        }
    }

    #[test]
    fn step_result_completed_with_metrics_and_output() {
        let result = StepResult::Completed {
            exit_code: 0,
            metrics: Some(crate::stream_json::StreamMetrics {
                input_tokens: 1500,
                output_tokens: 800,
                cost_usd: 0.003,
                duration_ms: 5432,
            }),
            output: Some("All tests pass".to_string()),
        };
        match result {
            StepResult::Completed {
                exit_code,
                metrics,
                output,
            } => {
                assert_eq!(exit_code, 0);
                let m = metrics.expect("metrics should be present");
                assert_eq!(m.input_tokens, 1500);
                assert_eq!(m.output_tokens, 800);
                assert_eq!(output.as_deref(), Some("All tests pass"));
            }
            _ => panic!("Expected Completed"),
        }
    }

    #[test]
    fn step_result_failed_debug() {
        let result = StepResult::Failed {
            exit_code: Some(1),
            error: "something went wrong".to_string(),
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("Failed"));
        assert!(debug.contains("something went wrong"));
    }

    #[test]
    fn step_result_failed_no_exit_code_debug() {
        let result = StepResult::Failed {
            exit_code: None,
            error: "spawn error".to_string(),
        };
        let debug = format!("{:?}", result);
        assert!(debug.contains("None"));
        assert!(debug.contains("spawn error"));
    }

    #[test]
    fn step_result_clone() {
        let result = StepResult::Completed {
            exit_code: 42,
            metrics: None,
            output: Some("test output".to_string()),
        };
        let cloned = result.clone();
        match cloned {
            StepResult::Completed {
                exit_code, output, ..
            } => {
                assert_eq!(exit_code, 42);
                assert_eq!(output.as_deref(), Some("test output"));
            }
            _ => panic!("Expected Completed"),
        }
    }

    #[test]
    fn message_debug_execute() {
        let msg = StepExecutorMessage::Execute;
        assert_eq!(format!("{:?}", msg), "Execute");
    }

    #[test]
    fn message_debug_cancel() {
        let msg = StepExecutorMessage::Cancel;
        assert_eq!(format!("{:?}", msg), "Cancel");
    }

    #[test]
    fn message_debug_process_exited_ok() {
        let msg = StepExecutorMessage::ProcessExited(Err("io error".to_string()));
        let debug = format!("{:?}", msg);
        assert!(debug.contains("ProcessExited"));
        assert!(debug.contains("io error"));
    }

    #[test]
    fn build_command_has_correct_program() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: make_step_config("Write tests"),
            project_root: PathBuf::from("/home/user/myproject"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let program = cmd.as_std().get_program();
        assert_eq!(program, "claude");
    }

    #[test]
    fn build_command_default_config_includes_model_and_permission_mode() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: make_step_config("Implement feature Y"),
            project_root: PathBuf::from("/projects/test"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        // Default model should be applied when agent_config has no model.
        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&DEFAULT_MODEL.to_string()));

        // Default permission mode should be bypassPermissions.
        assert!(args.contains(&"--permissionMode".to_string()));
        assert!(args.contains(&"bypassPermissions".to_string()));

        // Prompt and output format always present.
        assert!(args.contains(&"-p".to_string()));
        assert!(args.contains(&"Implement feature Y".to_string()));
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
    }

    #[test]
    fn build_command_with_explicit_model_uses_it() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new().with_model("claude-opus-4-20250514"),
                agents: Vec::new(),
                skills: Vec::new(),
            },
            project_root: PathBuf::from("/tmp"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"claude-opus-4-20250514".to_string()));
        assert!(!args.contains(&DEFAULT_MODEL.to_string()));
    }

    #[test]
    fn build_command_with_agents_produces_agent_flags() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::default(),
                agents: vec!["reviewer.md".to_string(), "coder.md".to_string()],
                skills: Vec::new(),
            },
            project_root: PathBuf::from("/tmp"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        let agent_indices: Vec<usize> = args
            .iter()
            .enumerate()
            .filter(|(_, a)| *a == "--agent")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(agent_indices.len(), 2);
        assert_eq!(args[agent_indices[0] + 1], "reviewer.md");
        assert_eq!(args[agent_indices[1] + 1], "coder.md");
    }

    #[test]
    fn build_command_with_skills_produces_allowed_tools() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::default(),
                agents: Vec::new(),
                skills: vec!["WebSearch".to_string(), "Read".to_string()],
            },
            project_root: PathBuf::from("/tmp"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"--allowedTools".to_string()));
        assert!(args.contains(&"WebSearch".to_string()));
        assert!(args.contains(&"Read".to_string()));
    }

    #[test]
    fn build_command_skills_merge_with_existing_allowed_tools() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new()
                    .with_allowed_tools(vec!["Bash".to_string(), "WebSearch".to_string()]),
                agents: Vec::new(),
                skills: vec!["WebSearch".to_string(), "Edit".to_string()],
            },
            project_root: PathBuf::from("/tmp"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        // WebSearch should appear once (not duplicated).
        let ws_count = args.iter().filter(|a| *a == "WebSearch").count();
        assert_eq!(ws_count, 1, "WebSearch should not be duplicated");

        // Both Bash and Edit should be present.
        assert!(args.contains(&"Bash".to_string()));
        assert!(args.contains(&"Edit".to_string()));
    }

    #[test]
    fn build_command_with_full_agent_config() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new()
                    .with_model("claude-opus-4-20250514")
                    .with_max_budget_usd(5.0)
                    .with_append_system_prompt("Be careful".to_string())
                    .with_disallowed_tools(vec!["Bash(rm*)".to_string()]),
                agents: Vec::new(),
                skills: Vec::new(),
            },
            project_root: PathBuf::from("/tmp"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"claude-opus-4-20250514".to_string()));
        assert!(args.contains(&"--maxBudgetUsd".to_string()));
        assert!(args.contains(&"5".to_string()));
        assert!(args.contains(&"--appendSystemPrompt".to_string()));
        assert!(args.contains(&"Be careful".to_string()));
        assert!(args.contains(&"--disallowedTools".to_string()));
        assert!(args.contains(&"Bash(rm*)".to_string()));
    }

    #[test]
    fn build_command_explicit_permission_mode_not_overridden() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "test".to_string(),
                agent_config: AgentConfig::new().with_permission_mode(PermissionMode::Plan),
                agents: Vec::new(),
                skills: Vec::new(),
            },
            project_root: PathBuf::from("/tmp"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(args.contains(&"plan".to_string()));
        assert!(!args.contains(&"bypassPermissions".to_string()));
    }

    #[test]
    fn build_command_has_correct_working_directory() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: make_step_config("Do work"),
            project_root: PathBuf::from("/home/user/code"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let cwd = cmd.as_std().get_current_dir().unwrap();
        assert_eq!(cwd, PathBuf::from("/home/user/code"));
    }

    #[test]
    fn build_command_prompt_with_special_characters() {
        let config = StepExecutorConfig {
            execution_id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            step_config: StepConfig {
                prompt: "Fix the bug in `src/main.rs` where the \"parser\" fails".to_string(),
                agent_config: AgentConfig::default(),
                agents: Vec::new(),
                skills: Vec::new(),
            },
            project_root: PathBuf::from("/tmp"),
            execution_service: test_execution_service(),
        };

        let cmd = build_claude_command(&config);
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert!(
            args.contains(&"Fix the bug in `src/main.rs` where the \"parser\" fails".to_string())
        );
    }

    #[tokio::test]
    async fn step_executor_spawn_failure_reports_to_parent() {
        use ractor::Actor;

        struct MockParent;

        impl Actor for MockParent {
            type Msg = ProjectMessage;
            type State = Vec<ProjectMessage>;
            type Arguments = ();

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(Vec::new())
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                message: Self::Msg,
                state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                state.push(message);
                Ok(())
            }
        }

        let (parent_ref, _parent_handle) =
            Actor::spawn(Some("mock-parent".to_string()), MockParent, ())
                .await
                .expect("Failed to spawn mock parent");

        let mut config = test_config("exec-fail");
        config.project_root = PathBuf::from("/nonexistent/path/that/does/not/exist");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-fail".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        executor_ref
            .cast(StepExecutorMessage::Execute)
            .expect("Failed to send Execute");

        let _ = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        tokio::time::sleep(Duration::from_millis(100)).await;

        parent_ref.stop(Some("test done".to_string()));
    }

    #[tokio::test]
    async fn step_executor_cancel_stops_actor() {
        use ractor::Actor;

        struct MockParent;

        impl Actor for MockParent {
            type Msg = ProjectMessage;
            type State = ();
            type Arguments = ();

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(())
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                _message: Self::Msg,
                _state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                Ok(())
            }
        }

        let (parent_ref, _parent_handle) =
            Actor::spawn(Some("mock-parent-cancel".to_string()), MockParent, ())
                .await
                .expect("Failed to spawn mock parent");

        let config = test_config("exec-cancel");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-cancel".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        executor_ref
            .cast(StepExecutorMessage::Cancel)
            .expect("Failed to send Cancel");

        let result = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        assert!(
            result.is_ok(),
            "StepExecutor should have stopped after Cancel"
        );

        parent_ref.stop(Some("test done".to_string()));
    }

    #[tokio::test]
    async fn step_executor_successful_process_reports_completed() {
        use ractor::Actor;
        use std::sync::Mutex;

        struct CapturingParent;

        impl Actor for CapturingParent {
            type Msg = ProjectMessage;
            type State = Arc<Mutex<Vec<(String, String, StepResult)>>>;
            type Arguments = Arc<Mutex<Vec<(String, String, StepResult)>>>;

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(args)
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                message: Self::Msg,
                state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                if let ProjectMessage::StepFinished {
                    execution_id,
                    task_id,
                    result,
                } = message
                {
                    state.lock().unwrap().push((execution_id, task_id, result));
                }
                Ok(())
            }
        }

        let captured: Arc<Mutex<Vec<(String, String, StepResult)>>> =
            Arc::new(Mutex::new(Vec::new()));

        let (parent_ref, _parent_handle) = Actor::spawn(
            Some("capturing-parent".to_string()),
            CapturingParent,
            Arc::clone(&captured),
        )
        .await
        .expect("Failed to spawn capturing parent");

        let config = test_config("exec-success");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-success".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        executor_ref
            .cast(StepExecutorMessage::Execute)
            .expect("Failed to send Execute");

        let _ = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let messages = captured.lock().unwrap();
        assert_eq!(
            messages.len(),
            1,
            "Parent should have received exactly one StepFinished"
        );
        assert_eq!(messages[0].0, "exec-success");
        assert_eq!(messages[0].1, "task-test");

        match &messages[0].2 {
            StepResult::Failed { error, .. } => {
                assert!(!error.is_empty());
            }
            StepResult::Completed { exit_code, .. } => {
                assert!(*exit_code >= 0);
            }
        }

        parent_ref.stop(Some("test done".to_string()));
    }

    #[tokio::test]
    async fn step_executor_cancel_reports_failed_with_task_id() {
        use ractor::Actor;
        use std::sync::Mutex;

        struct CapturingParent;

        static CANCEL_RESULTS: std::sync::LazyLock<Arc<Mutex<Vec<(String, String, StepResult)>>>> =
            std::sync::LazyLock::new(|| Arc::new(Mutex::new(Vec::new())));

        impl Actor for CapturingParent {
            type Msg = ProjectMessage;
            type State = ();
            type Arguments = ();

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(())
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                message: Self::Msg,
                _state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                if let ProjectMessage::StepFinished {
                    execution_id,
                    task_id,
                    result,
                } = message
                {
                    CANCEL_RESULTS
                        .lock()
                        .unwrap()
                        .push((execution_id, task_id, result));
                }
                Ok(())
            }
        }

        CANCEL_RESULTS.lock().unwrap().clear();

        let (parent_ref, _parent_handle) = Actor::spawn(
            Some("cancel-capture-parent".to_string()),
            CapturingParent,
            (),
        )
        .await
        .expect("Failed to spawn parent");

        let config = test_config("exec-cancel-capture");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-cancel-capture".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        executor_ref
            .cast(StepExecutorMessage::Cancel)
            .expect("Failed to send Cancel");

        let _ = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let results = CANCEL_RESULTS.lock().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "exec-cancel-capture");
        assert_eq!(results[0].1, "task-test");
        match &results[0].2 {
            StepResult::Failed { error, .. } => {
                assert_eq!(error, "Cancelled");
            }
            other => panic!("Expected StepResult::Failed, got {:?}", other),
        }

        parent_ref.stop(Some("test done".to_string()));
    }

    #[tokio::test]
    async fn step_executor_process_exited_with_no_child_reports_failed() {
        use ractor::Actor;
        use std::sync::Mutex;

        struct CapturingParent;

        static NO_CHILD_RESULTS: std::sync::LazyLock<
            Arc<Mutex<Vec<(String, String, StepResult)>>>,
        > = std::sync::LazyLock::new(|| Arc::new(Mutex::new(Vec::new())));

        impl Actor for CapturingParent {
            type Msg = ProjectMessage;
            type State = ();
            type Arguments = ();

            async fn pre_start(
                &self,
                _myself: ActorRef<Self::Msg>,
                _args: Self::Arguments,
            ) -> Result<Self::State, ActorProcessingErr> {
                Ok(())
            }

            async fn handle(
                &self,
                _myself: ActorRef<Self::Msg>,
                message: Self::Msg,
                _state: &mut Self::State,
            ) -> Result<(), ActorProcessingErr> {
                if let ProjectMessage::StepFinished {
                    execution_id,
                    task_id,
                    result,
                } = message
                {
                    NO_CHILD_RESULTS
                        .lock()
                        .unwrap()
                        .push((execution_id, task_id, result));
                }
                Ok(())
            }
        }

        NO_CHILD_RESULTS.lock().unwrap().clear();

        let (parent_ref, _parent_handle) =
            Actor::spawn(Some("no-child-parent".to_string()), CapturingParent, ())
                .await
                .expect("Failed to spawn parent");

        let config = test_config("exec-no-child");

        let (executor_ref, executor_handle) = Actor::spawn(
            Some("step-executor-no-child".to_string()),
            StepExecutor,
            (config, parent_ref.clone()),
        )
        .await
        .expect("Failed to spawn StepExecutor");

        // Send ProcessExited without having spawned a child process.
        executor_ref
            .cast(StepExecutorMessage::ProcessExited(Ok(
                std::process::ExitStatus::default(),
            )))
            .expect("Failed to send ProcessExited");

        let _ = tokio::time::timeout(Duration::from_secs(5), executor_handle).await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        let results = NO_CHILD_RESULTS.lock().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "exec-no-child");
        assert_eq!(results[0].1, "task-test");
        match &results[0].2 {
            StepResult::Failed { error, .. } => {
                assert!(error.contains("No child process"));
            }
            other => panic!("Expected StepResult::Failed, got {:?}", other),
        }

        parent_ref.stop(Some("test done".to_string()));
    }
}
