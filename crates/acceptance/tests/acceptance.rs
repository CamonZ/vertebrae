mod steps;

use std::collections::HashMap;
use std::path::PathBuf;

use cucumber::World;
use vertebrae_sacrum_client::GraphqlClient;

#[derive(World)]
#[world(init = Self::new)]
pub struct SmokeWorld {
    vtb_binary: PathBuf,
    env: HashMap<String, String>,

    task_id: Option<String>,
    stored_ids: HashMap<String, String>,
    created_task_ids: Vec<String>,
    created_workflow_ids: Vec<String>,
    workflow_id: Option<String>,
    lifecycle_task_id: Option<String>,

    last_stdout: String,
    last_stderr: String,
    last_exit_code: i32,

    graphql_client: Option<GraphqlClient>,

    worktree: Option<WorktreeFixture>,
}

pub struct WorktreeFixture {
    pub _tmp: tempfile::TempDir,
    pub home: PathBuf,
    pub main_repo: PathBuf,
    pub worktree_path: PathBuf,
}

impl std::fmt::Debug for SmokeWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmokeWorld")
            .field("task_id", &self.task_id)
            .field("stored_ids", &self.stored_ids)
            .field("workflow_id", &self.workflow_id)
            .field("last_exit_code", &self.last_exit_code)
            .finish()
    }
}

impl SmokeWorld {
    fn new() -> Self {
        Self {
            vtb_binary: PathBuf::new(),
            env: HashMap::new(),
            task_id: None,
            stored_ids: HashMap::new(),
            created_task_ids: Vec::new(),
            created_workflow_ids: Vec::new(),
            workflow_id: None,
            lifecycle_task_id: None,
            last_stdout: String::new(),
            last_stderr: String::new(),
            last_exit_code: 0,
            graphql_client: None,
            worktree: None,
        }
    }

    async fn run_vtb_in(
        &mut self,
        cwd: &std::path::Path,
        env_overrides: &[(&str, Option<&str>)],
        args: &[&str],
    ) {
        let resolved_args: Vec<String> = args.iter().map(|a| self.resolve_vars(a)).collect();
        let mut cmd = tokio::process::Command::new(&self.vtb_binary);
        cmd.args(&resolved_args).envs(&self.env).current_dir(cwd);
        for (k, v) in env_overrides {
            match v {
                Some(val) => {
                    cmd.env(k, val);
                }
                None => {
                    cmd.env_remove(k);
                }
            }
        }
        let output = cmd.output().await.expect("failed to execute vtb");
        self.last_stdout = String::from_utf8_lossy(&output.stdout).to_string();
        self.last_stderr = String::from_utf8_lossy(&output.stderr).to_string();
        self.last_exit_code = output.status.code().unwrap_or(-1);
    }

    async fn run_vtb(&mut self, args: &[&str]) {
        let resolved_args: Vec<String> = args.iter().map(|a| self.resolve_vars(a)).collect();

        let output = tokio::process::Command::new(&self.vtb_binary)
            .args(&resolved_args)
            .envs(&self.env)
            .output()
            .await
            .expect("failed to execute vtb");

        self.last_stdout = String::from_utf8_lossy(&output.stdout).to_string();
        self.last_stderr = String::from_utf8_lossy(&output.stderr).to_string();
        self.last_exit_code = output.status.code().unwrap_or(-1);
    }

    async fn run_vtb_json(&mut self, args: &[&str]) -> Option<serde_json::Value> {
        let mut full_args = vec!["--json"];
        full_args.extend_from_slice(args);
        self.run_vtb(&full_args).await;
        if self.last_exit_code == 0 {
            serde_json::from_str(&self.last_stdout).ok()
        } else {
            None
        }
    }

    fn resolve_vars(&self, text: &str) -> String {
        let mut result = text.to_string();
        if let Some(task_id) = &self.task_id {
            result = result.replace("<TASK_ID>", task_id);
        }
        for (key, value) in &self.stored_ids {
            result = result.replace(&format!("<{}>", key), value);
        }
        result
    }

    fn extract_task_id_from_output(&self) -> Option<String> {
        let stdout = self.last_stdout.trim();
        // vtb add outputs "Created task: <uuid>"
        if let Some(rest) = stdout.strip_prefix("Created task: ") {
            let uuid = rest.trim();
            if !uuid.is_empty() {
                return Some(uuid.to_string());
            }
        }
        // JSON mode: {"command":"add","status":"created","task_id":"<uuid>"}
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout) {
            if let Some(task_id) = json.get("task_id").and_then(|v| v.as_str()) {
                if !task_id.is_empty() {
                    return Some(task_id.to_string());
                }
            }
        }
        None
    }

    fn track_task(&mut self, id: String) {
        self.task_id = Some(id.clone());
        self.created_task_ids.push(id);
    }

    fn track_workflow(&mut self, id: String) {
        self.workflow_id = Some(id.clone());
        self.created_workflow_ids.push(id);
    }

    fn combined_output(&self) -> String {
        format!("{}{}", self.last_stdout, self.last_stderr)
    }
}

#[tokio::main]
async fn main() {
    SmokeWorld::cucumber()
        .before(|_feature, _rule, _scenario, _world| Box::pin(async move {}))
        .after(|_feature, _rule, _scenario, _ev, world| {
            Box::pin(async move {
                if let Some(world) = world {
                    // Cleanup created tasks in reverse order
                    if let Some(client) = &world.graphql_client {
                        let task_service =
                            vertebrae_sacrum_client::SacrumTaskService::new(client.clone());
                        for task_id in world.created_task_ids.iter().rev() {
                            let _ = vertebrae_core::service::TaskService::delete_task(
                                &task_service,
                                task_id,
                                true,
                            )
                            .await;
                        }
                        let wf_service =
                            vertebrae_sacrum_client::SacrumWorkflowService::new(client.clone());
                        for wf_id in world.created_workflow_ids.iter().rev() {
                            let _ =
                                vertebrae_core::workflow_service::WorkflowService::delete_workflow(
                                    &wf_service,
                                    wf_id,
                                )
                                .await;
                        }
                    }
                }
            })
        })
        .run_and_exit("tests/features")
        .await;
}
