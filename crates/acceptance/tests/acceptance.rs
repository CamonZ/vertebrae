use std::collections::HashMap;

use cucumber::{World, given, then, when};
use regex::Regex;
use vertebrae_core::error::ServiceError;
use vertebrae_core::models::{Level, Priority, SectionType};
use vertebrae_core::service::{CreateTaskOptions, TaskService};
use vertebrae_sacrum_client::{GraphqlClient, SacrumConfig};

fn parse_level(s: &str) -> Level {
    match s {
        "epic" => Level::Epic,
        "ticket" => Level::Ticket,
        "task" => Level::Task,
        other => panic!("unsupported level: '{}'", other),
    }
}

fn parse_priority(s: &str) -> Priority {
    match s {
        "low" => Priority::Low,
        "medium" => Priority::Medium,
        "high" => Priority::High,
        "critical" => Priority::Critical,
        other => panic!("unsupported priority: '{}'", other),
    }
}

#[derive(World)]
#[world(init = Self::new)]
pub struct SmokeWorld {
    client: Option<GraphqlClient>,
    project_id: Option<String>,
    task_id: Option<String>,
    created_task_ids: Vec<String>,
    stored_ids: HashMap<String, String>,
    last_command_output: Option<String>,
    last_error: Option<String>,
}

impl std::fmt::Debug for SmokeWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmokeWorld")
            .field("project_id", &self.project_id)
            .field("task_id", &self.task_id)
            .field("created_task_ids", &self.created_task_ids)
            .field("stored_ids", &self.stored_ids)
            .finish()
    }
}

impl SmokeWorld {
    fn new() -> Self {
        Self {
            client: None,
            project_id: None,
            task_id: None,
            created_task_ids: Vec::new(),
            stored_ids: HashMap::new(),
            last_command_output: None,
            last_error: None,
        }
    }

