mod steps;

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::time::{Duration, Instant, sleep};

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
    created_artifact_ids: Vec<String>,
    created_project_ids: Vec<String>,
    workflow_id: Option<String>,
    lifecycle_task_id: Option<String>,

    temp_files: Vec<tempfile::NamedTempFile>,

    last_stdout: String,
    last_stderr: String,
    last_exit_code: i32,

    graphql_client: Option<GraphqlClient>,

    worktree: Option<WorktreeFixture>,

    daemon: Option<Child>,
    daemon_id: Option<String>,
    daemon_home: Option<PathBuf>,
    daemon_project_path: Option<PathBuf>,
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
            created_artifact_ids: Vec::new(),
            created_project_ids: Vec::new(),
            workflow_id: None,
            lifecycle_task_id: None,
            temp_files: Vec::new(),
            last_stdout: String::new(),
            last_stderr: String::new(),
            last_exit_code: 0,
            graphql_client: None,
            worktree: None,
            daemon: None,
            daemon_id: None,
            daemon_home: None,
            daemon_project_path: None,
        }
    }

    async fn start_daemon(&mut self, project_id: &str) {
        let url = self.env.get("VTB_URL").expect("VTB_URL must be set");
        let daemon_id = uuid::Uuid::new_v4().simple().to_string();
        let home = PathBuf::from(format!("/tmp/vtb-acceptance-daemon-home-{daemon_id}"));
        let config_dir = home.join(".config/vertebrae");
        let project_path = PathBuf::from(format!("/tmp/vtb-acceptance-project-{daemon_id}"));
        std::fs::create_dir_all(&config_dir).expect("create daemon config directory");
        std::fs::create_dir_all(&project_path).expect("create daemon project directory");
        let client = self
            .graphql_client
            .as_ref()
            .expect("configured Sacrum client")
            .clone();
        let bootstrap = vertebrae_sacrum_client::SacrumDaemonService::new(client)
            .create_daemon(Some(&format!("acceptance-{daemon_id}")))
            .await
            .expect("create daemon enrollment");
        let daemon_id = bootstrap.daemon.id.clone();
        std::fs::write(
            config_dir.join("config.toml"),
            format!(
                "[sacrum]\nurl = \"{url}\"\n\n[projects.acceptance]\nid = \"{project_id}\"\npath = \"{}\"\n",
                project_path.display()
            ),
        )
        .expect("write daemon config");

        let daemon_binary = std::env::var("VTB_DAEMON_BINARY")
            .unwrap_or_else(|_| "/app/target/debug/vtb-daemon".to_string());
        let log_path = PathBuf::from(format!("/tmp/vtb-acceptance-daemon-{daemon_id}.log"));
        let mut command = tokio::process::Command::new(daemon_binary);
        command
            .args([
                "enroll",
                "--endpoint",
                url,
                "--daemon-id",
                &daemon_id,
                "--token-stdin",
            ])
            .env("HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut enroll = command.spawn().expect("spawn daemon enrollment");
        enroll
            .stdin
            .take()
            .expect("daemon enrollment stdin")
            .write_all(bootstrap.enrollment_token.as_bytes())
            .await
            .expect("write daemon enrollment token");
        let output = enroll
            .wait_with_output()
            .await
            .expect("wait for daemon enrollment");
        assert!(
            output.status.success(),
            "daemon enrollment failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let log = std::fs::File::create(&log_path).expect("create daemon log");
        let log_dup = log.try_clone().expect("duplicate daemon log");
        let mut command = tokio::process::Command::new(
            std::env::var("VTB_DAEMON_BINARY")
                .unwrap_or_else(|_| "/app/target/debug/vtb-daemon".to_string()),
        );
        command
            .env("HOME", &home)
            .env(
                "CLAUDE_CODE_PATH",
                std::env::var("CLAUDE_CODE_PATH")
                    .unwrap_or_else(|_| "/usr/local/bin/mock-claude".to_string()),
            )
            .env("RUST_LOG", "info")
            .stdout(Stdio::from(log_dup))
            .stderr(Stdio::from(log))
            .kill_on_drop(true);
        self.daemon = Some(command.spawn().expect("spawn acceptance daemon"));
        self.daemon_id = Some(daemon_id);
        self.daemon_home = Some(home);
        self.daemon_project_path = Some(project_path);

        let expected = "Standalone daemon identity registered";
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() >= deadline {
                let log = std::fs::read_to_string(&log_path).unwrap_or_default();
                self.stop_daemon().await;
                panic!("daemon did not log {expected:?} within 30s. log:\n{log}");
            }
            if let Ok(log) = std::fs::read_to_string(&log_path)
                && log.contains(&expected)
            {
                return;
            }
            sleep(Duration::from_millis(100)).await;
        }
    }

    async fn stop_daemon(&mut self) {
        if let Some(mut daemon) = self.daemon.take() {
            let _ = daemon.kill().await;
            let _ = daemon.wait().await;
        }
        if let Some(daemon_id) = self.daemon_id.take()
            && let Some(client) = &self.graphql_client
        {
            let _ = vertebrae_sacrum_client::SacrumDaemonService::new(client.clone())
                .unregister_daemon(&daemon_id)
                .await;
        }
        if let Some(home) = self.daemon_home.take() {
            let _ = std::fs::remove_dir_all(home);
        }
        if let Some(project_path) = self.daemon_project_path.take() {
            let _ = std::fs::remove_dir_all(project_path);
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

    async fn run_vtb_with_stdin(&mut self, args: &[&str], stdin: &str) {
        let resolved_args: Vec<String> = args.iter().map(|a| self.resolve_vars(a)).collect();
        let mut child = tokio::process::Command::new(&self.vtb_binary)
            .args(&resolved_args)
            .envs(&self.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to execute vtb");

        let mut child_stdin = child.stdin.take().expect("vtb stdin should be piped");
        tokio::io::AsyncWriteExt::write_all(&mut child_stdin, stdin.as_bytes())
            .await
            .expect("failed to write vtb stdin");
        drop(child_stdin);

        let output = child
            .wait_with_output()
            .await
            .expect("failed to collect vtb output");
        self.last_stdout = String::from_utf8_lossy(&output.stdout).to_string();
        self.last_stderr = String::from_utf8_lossy(&output.stderr).to_string();
        self.last_exit_code = output.status.code().unwrap_or(-1);
    }

    fn write_temp_file(&mut self, contents: &str) -> PathBuf {
        let mut file = tempfile::NamedTempFile::new().expect("failed to create temp artifact body");
        file.write_all(contents.as_bytes())
            .expect("failed to write temp artifact body");
        let path = file.path().to_path_buf();
        self.temp_files.push(file);
        path
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
        self.stored_ids
            .insert("workflow_id".to_string(), id.clone());
        self.created_workflow_ids.push(id);
    }

    fn extract_artifact_id_from_output(&self) -> Option<String> {
        let stdout = self.last_stdout.trim();
        if let Some(rest) = stdout.strip_prefix("Created artifact: ") {
            let id = rest.trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout) {
            if let Some(id) = json.get("artifact_id").and_then(|value| value.as_str()) {
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
            if let Some(id) = json
                .get("artifact")
                .and_then(|artifact| artifact.get("id"))
                .and_then(|value| value.as_str())
            {
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
        None
    }

    fn track_artifact(&mut self, id: String) {
        self.created_artifact_ids.push(id);
    }

    fn track_project(&mut self, id: String) {
        self.created_project_ids.push(id);
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
                    world.stop_daemon().await;
                    // Cleanup created artifacts before their attached tasks/projects.
                    if let Some(client) = &world.graphql_client {
                        let artifact_service =
                            vertebrae_sacrum_client::SacrumArtifactService::new(client.clone());
                        for artifact_id in world.created_artifact_ids.iter().rev() {
                            let _ =
                                vertebrae_core::artifact_service::ArtifactService::delete_artifact(
                                    &artifact_service,
                                    artifact_id,
                                )
                                .await;
                        }
                    }

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
                        const DELETE_PROJECT: &str = r#"
                            mutation DeleteAcceptanceProject($id: Uuid4!) {
                                deleteProject(id: $id) { id }
                            }
                        "#;
                        for project_id in world.created_project_ids.iter().rev() {
                            let _: Result<serde_json::Value, _> = client
                                .execute(
                                    DELETE_PROJECT,
                                    serde_json::json!({ "id": project_id }),
                                    "delete_project",
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
