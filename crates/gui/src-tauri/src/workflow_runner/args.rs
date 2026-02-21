//! Pure functions for building CLI arguments
//!
//! Extracts argument-building logic from orchestrator.rs and executor.rs
//! into testable pure functions.

use std::path::PathBuf;
use vertebrae_core::{
    orchestrator_agent_config, orchestrator_prompt, AgentConfig, OrchestratorOutput,
    PermissionMode, Step,
};

use super::helpers::find_claude_binary;

/// Build arguments for the orchestrator (Phase 1) CLI invocation.
///
/// Returns `(claude_binary_path, args_vec)`.
pub fn build_orchestrator_args(
    step: &Step,
    task_id: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    let claude_path = find_claude_binary()?;
    let orchestrator_config = orchestrator_agent_config();

    let mut args = Vec::new();

    // Autonomous operation
    args.push("--dangerously-skip-permissions".to_string());

    // Orchestrator agent config args (model, json-schema)
    args.extend(orchestrator_config.to_cli_args());

    // Build the orchestrator prompt with task and step context
    let step_id = step.id.as_deref().unwrap_or_default();
    let prompt = orchestrator_prompt(task_id, step_id);

    args.push("-p".to_string());
    args.push(prompt);

    // Streaming JSON output
    args.push("--output-format".to_string());
    args.push("stream-json".to_string());

    Ok((claude_path, args))
}