    fn task_service(&self) -> vertebrae_sacrum_client::SacrumTaskService {
        vertebrae_sacrum_client::SacrumTaskService::new(
            self.client.as_ref().expect("client not configured").clone(),
        )
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

    fn track_task(&mut self, task_id: String) {
        self.task_id = Some(task_id.clone());
        self.created_task_ids.push(task_id);
    }

    fn set_output(&mut self, output: String) {
        self.last_command_output = Some(output);
        self.last_error = None;
    }

    fn set_error(&mut self, error: String) {
        self.last_error = Some(error);
        self.last_command_output = None;
    }

    fn set_service_error(&mut self, err: ServiceError) {
        let mut msg = format!("error: {}", err);
        if let Some(hint) = err.hint() {
            msg.push('\n');
            msg.push_str(&hint);
        }
        self.set_error(msg);
    }

    async fn cleanup(&mut self) {
        if let Some(client) = &self.client {
            let service = vertebrae_sacrum_client::SacrumTaskService::new(client.clone());
            for task_id in self.created_task_ids.drain(..).rev() {
                let _ = service.delete_task(&task_id, true).await;
            }
        }
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

// ---------------------------------------------------------------------------
// Given steps
// ---------------------------------------------------------------------------

#[given("a configured Sacrum client")]
async fn configured_client(world: &mut SmokeWorld) {
    let config = load_test_config();
    let project_id = config.project_id.clone();
    let client = GraphqlClient::new(config);
    world.client = Some(client);
    world.project_id = Some(project_id);
}

#[given(expr = "I store the task ID as {string}")]
async fn store_task_id(world: &mut SmokeWorld, name: String) {
    let task_id = world.task_id.as_ref().expect("no task ID to store").clone();
    world.stored_ids.insert(name, task_id);
}

#[given(expr = "I create a task titled {string}")]
async fn given_create_task(world: &mut SmokeWorld, title: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[given(expr = "I create a task titled {string} with level {string}")]
async fn given_create_task_with_level(world: &mut SmokeWorld, title: String, level: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_level(parse_level(&level));
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with level");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[given(expr = "I create a task with:")]
async fn given_create_task_with_table(world: &mut SmokeWorld, step: &cucumber::gherkin::Step) {
    let table = step.table.as_ref().expect("expected a data table");
    let mut options = CreateTaskOptions::default();

    for row in &table.rows {
        let key = row[0].as_str();
        let value = row[1].as_str();
        match key {
            "title" => options.title = value.to_string(),
            "level" => options.level = Some(parse_level(value)),
            "description" => options.description = Some(value.to_string()),
            "priority" => options.priority = Some(parse_priority(value)),
            other => panic!("unsupported table key: '{}'", other),
        }
    }

    let service = world.task_service();
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task from table");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[given(expr = "I create a task titled {string} with parent {string}")]
async fn given_create_task_with_parent(world: &mut SmokeWorld, title: String, parent_ref: String) {
    let parent_id = world.resolve_vars(&parent_ref);
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_parent(parent_id);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with parent");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[given(expr = "I create a task titled {string} with needs-review")]
async fn given_create_task_with_needs_review(world: &mut SmokeWorld, title: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_needs_review(true);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with needs-review");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[given(expr = "I create a task titled {string} with depends-on {string}")]
async fn given_create_task_with_depends_on(world: &mut SmokeWorld, title: String, dep_ref: String) {
    let dep_id = world.resolve_vars(&dep_ref);
    let service = world.task_service();
    let mut options = CreateTaskOptions::new(title);
    options.depends_on.push(dep_id);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with dependency");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

// ---------------------------------------------------------------------------
// When steps (smoke test originals)
// ---------------------------------------------------------------------------

#[when(expr = "I create a task titled {string}")]
async fn create_task(world: &mut SmokeWorld, title: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title.clone());
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
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

// ---------------------------------------------------------------------------
// When steps: task_add scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I create a task with:")]
async fn create_task_with_table(world: &mut SmokeWorld, step: &cucumber::gherkin::Step) {
    let table = step.table.as_ref().expect("expected a data table");
    let mut options = CreateTaskOptions::default();

    for row in &table.rows {
        let key = row[0].as_str();
        let value = row[1].as_str();
        match key {
            "title" => options.title = value.to_string(),
            "level" => options.level = Some(parse_level(value)),
            "description" => options.description = Some(value.to_string()),
            "priority" => options.priority = Some(parse_priority(value)),
            other => panic!("unsupported table key: '{}'", other),
        }
    }

    let service = world.task_service();
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task from table");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[when(expr = "I create a task titled {string} with level {string}")]
async fn create_task_with_level(world: &mut SmokeWorld, title: String, level: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_level(parse_level(&level));
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with level");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[when(expr = "I create a task titled {string} with priority {string}")]
async fn create_task_with_priority(world: &mut SmokeWorld, title: String, priority: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_priority(parse_priority(&priority));
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with priority");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[when(expr = "I create a task titled {string} with tags {string}")]
async fn create_task_with_tags(world: &mut SmokeWorld, title: String, tags_str: String) {
    let service = world.task_service();
    let mut options = CreateTaskOptions::new(title);
    for tag in tags_str.split(", ") {
        options = options.with_tag(tag.trim());
    }
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with tags");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[when(expr = "I create a task titled {string} with needs-review")]
async fn create_task_with_needs_review(world: &mut SmokeWorld, title: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_needs_review(true);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with needs-review");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[when(expr = "I create a task titled {string} with parent {string}")]
async fn create_task_with_parent(world: &mut SmokeWorld, title: String, parent_ref: String) {
    let parent_id = world.resolve_vars(&parent_ref);
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_parent(parent_id);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with parent");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[when(expr = "I create a task titled {string} with depends-on {string}")]
async fn create_task_with_depends_on(world: &mut SmokeWorld, title: String, dep_ref: String) {
    let dep_id = world.resolve_vars(&dep_ref);
    let service = world.task_service();
    let mut options = CreateTaskOptions::new(title);
    options.depends_on.push(dep_id);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with dependency");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[when(expr = "I attempt to create a task with title {string}")]
async fn attempt_create_task_with_title(world: &mut SmokeWorld, title: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title);
    match service.create_task(options).await {
        Ok(task_id) => {
            world.set_output(format!("Created task: {}", task_id));
            world.track_task(task_id);
        }
        Err(e) => {
            world.set_error(e.to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// When steps: task_show scenarios
// ---------------------------------------------------------------------------

#[when("I show the task")]
async fn show_current_task(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for show");
    world.set_output(format_task_show(&task));
}

#[when(expr = "I show the task {string}")]
async fn show_task_by_ref(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();
    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for show");
    world.set_output(format_task_show(&task));
}

#[when(expr = "I attempt to show task {string}")]
async fn attempt_show_task(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();
    match service.get_task(&task_id).await {
        Ok(task) => {
            world.set_output(format_task_show(&task));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

// ---------------------------------------------------------------------------
// Then steps (smoke test originals)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Then steps: command success/failure
// ---------------------------------------------------------------------------

#[then("the command should succeed")]
async fn command_should_succeed(world: &mut SmokeWorld) {
    assert!(
        world.last_error.is_none(),
        "expected command to succeed, but got error: {:?}",
        world.last_error
    );
}

#[then(expr = "the command should fail with {string}")]
async fn command_should_fail_with(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let error = world
        .last_error
        .as_ref()
        .expect("expected command to have failed, but no error was recorded");
    assert!(
        error.contains(&expected),
        "expected error to contain '{}', but got: '{}'",
        expected,
        error
    );
}

// ---------------------------------------------------------------------------
// Then steps: output assertions
// ---------------------------------------------------------------------------

#[then(expr = "the output should contain {string}")]
async fn output_should_contain(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let output = world
        .last_command_output
        .as_ref()
        .expect("no command output recorded");
    assert!(
        output.contains(&expected),
        "expected output to contain '{}', but got: '{}'",
        expected,
        output
    );
}

#[then(expr = "the output should not contain {string}")]
async fn output_should_not_contain(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let output = world
        .last_command_output
        .as_ref()
        .expect("no command output recorded");
    assert!(
        !output.contains(&expected),
        "expected output NOT to contain '{}', but it did. Full output: '{}'",
        expected,
        output
    );
}

#[then(expr = "the output should match {string}")]
async fn output_should_match(world: &mut SmokeWorld, pattern: String) {
    let pattern = world.resolve_vars(&pattern);
    let output = world
        .last_command_output
        .as_ref()
        .expect("no command output recorded");
    let re = Regex::new(&pattern)
        .unwrap_or_else(|e| panic!("invalid regex pattern '{}': {}", pattern, e));
    assert!(
        re.is_match(output),
        "expected output to match pattern '{}', but got: '{}'",
        pattern,
        output
    );
}

// ---------------------------------------------------------------------------
// Then steps: error and hint assertions
// ---------------------------------------------------------------------------

#[then(expr = "the error should contain {string}")]
async fn error_should_contain(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let error = world
        .last_error
        .as_ref()
        .expect("no error recorded, but expected error containing a substring");
    assert!(
        error.contains(&expected),
        "expected error to contain '{}', but got: '{}'",
        expected,
        error
    );
}

#[then(expr = "the hint should contain {string}")]
async fn hint_should_contain(world: &mut SmokeWorld, expected: String) {
    let expected = world.resolve_vars(&expected);
    let error = world
        .last_error
        .as_ref()
        .expect("no error recorded, but expected hint in error");
    assert!(
        error.contains(&expected),
        "expected hint in error to contain '{}', but got: '{}'",
        expected,
        error
    );
}

// ---------------------------------------------------------------------------
// Then steps: consolidated task field assertions
// ---------------------------------------------------------------------------

#[then(expr = "the task {word} should be {string}")]
async fn task_field_should_be(world: &mut SmokeWorld, field: String, expected: String) {
    let expected = world.resolve_vars(&expected);
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let actual = match field.as_str() {
        "title" => task.title.clone(),
        "level" => task.level.to_string(),
        "priority" => task
            .priority
            .as_ref()
            .map(|p| p.to_string())
            .unwrap_or_default(),
        "description" => task.description.clone().unwrap_or_default(),
        "worktree" => task.worktree.clone().unwrap_or_default(),
        "archived" => task.archived.to_string(),
        "needs_human_review" => task
            .needs_human_review
            .map(|v| v.to_string())
            .unwrap_or_else(|| "false".to_string()),
        other => panic!("unsupported task field for assertion: '{}'", other),
    };

    assert_eq!(
        actual, expected,
        "task {} mismatch: expected '{}', got '{}'",
        field, expected, actual
    );
}

#[then(expr = "the task {word} should be empty")]
async fn task_field_should_be_empty(world: &mut SmokeWorld, field: String) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    match field.as_str() {
        "description" => {
            assert!(
                task.description.is_none() || task.description.as_deref() == Some(""),
                "expected description to be empty, got: {:?}",
                task.description
            );
        }
        "parent_id" => {
            assert!(
                task.parent_id.is_none(),
                "expected parent_id to be empty, got: {:?}",
                task.parent_id
            );
        }
        "worktree" => {
            assert!(
                task.worktree.is_none() || task.worktree.as_deref() == Some(""),
                "expected worktree to be empty, got: {:?}",
                task.worktree
            );
        }
        other => panic!("unsupported task field for empty assertion: '{}'", other),
    }
}

// ---------------------------------------------------------------------------
// Then steps: tags assertion
// ---------------------------------------------------------------------------

#[then(expr = "the task should have tags {string}")]
async fn task_should_have_tags(world: &mut SmokeWorld, expected_tags_str: String) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let expected_tags: Vec<&str> = expected_tags_str.split(", ").collect();
    let mut actual_sorted = task.tags.clone();
    actual_sorted.sort();
    let mut expected_sorted: Vec<String> = expected_tags.iter().map(|s| s.to_string()).collect();
    expected_sorted.sort();

    assert_eq!(
        actual_sorted, expected_sorted,
        "tag mismatch: expected {:?}, got {:?}",
        expected_sorted, actual_sorted
    );
}

// ---------------------------------------------------------------------------
// Then steps: parent and dependency assertions
// ---------------------------------------------------------------------------

#[then(expr = "the task parent_id should match {string}")]
async fn task_parent_id_should_match(world: &mut SmokeWorld, expected_ref: String) {
    let expected = world.resolve_vars(&expected_ref);
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let actual = task
        .parent_id
        .as_ref()
        .expect("expected task to have a parent_id, but it was None");

    assert_eq!(
        actual, &expected,
        "task parent_id mismatch: expected '{}', got '{}'",
        expected, actual
    );
}

#[then(expr = "the task should be blocked by {string}")]
async fn task_should_be_blocked_by(world: &mut SmokeWorld, blocker_ref: String) {
    let expected_blocker = world.resolve_vars(&blocker_ref);
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let deps = service
        .get_dependencies(task_id)
        .await
        .expect("failed to get dependencies");

    assert!(
        deps.contains(&expected_blocker),
        "expected task '{}' to be blocked by '{}', but dependencies are: {:?}",
        task_id,
        expected_blocker,
        deps
    );
}

// ---------------------------------------------------------------------------
// Then steps: section assertions
// ---------------------------------------------------------------------------

#[then(expr = "the task should have {int} {word} sections")]
async fn task_should_have_n_sections(
    world: &mut SmokeWorld,
    expected_count: usize,
    section_type_str: String,
) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let section_type: SectionType = section_type_str
        .parse()
        .unwrap_or_else(|e| panic!("invalid section type '{}': {}", section_type_str, e));

    let actual_count = task
        .sections
        .iter()
        .filter(|s| s.section_type == section_type)
        .count();

    assert_eq!(
        actual_count, expected_count,
        "expected {} {} sections, but found {}",
        expected_count, section_type_str, actual_count
    );
}

#[then(expr = "the section {string} content should be {string}")]
async fn section_content_should_be(
    world: &mut SmokeWorld,
    section_type_str: String,
    expected_content: String,
) {
    let expected_content = world.resolve_vars(&expected_content);
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let section_type: SectionType = section_type_str
        .parse()
        .unwrap_or_else(|e| panic!("invalid section type '{}': {}", section_type_str, e));

    let section = task
        .sections
        .iter()
        .find(|s| s.section_type == section_type)
        .unwrap_or_else(|| panic!("no {} section found on task", section_type_str));

    assert_eq!(
        section.content, expected_content,
        "section '{}' content mismatch: expected '{}', got '{}'",
        section_type_str, expected_content, section.content
    );
}

// ---------------------------------------------------------------------------
// Helpers: format task show output (mirrors TaskDetail::Display from CLI)
// ---------------------------------------------------------------------------

fn format_task_show(task: &vertebrae_core::Task) -> String {
    let mut out = String::new();

    out.push_str(&format!("Task: {} - {}\n", task.id, task.title));
    out.push_str(&"=".repeat(60));
    out.push('\n');
    out.push('\n');

    // Metadata
    out.push_str("Metadata\n");
    out.push_str(&"-".repeat(40));
    out.push('\n');
    out.push_str(&format!("Level:    {}\n", task.level));
    let status_display = match (&task.workflow_name, &task.step_name) {
        (Some(wf), Some(step)) => format!("{}:{}", wf, step),
        _ => "unassigned".to_string(),
    };
    out.push_str(&format!("Status:   {}\n", status_display));
    out.push_str(&format!(
        "Priority: {}\n",
        task.priority
            .as_ref()
            .map(|p| p.as_str())
            .unwrap_or("(none)")
    ));
    let tags_display = if task.tags.is_empty() {
        "(none)".to_string()
    } else {
        task.tags.join(", ")
    };
    out.push_str(&format!("Tags:     {}\n\n", tags_display));
    let review_status = match task.needs_human_review {
        Some(true) => "True",
        Some(false) | None => "False",
    };
    out.push_str(&format!("Human Review: {}\n", review_status));
    out.push_str("\n\n");

    // Description
    if let Some(ref description) = task.description {
        out.push_str("Description\n");
        out.push_str(&"-".repeat(40));
        out.push('\n');
        out.push_str(description);
        out.push_str("\n\n");
    }

    // Sections by type
    let section_configs: &[(SectionType, &str)] = &[
        (SectionType::Goal, "Goal"),
        (SectionType::Context, "Context"),
        (SectionType::CurrentBehavior, "Current Behavior"),
        (SectionType::DesiredBehavior, "Desired Behavior"),
        (SectionType::ChecklistItem, "Checklist Items"),
        (SectionType::TestingCriterion, "Testing Criteria"),
        (SectionType::AntiPattern, "Anti-Patterns"),
        (SectionType::FailureTest, "Failure Tests"),
        (SectionType::Constraint, "Constraints"),
    ];

    for (section_type, label) in section_configs {
        let matching: Vec<_> = task
            .sections
            .iter()
            .filter(|s| &s.section_type == section_type)
            .collect();

        if matching.is_empty() {
            continue;
        }

        out.push_str(label);
        out.push('\n');
        out.push_str(&"-".repeat(40));
        out.push('\n');

        let is_checklist = *section_type == SectionType::ChecklistItem;
        if matching.len() == 1 {
            if is_checklist {
                let checkbox = if matching[0].done.unwrap_or(false) {
                    "[x]"
                } else {
                    "[ ]"
                };
                out.push_str(&format!("{} {}\n", checkbox, matching[0].content));
            } else {
                out.push_str(&format!("{}\n", matching[0].content));
            }
        } else {
            for (i, section) in matching.iter().enumerate() {
                if is_checklist {
                    let checkbox = if section.done.unwrap_or(false) {
                        "[x]"
                    } else {
                        "[ ]"
                    };
                    out.push_str(&format!("{}. {} {}\n", i + 1, checkbox, section.content));
                } else {
                    out.push_str(&format!("{}. {}\n", i + 1, section.content));
                }
            }
        }
        out.push('\n');
    }

    // Relationships
    let has_parent = task.parent_id.is_some();
    let has_children = !task.children.is_empty();
    let has_blockers = task
        .blockers
        .iter()
        .any(|t| t.step_name.as_deref() != Some("done"));
    let has_dependents = !task.dependents.is_empty();

    if has_parent || has_children || has_blockers || has_dependents {
        out.push_str("Relationships\n");
        out.push_str(&"-".repeat(40));
        out.push('\n');

        if let Some(ref parent_id) = task.parent_id {
            out.push_str(&format!("Parent: {}\n", parent_id));
        }

        if has_children {
            out.push_str("Children:\n");
            for child in &task.children {
                out.push_str(&format!("  - {} - {}\n", child.id, child.title));
            }
        }

        if has_blockers {
            out.push_str("Blocked by:\n");
            for blocker in &task.blockers {
                if blocker.step_name.as_deref() != Some("done") {
                    out.push_str(&format!("  - {} - {}\n", blocker.id, blocker.title));
                }
            }
        }

        if has_dependents {
            out.push_str("Blocks:\n");
            for dependent in &task.dependents {
                out.push_str(&format!("  - {} - {}\n", dependent.id, dependent.title));
            }
        }

        out.push('\n');
    }

    out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    SmokeWorld::cucumber()
        .after(|_feature, _rule, scenario, _event, world| {
            Box::pin(async move {
                let has_cleanup_tag = scenario.tags.iter().any(|t| t == "cleanup");
                if has_cleanup_tag {
                    if let Some(world) = world {
                        world.cleanup().await;
                    }
                }
            })
        })
        .run("tests/features")
        .await;
}
