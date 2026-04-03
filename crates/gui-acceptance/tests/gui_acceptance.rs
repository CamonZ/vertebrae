mod steps;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use cucumber::World;
use fantoccini::Client;
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
        }
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
    GuiWorld::cucumber()
        .max_concurrent_scenarios(Some(1))
        .before(|_feature, _rule, scenario, world| {
            let scenario_name = scenario.name.clone();
            Box::pin(async move {
                steps::setup::before_scenario(world, &scenario_name).await;
            })
        })
        .after(|_feature, _rule, _scenario, ev, world| {
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
                    steps::setup::after_scenario(world).await;
                }
            })
        })
        .run("tests/features")
        .await;

    gui_acceptance::close_webdriver().await;
}
