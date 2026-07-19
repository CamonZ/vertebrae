mod steps;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cucumber::World;
use tokio::process::{Child, Command};
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig, StepExecutionResponse};

#[derive(World)]
#[world(init = Self::new)]
pub struct DaemonWorld {
    pub vtb_binary: PathBuf,
    pub env: HashMap<String, String>,

    pub sacrum_url: String,
    pub sacrum_token: String,
    pub mock_output_dir: PathBuf,

    pub project_id: Option<String>,
    pub workflow_id: Option<String>,
    pub step_id: Option<String>,
    pub task_id: Option<String>,
    pub execution_id: Option<String>,

    pub created_task_ids: Vec<String>,
    pub created_workflow_ids: Vec<String>,
    pub created_project_ids: Vec<String>,

    // Parent/child orchestration scenario state.
    pub parent_workflow_id: Option<String>,
    pub child_workflow_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub intermediate_task_id: Option<String>,
    pub child_task_ids: Vec<String>,
    pub grandchild_task_ids: Vec<String>,

    pub last_stdout: String,
    pub last_stderr: String,
    pub last_exit_code: i32,

    pub last_execution: Option<StepExecutionResponse>,

    pub graphql_client: Option<Arc<GraphqlClient>>,

    pub feature_slug: String,
    pub scenario_slug: String,

    pub vtb_daemon_binary: PathBuf,
    pub daemon: Option<Child>,
    pub capture_dir: PathBuf,
    pub managed_plugin_root: Option<PathBuf>,
}

impl std::fmt::Debug for DaemonWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonWorld")
            .field("project_id", &self.project_id)
            .field("workflow_id", &self.workflow_id)
            .field("task_id", &self.task_id)
            .field("execution_id", &self.execution_id)
            .field("last_exit_code", &self.last_exit_code)
            .finish()
    }
}

impl DaemonWorld {
    fn new() -> Self {
        let sacrum_url =
            std::env::var("VTB_URL").unwrap_or_else(|_| "http://localhost:4000".to_string());
        let sacrum_token = std::env::var("VTB_TOKEN").unwrap_or_default();
        let mock_output_dir = PathBuf::from(
            std::env::var("MOCK_OUTPUT_DIR").unwrap_or_else(|_| "/mocks".to_string()),
        );
        let vtb_binary = PathBuf::from(
            std::env::var("VTB_BINARY").unwrap_or_else(|_| "/app/target/debug/vtb".to_string()),
        );
        let vtb_daemon_binary = PathBuf::from(
            std::env::var("VTB_DAEMON_BINARY")
                .unwrap_or_else(|_| "/app/target/debug/vtb-daemon".to_string()),
        );

        Self {
            vtb_binary,
            env: HashMap::new(),
            sacrum_url,
            sacrum_token,
            mock_output_dir,
            project_id: None,
            workflow_id: None,
            step_id: None,
            task_id: None,
            execution_id: None,
            created_task_ids: Vec::new(),
            created_workflow_ids: Vec::new(),
            created_project_ids: Vec::new(),
            parent_workflow_id: None,
            child_workflow_id: None,
            parent_task_id: None,
            intermediate_task_id: None,
            child_task_ids: Vec::new(),
            grandchild_task_ids: Vec::new(),
            last_stdout: String::new(),
            last_stderr: String::new(),
            last_exit_code: 0,
            last_execution: None,
            graphql_client: None,
            feature_slug: "feature".to_string(),
            scenario_slug: "scenario".to_string(),
            vtb_daemon_binary,
            daemon: None,
            capture_dir: PathBuf::from(format!(
                "/tmp/daemon-acc-cap-{}",
                uuid::Uuid::new_v4().simple()
            )),
            managed_plugin_root: None,
        }
    }

