mod steps;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cucumber::World;
use cucumber::writer::Stats;
use fantoccini::Client;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use vertebrae_sacrum_client::GraphqlClient;

#[derive(World)]
#[world(init = Self::new)]
pub struct GuiWorld {
    /// Shared WebDriver session (persists across scenarios).
    webdriver: Option<Arc<Mutex<Client>>>,

    /// GraphQL client for Sacrum — used to create/cleanup test projects.
    graphql_client: Option<GraphqlClient>,

    /// The project slug registered for this scenario (unique per run).
    project_slug: Option<String>,

    /// Sacrum project ID returned after creation.
    project_id: Option<String>,

    /// Temporary directory used as the project path in config.toml.
    temp_dir: Option<PathBuf>,

    /// Path to the vtb binary used for CLI mutations.
    vtb_binary: PathBuf,

    /// Environment variables passed to vtb CLI commands.
    env: HashMap<String, String>,

    /// The most recently created/referenced task ID.
    task_id: Option<String>,

    /// All task IDs created during this scenario (for cleanup).
    created_task_ids: Vec<String>,

    /// The most recently created workflow ID.
    workflow_id: Option<String>,

    /// All workflow IDs created during this scenario (for cleanup).
    created_workflow_ids: Vec<String>,

    /// Map from workflow name to workflow ID for named lookups.
    workflow_ids_by_name: HashMap<String, String>,

    /// The most recently created step ID.
    pub step_id: Option<String>,

    /// All step IDs created during this scenario.
    created_step_ids: Vec<String>,

    /// Last CLI stdout output.
    last_stdout: String,

    /// Last CLI stderr output.
    last_stderr: String,

    /// Last CLI exit code.
    last_exit_code: i32,

    /// Scenario name, used as the screenshot subdirectory.
    pub scenario_name: String,

    /// Per-scenario screenshot sequence counter for ordered filenames.
    screenshot_seq: u32,

    /// Running vtb-daemon process for the current scenario, if any.
    pub daemon: Option<Child>,

    /// Slugified feature name, used to namespace mock fixtures.
    pub feature_slug: String,

    /// Slugified scenario name, used to namespace mock fixtures.
    pub scenario_slug: String,

    /// Output dir for mock-claude fixtures (matches MOCK_OUTPUT_DIR env).
    pub mock_output_dir: PathBuf,
}

impl std::fmt::Debug for GuiWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuiWorld")
            .field("project_slug", &self.project_slug)
            .field("project_id", &self.project_id)
            .field("temp_dir", &self.temp_dir)
            .field("task_id", &self.task_id)
            .field("last_exit_code", &self.last_exit_code)
            .finish()
    }
}

impl GuiWorld {
    fn new() -> Self {
        Self {
            webdriver: None,
            graphql_client: None,
            project_slug: None,
            project_id: None,
            temp_dir: None,
            vtb_binary: PathBuf::new(),
            env: HashMap::new(),
            task_id: None,
            created_task_ids: Vec::new(),
            workflow_id: None,
            created_workflow_ids: Vec::new(),
            workflow_ids_by_name: HashMap::new(),
            step_id: None,
            created_step_ids: Vec::new(),
            last_stdout: String::new(),
            last_stderr: String::new(),
            last_exit_code: 0,
            scenario_name: String::new(),
            screenshot_seq: 0,
            daemon: None,
            feature_slug: String::new(),
            scenario_slug: String::new(),
            mock_output_dir: PathBuf::from(
                std::env::var("MOCK_OUTPUT_DIR").unwrap_or_else(|_| "/mocks".to_string()),
            ),
        }
    }

    pub fn mock_response(&self, step_label: &str) -> daemon_acceptance::MockResponse {
        daemon_acceptance::MockResponse::new(
            self.mock_output_dir.clone(),
            &self.feature_slug,
            &self.scenario_slug,
            step_label,
        )
    }