/// Build arguments for the executor (Phase 2) CLI invocation.
///
/// Returns `(claude_binary_path, args_vec)`.
pub fn build_executor_args(
    step: &Step,
    orchestrator_output: &OrchestratorOutput,
) -> Result<(PathBuf, Vec<String>), String> {
    let claude_path = find_claude_binary()?;

    let mut args = Vec::new();

    // Use step's agent_config if non-empty, otherwise build from step's agents/skills
    let mut agent_config = if !step.agent_config.is_empty() {
        step.agent_config.clone()
    } else {
        let mut config = AgentConfig::new();
        if let Some(ref goal) = step.goal {
            config = config.with_append_system_prompt(format!(
                "Step goal: {}\n\nYou are working on step '{}' of the workflow.",
                goal, step.name
            ));
        }
        config
    };

    // Block executor from running workflow transition commands
    agent_config = agent_config.with_disallowed_tools(vec![
        "Bash(vtb workflow advance*)".to_string(),
        "Bash(vtb workflow retreat*)".to_string(),
        "Bash(vtb transition-to*)".to_string(),
    ]);

    // Add agent config args
    args.extend(agent_config.to_cli_args());

    // Add step's agent files as --agent arguments
    for agent_path in &step.agents {
        args.push("--agent".to_string());
        args.push(agent_path.clone());
    }

    // Add --permission-mode bypass for vtb read commands to work
    args.push("--permission-mode".to_string());
    args.push(PermissionMode::BypassPermissions.as_str().to_string());

    // Build the execution prompt from orchestrator output
    let execution_prompt = orchestrator_output.to_execution_prompt();

    // Augment with step goal to ensure executor sees required commands
    let execution_prompt = if let Some(ref goal) = step.goal {
        format!(
            r#"{execution_prompt}

---

## Step Requirements (from workflow definition)

{goal}

You MUST follow these requirements exactly. Use the specified commands - do NOT create markdown files or use alternative approaches."#
        )
    } else {
        execution_prompt
    };

    args.push("--print".to_string());
    args.push(execution_prompt);

    args.push("--output-format".to_string());
    args.push("stream-json".to_string());

    Ok((claude_path, args))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_runner::helpers::tests::with_claude_path;

    fn make_step(goal: Option<&str>) -> Step {
        let mut step = Step::new("test-step", "wf1");
        step.id = Some("step1".to_string());
        if let Some(g) = goal {
            step.goal = Some(g.to_string());
        }
        step
    }

    // --- Orchestrator args tests ---

    #[test]
    fn orchestrator_args_include_dangerously_skip_permissions() {
        with_claude_path(|| {
            let step = make_step(None);
            let (_, args) = build_orchestrator_args(&step, "task1").unwrap();
            assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        });
    }

    #[test]
    fn orchestrator_args_include_correct_prompt() {
        with_claude_path(|| {
            let step = make_step(None);
            let (_, args) = build_orchestrator_args(&step, "task1").unwrap();
            assert!(args.contains(&"-p".to_string()));
            // The prompt should contain task_id and step_id
            let p_idx = args.iter().position(|a| a == "-p").unwrap();
            let prompt = &args[p_idx + 1];
            assert!(prompt.contains("task1"));
            assert!(prompt.contains("step1"));
        });
    }

    #[test]
    fn orchestrator_args_include_stream_json() {
        with_claude_path(|| {
            let step = make_step(None);
            let (_, args) = build_orchestrator_args(&step, "task1").unwrap();
            assert!(args.contains(&"--output-format".to_string()));
            assert!(args.contains(&"stream-json".to_string()));
        });
    }

    #[test]
    fn orchestrator_args_include_model() {
        with_claude_path(|| {
            let step = make_step(None);
            let (_, args) = build_orchestrator_args(&step, "task1").unwrap();
            assert!(args.contains(&"--model".to_string()));
            assert!(args.contains(&"haiku".to_string()));
        });
    }

    // --- Executor args tests ---

    #[test]
    fn executor_args_include_disallowed_tools() {
        with_claude_path(|| {
            let step = make_step(None);
            let output = OrchestratorOutput::new("do the thing");
            let (_, args) = build_executor_args(&step, &output).unwrap();
            assert!(args.contains(&"--disallowedTools".to_string()));
            assert!(args.contains(&"Bash(vtb workflow advance*)".to_string()));
            assert!(args.contains(&"Bash(vtb workflow retreat*)".to_string()));
            assert!(args.contains(&"Bash(vtb transition-to*)".to_string()));
        });
    }

    #[test]
    fn executor_args_include_permission_mode() {
        with_claude_path(|| {
            let step = make_step(None);
            let output = OrchestratorOutput::new("do the thing");
            let (_, args) = build_executor_args(&step, &output).unwrap();
            assert!(args.contains(&"--permission-mode".to_string()));
            assert!(args.contains(&"bypassPermissions".to_string()));
        });
    }

    #[test]
    fn executor_args_include_step_goal_augmentation() {
        with_claude_path(|| {
            let step = make_step(Some("Must run vtb commands"));
            let output = OrchestratorOutput::new("do the thing");
            let (_, args) = build_executor_args(&step, &output).unwrap();
            let print_idx = args.iter().position(|a| a == "--print").unwrap();
            let prompt = &args[print_idx + 1];
            assert!(prompt.contains("Step Requirements"));
            assert!(prompt.contains("Must run vtb commands"));
        });
    }

    #[test]
    fn executor_args_omit_step_goal_when_absent() {
        with_claude_path(|| {
            let step = make_step(None);
            let output = OrchestratorOutput::new("do the thing");
            let (_, args) = build_executor_args(&step, &output).unwrap();
            let print_idx = args.iter().position(|a| a == "--print").unwrap();
            let prompt = &args[print_idx + 1];
            assert!(!prompt.contains("Step Requirements"));
        });
    }

    #[test]
    fn executor_args_include_agent_flags() {
        with_claude_path(|| {
            let mut step = make_step(None);
            step.agents = vec!["agent1.md".to_string(), "agent2.md".to_string()];
            let output = OrchestratorOutput::new("do the thing");
            let (_, args) = build_executor_args(&step, &output).unwrap();
            let agent_indices: Vec<usize> = args
                .iter()
                .enumerate()
                .filter(|(_, a)| *a == "--agent")
                .map(|(i, _)| i)
                .collect();
            assert_eq!(agent_indices.len(), 2);
            assert_eq!(args[agent_indices[0] + 1], "agent1.md");
            assert_eq!(args[agent_indices[1] + 1], "agent2.md");
        });
    }

    #[test]
    fn executor_args_include_stream_json() {
        with_claude_path(|| {
            let step = make_step(None);
            let output = OrchestratorOutput::new("do the thing");
            let (_, args) = build_executor_args(&step, &output).unwrap();
            assert!(args.contains(&"--output-format".to_string()));
            assert!(args.contains(&"stream-json".to_string()));
        });
    }
}