    /// Read the argv the mock was invoked with. Fails if the mock hasn't run yet.
    pub fn captured_argv(&self) -> Vec<String> {
        let path = self.capture_dir.join("argv.json");
        let body = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("no captured argv at {}: {e}", path.display()));
        serde_json::from_str(&body).expect("argv.json parses")
    }

    pub fn captured_cwd(&self) -> String {
        let path = self.capture_dir.join("cwd.txt");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("no captured cwd at {}: {e}", path.display()))
    }

    /// Read JSON-RPC requests captured by the mock Codex App Server.
    pub fn captured_codex_requests(&self) -> Vec<serde_json::Value> {
        let path = self.capture_dir.join("codex_requests.jsonl");
        let body = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("no captured Codex requests at {}: {e}", path.display()));
        body.lines()
            .map(|line| serde_json::from_str(line).expect("captured Codex request parses"))
            .collect()
    }

    /// Spawn `vtb-daemon` and wait for it to log `Joined channel for project <id>`.
    /// Uses a temp HOME so the daemon sees a scenario-specific config.toml.
    pub async fn start_daemon_for_project(&mut self, project_id: &str, project_path: &str) {
        assert!(self.daemon.is_none(), "daemon already running for scenario");

        let home = PathBuf::from(format!(
            "/tmp/daemon-acc-home-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let cfg_dir = home.join(".config").join("vertebrae");
        std::fs::create_dir_all(&cfg_dir).expect("create scenario home");
        let cfg = format!(
            "[sacrum]\nurl = \"{}\"\ntoken = \"{}\"\n\n[projects.\"test\"]\nid = \"{}\"\npath = \"{}\"\n",
            self.sacrum_url, self.sacrum_token, project_id, project_path,
        );
        std::fs::write(cfg_dir.join("config.toml"), cfg).expect("write config.toml");

        // The daemon acceptance container is Linux, where the installer-owned
        // manifestless Claude plugin root is `$HOME/.local/share/vertebrae`.
        let managed_plugin_root = home.join(".local/share/vertebrae");
        let installed_skill = managed_plugin_root.join("skills/acceptance-proof/SKILL.md");
        std::fs::create_dir_all(installed_skill.parent().expect("skill has parent"))
            .expect("create installed skill directory");
        std::fs::write(&installed_skill, "# Acceptance proof\n")
            .expect("write installed manifestless skill");
        self.managed_plugin_root = Some(managed_plugin_root);

        let log_path = PathBuf::from(format!("/tmp/daemon-acc-{project_id}.log"));
        let log_stderr = std::fs::File::create(&log_path).expect("create daemon debug log");
        let log_stderr_dup = log_stderr.try_clone().expect("dup log");

        let mut cmd = Command::new(&self.vtb_daemon_binary);
        cmd.env("HOME", &home)
            .env(
                "CLAUDE_CODE_PATH",
                std::env::var("CLAUDE_CODE_PATH").unwrap_or_default(),
            )
            .env(
                "CODEX_PATH",
                std::env::var("CODEX_PATH").unwrap_or_default(),
            )
            .env(
                "MOCK_OUTPUT_DIR",
                self.mock_output_dir.to_string_lossy().to_string(),
            )
            .env("MOCK_CAPTURE_DIR", &self.capture_dir)
            .env("RUST_LOG", "info")
            .stdout(Stdio::from(log_stderr_dup))
            .stderr(Stdio::from(log_stderr))
            .kill_on_drop(true);

        let mut child = cmd.spawn().expect("spawn vtb-daemon");

        let expected = format!("Joined channel for project {project_id}");

        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() >= deadline {
                let _ = child.kill().await;
                let tail = std::fs::read_to_string(&log_path).unwrap_or_default();
                panic!("daemon did not log {expected:?} within 30s. log:\n{tail}");
            }
            if let Ok(text) = std::fs::read_to_string(&log_path)
                && text.contains(&expected)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        self.daemon = Some(child);
    }

    pub async fn stop_daemon(&mut self) {
        if let Some(mut child) = self.daemon.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    pub async fn run_vtb(&mut self, args: &[&str]) {
        let output = Command::new(&self.vtb_binary)
            .args(args)
            .envs(&self.env)
            .output()
            .await
            .expect("failed to invoke vtb");
        self.last_stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        self.last_stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        self.last_exit_code = output.status.code().unwrap_or(-1);
    }

    pub async fn run_vtb_json(&mut self, args: &[&str]) -> Option<serde_json::Value> {
        let mut full = vec!["--json"];
        full.extend_from_slice(args);
        self.run_vtb(&full).await;
        if self.last_exit_code == 0 {
            serde_json::from_str(&self.last_stdout).ok()
        } else {
            None
        }
    }

    pub fn assert_vtb_ok(&self, context: &str) {
        assert_eq!(
            self.last_exit_code, 0,
            "{context} failed: stdout={} stderr={}",
            self.last_stdout, self.last_stderr
        );
    }

    /// Return the most recently inserted step_execution for `task_id`, or an
    /// error message if none is found or the query fails.
    pub async fn latest_execution_id(&self, task_id: &str) -> Result<String, String> {
        let client = self
            .graphql_client
            .as_ref()
            .ok_or("graphql_client not configured")?;
        let query = vertebrae_sacrum_client::client::with_fragments(
            vertebrae_sacrum_client::queries::executions::LIST_EXECUTIONS,
            &[vertebrae_sacrum_client::queries::executions::EXECUTION_FIELDS],
        );
        let resp: serde_json::Value = client
            .execute(
                &query,
                serde_json::json!({ "task_id": task_id }),
                "step_executions",
            )
            .await
            .map_err(|e| format!("list_executions failed: {e}"))?;
        let arr = resp
            .as_array()
            .ok_or_else(|| format!("step_executions response is not an array: {resp}"))?;
        let newest = arr
            .iter()
            .max_by_key(|e| e["inserted_at"].as_str().unwrap_or("").to_string())
            .ok_or_else(|| "no step_executions for task".to_string())?;
        newest["id"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("execution missing id: {newest}"))
    }

    pub fn mock_response(&self, step_label: &str) -> daemon_acceptance::MockResponse {
        daemon_acceptance::MockResponse::new(
            self.mock_output_dir.clone(),
            &self.feature_slug,
            &self.scenario_slug,
            step_label,
        )
    }

    /// Poll the `step_execution` GraphQL node for `execution_id` until its
    /// `status` matches one of `target_statuses` or `timeout` elapses.
    pub async fn poll_execution(
        &self,
        execution_id: &str,
        target_statuses: &[&str],
        timeout: Duration,
    ) -> Result<StepExecutionResponse, String> {
        let client = self
            .graphql_client
            .as_ref()
            .ok_or("graphql_client not configured")?
            .clone();

        let deadline = Instant::now() + timeout;
        let mut last_status = "unknown".to_string();
        let query = vertebrae_sacrum_client::client::with_fragments(
            vertebrae_sacrum_client::queries::executions::GET_EXECUTION,
            &[vertebrae_sacrum_client::queries::executions::EXECUTION_FIELDS],
        );

        while Instant::now() < deadline {
            let resp: Result<StepExecutionResponse, _> = client
                .execute(
                    &query,
                    serde_json::json!({ "id": execution_id }),
                    "step_execution",
                )
                .await;

            match resp {
                Ok(exec) => {
                    last_status = exec.status.clone();
                    if target_statuses
                        .iter()
                        .any(|t| t.eq_ignore_ascii_case(&last_status))
                    {
                        return Ok(exec);
                    }
                }
                Err(e) => {
                    last_status = format!("<query error: {e}>");
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        Err(format!(
            "timed out after {timeout:?} waiting for execution {execution_id} to reach {target_statuses:?} (last status: {last_status})"
        ))
    }
}

#[tokio::main]
async fn main() {
    DaemonWorld::cucumber()
        .before(|feature, _rule, scenario, world| {
            let feature_name = feature.name.clone();
            let scenario_name = scenario.name.clone();
            Box::pin(async move {
                world.feature_slug = slugify(&feature_name);
                world.scenario_slug = slugify(&scenario_name);
            })
        })
        .after(|_feature, _rule, _scenario, _ev, world| {
            Box::pin(async move {
                if let Some(world) = world {
                    cleanup(world).await;
                }
            })
        })
        .run_and_exit("tests/features")
        .await;
}

async fn cleanup(world: &mut DaemonWorld) {
    // Stop the daemon first so it can't hold DB locks while we delete tasks
    // and workflows underneath it.
    world.stop_daemon().await;
    let _ = std::fs::remove_dir_all(&world.capture_dir);

    let Some(client) = world.graphql_client.clone() else {
        return;
    };
    for id in world.created_task_ids.drain(..).rev() {
        let svc = vertebrae_sacrum_client::SacrumTaskService::new((*client).clone());
        let _ = vertebrae_core::service::TaskService::delete_task(&svc, &id, true).await;
    }
    for id in world.created_workflow_ids.drain(..).rev() {
        let svc = vertebrae_sacrum_client::SacrumWorkflowService::new((*client).clone());
        let _ = vertebrae_core::workflow_service::WorkflowService::delete_workflow(&svc, &id).await;
    }
    // Sacrum exposes no delete-project mutation in the client queries module;
    // projects survive until the test container is torn down — same pattern
    // as the existing CLI acceptance crate.
    world.created_project_ids.clear();
}

fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "scenario".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn graphql_client_for(
    sacrum_url: &str,
    sacrum_token: &str,
    project_id: &str,
) -> Arc<GraphqlClient> {
    Arc::new(GraphqlClient::new(SacrumConfig::new(
        sacrum_url.to_string(),
        sacrum_token.to_string(),
        project_id.to_string(),
    )))
}