    /// Spawn vtb-daemon for the project this scenario configured, sharing
    /// HOME=/root with the GUI (the setup hook registers the project there).
    /// Blocks until the daemon logs that it joined the Phoenix channel.
    pub async fn start_daemon(&mut self) {
        assert!(self.daemon.is_none(), "daemon already running");
        let project_id = self
            .project_id
            .as_ref()
            .expect("project_id not set — setup hook must run first")
            .clone();

        let daemon_binary = std::env::var("VTB_DAEMON_BINARY")
            .unwrap_or_else(|_| "/app/target/debug/vtb-daemon".to_string());
        let claude_path = std::env::var("CLAUDE_CODE_PATH")
            .unwrap_or_else(|_| "/usr/local/bin/mock-claude".to_string());
        let mock_dir = self.mock_output_dir.clone();
        let log_path = PathBuf::from(format!("/tmp/gui-acc-daemon-{project_id}.log"));
        let log = std::fs::File::create(&log_path).expect("create daemon log");
        let log_dup = log.try_clone().expect("dup daemon log");

        let mut cmd = Command::new(&daemon_binary);
        cmd.env("HOME", "/root")
            .env("CLAUDE_CODE_PATH", claude_path)
            .env("MOCK_OUTPUT_DIR", &mock_dir)
            .env("RUST_LOG", "info")
            .stdout(Stdio::from(log_dup))
            .stderr(Stdio::from(log))
            .kill_on_drop(true);

        let child = cmd.spawn().expect("spawn vtb-daemon");
        self.daemon = Some(child);

        let expected = format!("Joined channel for project {project_id}");
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() >= deadline {
                let tail = std::fs::read_to_string(&log_path).unwrap_or_default();
                self.stop_daemon().await;
                panic!("daemon did not log {expected:?} within 30s. log:\n{tail}");
            }
            if let Ok(text) = std::fs::read_to_string(&log_path)
                && text.contains(&expected)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn stop_daemon(&mut self) {
        if let Some(mut child) = self.daemon.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    fn next_seq(&mut self) -> u32 {
        self.screenshot_seq += 1;
        self.screenshot_seq
    }

    /// Take a sequenced screenshot in the current scenario's output directory.
    async fn screenshot(&mut self, client: &Client, label: &str) {
        let seq = self.next_seq();
        gui_acceptance::screenshot(client, &self.scenario_name, seq, label).await;
    }

    /// Execute a vtb CLI command and capture its output.
    async fn run_vtb(&mut self, args: &[&str]) {
        let output = tokio::process::Command::new(&self.vtb_binary)
            .args(args)
            .envs(&self.env)
            .output()
            .await
            .expect("failed to execute vtb");

        self.last_stdout = String::from_utf8_lossy(&output.stdout).to_string();
        self.last_stderr = String::from_utf8_lossy(&output.stderr).to_string();
        self.last_exit_code = output.status.code().unwrap_or(-1);
    }

    /// Extract a task ID from vtb add output ("Created task: <uuid>").
    fn extract_task_id_from_output(&self) -> Option<String> {
        let stdout = self.last_stdout.trim();
        if let Some(rest) = stdout.strip_prefix("Created task: ") {
            let uuid = rest.trim();
            if !uuid.is_empty() {
                return Some(uuid.to_string());
            }
        }
        None
    }

    /// Track a newly created task for cleanup.
    fn track_task(&mut self, id: String) {
        self.task_id = Some(id.clone());
        self.created_task_ids.push(id);
    }

    /// Extract a workflow ID from vtb workflow add output ("Created workflow: <uuid>").
    fn extract_workflow_id_from_output(&self) -> Option<String> {
        let stdout = self.last_stdout.trim();
        if let Some(rest) = stdout.strip_prefix("Created workflow: ") {
            let uuid = rest.trim();
            if !uuid.is_empty() {
                return Some(uuid.to_string());
            }
        }
        None
    }

    /// Track a newly created workflow for cleanup.
    fn track_workflow(&mut self, id: String, name: Option<String>) {
        self.workflow_id = Some(id.clone());
        self.created_workflow_ids.push(id.clone());
        if let Some(n) = name {
            self.workflow_ids_by_name.insert(n, id);
        }
    }

    /// Look up a workflow ID by name.
    pub fn workflow_id_by_name(&self, name: &str) -> Option<&String> {
        self.workflow_ids_by_name.get(name)
    }

    /// Extract a step ID from vtb step add output ("Created step: <uuid>").
    fn extract_step_id_from_output(&self) -> Option<String> {
        let stdout = self.last_stdout.trim();
        if let Some(rest) = stdout.strip_prefix("Created step: ") {
            let uuid = rest.trim();
            if !uuid.is_empty() {
                return Some(uuid.to_string());
            }
        }
        None
    }

    /// Track a newly created step for reference.
    pub fn track_step(&mut self, id: String) {
        self.step_id = Some(id.clone());
        self.created_step_ids.push(id);
    }
}

#[tokio::main]
async fn main() {
    let summary = GuiWorld::cucumber()
        .max_concurrent_scenarios(Some(1))
        .before(|feature, _rule, scenario, world| {
            let scenario_name = scenario.name.clone();
            let feature_name = feature.name.clone();
            // `@first_run` may live on either the scenario or the feature.
            let first_run = is_first_run(feature, scenario);
            Box::pin(async move {
                world.feature_slug = slugify(&feature_name);
                world.scenario_slug = slugify(&scenario_name);
                steps::setup::before_scenario(world, &scenario_name, first_run).await;
            })
        })
        .after(|feature, _rule, scenario, ev, world| {
            let first_run = is_first_run(feature, scenario);
            let prefix = match ev {
                cucumber::event::ScenarioFinished::StepFailed(..)
                | cucumber::event::ScenarioFinished::BeforeHookFailed(..) => "F",
                _ => "S",
            };
            let scenario_name = world
                .as_ref()
                .map(|w| w.scenario_name.clone())
                .unwrap_or_default();
            Box::pin(async move {
                // Rename the screenshot folder to include the outcome prefix.
                let safe_name = gui_acceptance::sanitize_name(&scenario_name);
                if !safe_name.is_empty() {
                    let src = format!("/app/test-output/{safe_name}");
                    let dst = format!("/app/test-output/{prefix} - {safe_name}");
                    // Remove stale destination from a previous run so rename succeeds.
                    let _ = std::fs::remove_dir_all(&dst);
                    // Also remove the opposite-prefix folder so stale F→S flips are cleaned.
                    let other = if prefix == "S" { "F" } else { "S" };
                    let _ =
                        std::fs::remove_dir_all(format!("/app/test-output/{other} - {safe_name}"));
                    let _ = std::fs::rename(&src, &dst);
                }

                if let Some(world) = world {
                    // Stop the daemon first so it can't hold DB locks while we
                    // delete the workflows/tasks underneath it.
                    world.stop_daemon().await;
                    // Clean up tasks created during the scenario
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

                        // Clean up workflows created during the scenario
                        let workflow_service =
                            vertebrae_sacrum_client::SacrumWorkflowService::new(client.clone());
                        for workflow_id in world.created_workflow_ids.iter().rev() {
                            let _ =
                                vertebrae_core::workflow_service::WorkflowService::delete_workflow(
                                    &workflow_service,
                                    workflow_id,
                                )
                                .await;
                        }
                    }
                    steps::setup::after_scenario(world, first_run).await;
                }
            })
        })
        .run("tests/features")
        .await;

    gui_acceptance::close_webdriver().await;

    if summary.execution_has_failed() {
        std::process::exit(1);
    }
}

/// `true` when the scenario (or its feature) carries the `@first_run` tag.
/// cucumber-rs strips the leading `@`, so we match the bare `first_run`.
/// First-run scenarios skip the project-selection setup and instead exercise
/// the install welcome screen, so the before/after hooks branch on this.
fn is_first_run(
    feature: &cucumber::gherkin::Feature,
    scenario: &cucumber::gherkin::Scenario,
) -> bool {
    const TAG: &str = "first_run";
    scenario.tags.iter().any(|t| t == TAG) || feature.tags.iter().any(|t| t == TAG)
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
