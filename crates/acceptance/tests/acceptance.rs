use cucumber::{World, given, then, when};
use vertebrae_core::service::{CreateTaskOptions, TaskService};
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

#[derive(World)]
#[world(init = Self::new)]
pub struct SmokeWorld {
    client: Option<GraphqlClient>,
    project_id: Option<String>,
    task_id: Option<String>,
}

impl std::fmt::Debug for SmokeWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmokeWorld")
            .field("project_id", &self.project_id)
            .field("task_id", &self.task_id)
            .finish()
    }
}

impl SmokeWorld {
    fn new() -> Self {
        Self {
            client: None,
            project_id: None,
            task_id: None,
        }
    }

    fn task_service(&self) -> vertebrae_sacrum_client::SacrumTaskService {
        vertebrae_sacrum_client::SacrumTaskService::new(
            self.client.as_ref().expect("client not configured").clone(),
        )
    }
}

fn load_test_config() -> SacrumConfig {
    let base_url =
        std::env::var("SACRUM_URL").unwrap_or_else(|_| "http://localhost:4000".to_string());
    let api_token = std::env::var("SACRUM_API_TOKEN")
        .expect("SACRUM_API_TOKEN must be set for acceptance tests");
    let project_id = std::env::var("SACRUM_PROJECT_ID")
        .expect("SACRUM_PROJECT_ID must be set for acceptance tests");

    SacrumConfig::new(base_url, api_token, project_id)
}

#[given("a configured Sacrum client")]
async fn configured_client(world: &mut SmokeWorld) {
    let config = load_test_config();
    let project_id = config.project_id.clone();
    let client = GraphqlClient::new(config);
    world.client = Some(client);
    world.project_id = Some(project_id);
}

#[when(expr = "I create a task titled {string}")]
async fn create_task(world: &mut SmokeWorld, title: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task");
    world.task_id = Some(task_id);
}

#[then(expr = "the task should exist with title {string}")]
async fn task_exists_with_title(world: &mut SmokeWorld, expected_title: String) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    assert_eq!(
        task.title, expected_title,
        "task title mismatch: expected '{}', got '{}'",
        expected_title, task.title
    );
    assert_eq!(
        &task.id, task_id,
        "task ID mismatch: expected '{}', got '{}'",
        task_id, task.id
    );
}

#[when("I delete the task")]
async fn delete_task(world: &mut SmokeWorld) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    service
        .delete_task(task_id, false)
        .await
        .expect("failed to delete task");
}

#[then("the task should no longer exist")]
async fn task_does_not_exist(world: &mut SmokeWorld) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let result = service.get_task(task_id).await;

    assert!(
        result.is_err(),
        "expected task '{}' to not exist after deletion, but get_task succeeded",
        task_id
    );
}

#[tokio::main]
async fn main() {
    SmokeWorld::cucumber().run("tests/features").await;
}
