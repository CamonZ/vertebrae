use std::collections::HashMap;

use cucumber::{World, given, then, when};
use regex::Regex;
use vertebrae_core::error::ServiceError;
use vertebrae_core::models::{Level, Priority, SectionType, TaskFilter};
use vertebrae_core::service::{CreateTaskOptions, TaskService, UpdateTaskOptions};
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

#[given(expr = "I create a task titled {string} with description {string}")]
async fn given_create_task_with_description(world: &mut SmokeWorld, title: String, desc: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_description(desc);
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with description");
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

#[given(expr = "I create a task titled {string} with priority {string}")]
async fn given_create_task_with_priority(world: &mut SmokeWorld, title: String, priority: String) {
    let service = world.task_service();
    let options = CreateTaskOptions::new(title).with_priority(parse_priority(&priority));
    let task_id = service
        .create_task(options)
        .await
        .expect("failed to create task with priority");
    world.set_output(format!("Created task: {}", task_id));
    world.track_task(task_id);
}

#[given(expr = "I create a task titled {string} with tags {string}")]
async fn given_create_task_with_tags(world: &mut SmokeWorld, title: String, tags_str: String) {
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

// ---------------------------------------------------------------------------
// Given steps: dependency setup
// ---------------------------------------------------------------------------

#[given(expr = "I run depend {string} --on {string}")]
async fn given_run_depend(world: &mut SmokeWorld, task_ref: String, blocker_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let blocker_id = world.resolve_vars(&blocker_ref);
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for depend");

    if task.dependency_ids.contains(&blocker_id) {
        world.set_output(format!(
            "Dependency already exists: {} -> {}",
            task_id, blocker_id
        ));
        return;
    }

    service
        .add_dependency(&task_id, &blocker_id)
        .await
        .expect("failed to create dependency");
    world.set_output(format!(
        "Created dependency: {} depends on {}",
        task_id, blocker_id
    ));
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
// When steps: task_delete scenarios
// ---------------------------------------------------------------------------

#[when("I delete the task with --force")]
async fn delete_task_force(world: &mut SmokeWorld) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    service
        .delete_task(&task_id, false)
        .await
        .expect("failed to force-delete task");
    world.created_task_ids.retain(|id| id != &task_id);
    world.set_output(format!("Deleted task: {}", task_id));
}

#[when(expr = "I delete task {string} with --cascade --force")]
async fn delete_task_cascade_force(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();

    let mut deleted_ids = collect_descendant_ids(&service, &task_id).await;
    deleted_ids.push(task_id.clone());
    let total = deleted_ids.len();

    service
        .delete_task(&task_id, true)
        .await
        .expect("failed to cascade-force-delete task");

    world
        .created_task_ids
        .retain(|id| !deleted_ids.contains(id));

    world.set_output(format!("Deleted {} tasks (including children)", total));
}

#[when(expr = "I delete task {string} with --force")]
async fn delete_task_by_ref_force(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();
    service
        .delete_task(&task_id, false)
        .await
        .expect("failed to force-delete task by ref");
    world.created_task_ids.retain(|id| id != &task_id);
    world.set_output(format!("Deleted task: {}", task_id));
}

#[when(expr = "I attempt to delete task {string} with --force")]
async fn attempt_delete_task_force(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();
    match service.delete_task(&task_id, false).await {
        Ok(()) => {
            world.created_task_ids.retain(|id| id != &task_id);
            world.set_output(format!("Deleted task: {}", task_id));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
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
// When steps: depend scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I run depend {string} --on {string}")]
async fn when_run_depend(world: &mut SmokeWorld, task_ref: String, blocker_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let blocker_id = world.resolve_vars(&blocker_ref);
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for depend");

    if task.dependency_ids.contains(&blocker_id) {
        world.set_output(format!(
            "Dependency already exists: {} -> {}",
            task_id, blocker_id
        ));
        return;
    }

    service
        .add_dependency(&task_id, &blocker_id)
        .await
        .expect("failed to create dependency");
    world.set_output(format!(
        "Created dependency: {} depends on {}",
        task_id, blocker_id
    ));
}

#[when(expr = "I attempt to run depend {string} --on {string}")]
async fn attempt_run_depend(world: &mut SmokeWorld, task_ref: String, blocker_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let blocker_id = world.resolve_vars(&blocker_ref);

    // Self-dependency check
    if task_id == blocker_id {
        world.set_service_error(ServiceError::validation_failed(
            "Task cannot depend on itself",
        ));
        return;
    }

    let service = world.task_service();

    // Validate task exists
    let task = match service.get_task(&task_id).await {
        Ok(t) => t,
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    };

    // Validate blocker exists
    match service.task_exists(&blocker_id).await {
        Ok(true) => {}
        Ok(false) => {
            world.set_service_error(ServiceError::task_not_found(&blocker_id));
            return;
        }
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    }

    // Check idempotency
    if task.dependency_ids.contains(&blocker_id) {
        world.set_output(format!(
            "Dependency already exists: {} -> {}",
            task_id, blocker_id
        ));
        return;
    }

    match service.add_dependency(&task_id, &blocker_id).await {
        Ok(()) => {
            world.set_output(format!(
                "Created dependency: {} depends on {}",
                task_id, blocker_id
            ));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

// ---------------------------------------------------------------------------
// When steps: undepend scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I run undepend {string} --on {string}")]
async fn when_run_undepend(world: &mut SmokeWorld, task_ref: String, blocker_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let blocker_id = world.resolve_vars(&blocker_ref);
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for undepend");

    let existed = task.dependency_ids.contains(&blocker_id);

    if existed {
        service
            .remove_dependency(&task_id, &blocker_id)
            .await
            .expect("failed to remove dependency");
        world.set_output(format!(
            "Removed dependency: {} no longer depends on {}",
            task_id, blocker_id
        ));
    } else {
        world.set_output(format!(
            "Warning: No dependency from {} to {} exists",
            task_id, blocker_id
        ));
    }
}

// ---------------------------------------------------------------------------
// When steps: blockers scenarios
// ---------------------------------------------------------------------------

#[when("I run blockers for the task")]
async fn when_run_blockers_current(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    run_blockers(world, &task_id, None).await;
}

#[when(expr = "I run blockers for task {string}")]
async fn when_run_blockers_by_ref(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    run_blockers(world, &task_id, None).await;
}

#[when(expr = "I run blockers for task {string} with --depth {int}")]
async fn when_run_blockers_with_depth(world: &mut SmokeWorld, task_ref: String, depth: usize) {
    let task_id = world.resolve_vars(&task_ref);
    run_blockers(world, &task_id, Some(depth)).await;
}

async fn run_blockers(world: &mut SmokeWorld, task_id: &str, max_depth: Option<usize>) {
    let service = world.task_service();

    let task = service
        .get_task(task_id)
        .await
        .expect("failed to get task for blockers");

    let blockers = build_blocker_tree(&service, task_id, 0, max_depth).await;
    let total_count = count_blocker_nodes(&blockers);

    if blockers.is_empty() {
        world.set_output("No blockers".to_string());
        return;
    }

    let mut out = String::new();
    out.push_str(&format!("Blockers for: {} \"{}\"\n", task_id, task.title));
    out.push_str(&"=".repeat(50));
    out.push('\n');
    out.push('\n');

    for (i, node) in blockers.iter().enumerate() {
        let is_last = i == blockers.len() - 1;
        format_blocker_node(&mut out, node, "", is_last);
    }

    out.push('\n');
    out.push_str(&format!(
        "Total: {} blocking item{}",
        total_count,
        if total_count == 1 { "" } else { "s" }
    ));

    world.set_output(out);
}

struct BlockerNodeLocal {
    id: String,
    title: String,
    level: String,
    step_name: Option<String>,
    children: Vec<BlockerNodeLocal>,
}

async fn build_blocker_tree(
    service: &vertebrae_sacrum_client::SacrumTaskService,
    task_id: &str,
    current_depth: usize,
    max_depth: Option<usize>,
) -> Vec<BlockerNodeLocal> {
    if let Some(limit) = max_depth {
        if current_depth >= limit {
            return vec![];
        }
    }

    let task = service
        .get_task(task_id)
        .await
        .expect("failed to get task for blocker tree");

    let mut nodes = Vec::new();
    for blocker_id in &task.dependency_ids {
        if let Ok(blocker) = service.get_task(blocker_id).await {
            let step_name = blocker
                .step_name
                .clone()
                .unwrap_or_else(|| "backlog".to_string());

            if step_name == "done" {
                continue;
            }

            let children = Box::pin(build_blocker_tree(
                service,
                blocker_id,
                current_depth + 1,
                max_depth,
            ))
            .await;

            nodes.push(BlockerNodeLocal {
                id: blocker_id.clone(),
                title: blocker.title,
                level: blocker.level.to_string(),
                step_name: Some(step_name),
                children,
            });
        }
    }

    nodes
}

fn count_blocker_nodes(nodes: &[BlockerNodeLocal]) -> usize {
    nodes
        .iter()
        .map(|n| 1 + count_blocker_nodes(&n.children))
        .sum()
}

fn format_blocker_node(out: &mut String, node: &BlockerNodeLocal, prefix: &str, is_last: bool) {
    let connector = if prefix.is_empty() {
        ""
    } else if is_last {
        "`-- "
    } else {
        "|-- "
    };

    let level_display = format!("{:8}", node.level);
    let status_display = format!("{:12}", node.step_name.as_deref().unwrap_or("unassigned"));

    out.push_str(&format!(
        "{}{}{:<8} {} {} {}\n",
        prefix, connector, node.id, level_display, status_display, node.title
    ));

    let child_prefix = if prefix.is_empty() {
        "".to_string()
    } else if is_last {
        format!("{}    ", prefix)
    } else {
        format!("{}|   ", prefix)
    };

    let actual_prefix = if prefix.is_empty() {
        "    ".to_string()
    } else {
        child_prefix
    };

    for (i, child) in node.children.iter().enumerate() {
        let child_is_last = i == node.children.len() - 1;
        format_blocker_node(out, child, &actual_prefix, child_is_last);
    }
}

// ---------------------------------------------------------------------------
// When steps: path scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I run path {string} {string}")]
async fn when_run_path(world: &mut SmokeWorld, from_ref: String, to_ref: String) {
    let from_id = world.resolve_vars(&from_ref);
    let to_id = world.resolve_vars(&to_ref);
    let service = world.task_service();

    let from_task = service
        .get_task(&from_id)
        .await
        .expect("failed to get source task for path");

    if from_id == to_id {
        world.set_output(format!("Same task: {} \"{}\"", from_id, from_task.title));
        return;
    }

    let _to_task = service
        .get_task(&to_id)
        .await
        .expect("failed to get target task for path");

    match service.find_path(&from_id, &to_id).await {
        Ok(Some(path_ids)) => {
            let mut out = String::new();
            out.push_str(&format!("Path from {} to {}:\n\n", from_id, to_id));

            let mut summaries = Vec::new();
            for id in &path_ids {
                let task = service
                    .get_task(id)
                    .await
                    .expect("failed to get task in path");
                summaries.push((id.clone(), task.title));
            }

            for (i, (id, title)) in summaries.iter().enumerate() {
                out.push_str(&format!("{:<8}  \"{}\"\n", id, title));
                if i < summaries.len() - 1 {
                    out.push_str("   \u{2193} depends on\n");
                }
            }

            out.push('\n');
            out.push_str(&format!(
                "{} task{} in path",
                summaries.len(),
                if summaries.len() == 1 { "" } else { "s" }
            ));

            world.set_output(out);
        }
        Ok(None) => {
            world.set_output(format!("No dependency path from {} to {}", from_id, to_id));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

#[when(expr = "I attempt to run path {string} {string}")]
async fn attempt_run_path(world: &mut SmokeWorld, from_ref: String, to_ref: String) {
    let from_id = world.resolve_vars(&from_ref);
    let to_id = world.resolve_vars(&to_ref);
    let service = world.task_service();

    let from_task = match service.get_task(&from_id).await {
        Ok(t) => t,
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    };

    match service.get_task(&to_id).await {
        Ok(_) => {}
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    }

    if from_id == to_id {
        world.set_output(format!("Same task: {} \"{}\"", from_id, from_task.title));
        return;
    }

    match service.find_path(&from_id, &to_id).await {
        Ok(Some(path_ids)) => {
            let mut out = String::new();
            out.push_str(&format!("Path from {} to {}:\n\n", from_id, to_id));

            for (i, id) in path_ids.iter().enumerate() {
                let task = service
                    .get_task(id)
                    .await
                    .expect("failed to get task in path");
                out.push_str(&format!("{:<8}  \"{}\"\n", id, task.title));
                if i < path_ids.len() - 1 {
                    out.push_str("   \u{2193} depends on\n");
                }
            }

            out.push('\n');
            out.push_str(&format!(
                "{} task{} in path",
                path_ids.len(),
                if path_ids.len() == 1 { "" } else { "s" }
            ));

            world.set_output(out);
        }
        Ok(None) => {
            world.set_output(format!("No dependency path from {} to {}", from_id, to_id));
        }
        Err(e) => {
            world.set_service_error(e);
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
// When steps: task_list scenarios
// ---------------------------------------------------------------------------

#[when("I list all tasks")]
async fn list_all_tasks(world: &mut SmokeWorld) {
    let service = world.task_service();
    let filter = TaskFilter::new();
    let tasks = service
        .list_tasks(&filter)
        .await
        .expect("failed to list tasks");
    world.set_output(format_task_list(&tasks));
}

#[when(expr = "I list tasks with --level {string}")]
async fn list_tasks_with_level(world: &mut SmokeWorld, level: String) {
    let service = world.task_service();
    let filter = TaskFilter::new().with_level(parse_level(&level));
    let tasks = service
        .list_tasks(&filter)
        .await
        .expect("failed to list tasks with level filter");
    world.set_output(format_task_list(&tasks));
}

#[when(expr = "I list tasks with --priority {string}")]
async fn list_tasks_with_priority(world: &mut SmokeWorld, priority: String) {
    let service = world.task_service();
    let filter = TaskFilter::new().with_priority(parse_priority(&priority));
    let tasks = service
        .list_tasks(&filter)
        .await
        .expect("failed to list tasks with priority filter");
    world.set_output(format_task_list(&tasks));
}

#[when(expr = "I list tasks with --tag {string}")]
async fn list_tasks_with_tag(world: &mut SmokeWorld, tag: String) {
    let service = world.task_service();
    let filter = TaskFilter::new().with_tag(tag);
    let tasks = service
        .list_tasks(&filter)
        .await
        .expect("failed to list tasks with tag filter");
    world.set_output(format_task_list(&tasks));
}

#[when("I list tasks with --root")]
async fn list_tasks_with_root(world: &mut SmokeWorld) {
    let service = world.task_service();
    let filter = TaskFilter::new().root_only();
    let tasks = service
        .list_tasks(&filter)
        .await
        .expect("failed to list tasks with root filter");
    world.set_output(format_task_list(&tasks));
}

#[when(expr = "I list tasks with --parent {string}")]
async fn list_tasks_with_parent(world: &mut SmokeWorld, parent_ref: String) {
    let parent_id = world.resolve_vars(&parent_ref);
    let service = world.task_service();
    let filter = TaskFilter::new().children_of(parent_id);
    let tasks = service
        .list_tasks(&filter)
        .await
        .expect("failed to list tasks with parent filter");
    world.set_output(format_task_list(&tasks));
}

#[when(expr = "I list tasks with --search {string}")]
async fn list_tasks_with_search(world: &mut SmokeWorld, search: String) {
    let service = world.task_service();
    let filter = TaskFilter::new().with_search(search);
    let tasks = service
        .list_tasks(&filter)
        .await
        .expect("failed to list tasks with search filter");
    world.set_output(format_task_list(&tasks));
}

#[when(expr = "I attempt to list tasks with --search {string}")]
async fn attempt_list_tasks_with_search(world: &mut SmokeWorld, search: String) {
    if search.trim().is_empty() {
        world.set_service_error(ServiceError::validation_failed(
            "Search query cannot be empty",
        ));
        return;
    }
    let service = world.task_service();
    let filter = TaskFilter::new().with_search(search);
    match service.list_tasks(&filter).await {
        Ok(tasks) => {
            world.set_output(format_task_list(&tasks));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

// ---------------------------------------------------------------------------
// When steps: task_update scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I update the task with --title {string}")]
async fn update_task_title(world: &mut SmokeWorld, title: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let options = UpdateTaskOptions::new().with_title(title);
    service
        .update_task(&task_id, options)
        .await
        .expect("failed to update task title");
}

#[when(expr = "I update the task with --description {string}")]
async fn update_task_description(world: &mut SmokeWorld, description: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let options = if description.is_empty() {
        UpdateTaskOptions::new().clear_description()
    } else {
        UpdateTaskOptions::new().with_description(description)
    };
    service
        .update_task(&task_id, options)
        .await
        .expect("failed to update task description");
}

#[when(expr = "I update the task with --priority {string}")]
async fn update_task_priority(world: &mut SmokeWorld, priority: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let options = UpdateTaskOptions::new().with_priority(parse_priority(&priority));
    service
        .update_task(&task_id, options)
        .await
        .expect("failed to update task priority");
}

#[when(regex = r#"^I update the task with((?:\s+--add-tag "[^"]+")+ *)$"#)]
async fn update_task_add_tags(world: &mut SmokeWorld, _tags_part: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let re = Regex::new(r#"--add-tag "([^"]+)""#).unwrap();
    let mut options = UpdateTaskOptions::new();
    for cap in re.captures_iter(&_tags_part) {
        options = options.add_tag(&cap[1]);
    }
    service
        .update_task(&task_id, options)
        .await
        .expect("failed to update task tags");
}

#[when(expr = "I update the task with --remove-tag {string}")]
async fn update_task_remove_tag(world: &mut SmokeWorld, tag: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let options = UpdateTaskOptions::new().remove_tag(tag);
    service
        .update_task(&task_id, options)
        .await
        .expect("failed to update task remove-tag");
}

#[when(expr = "I update the task with --parent {string}")]
async fn update_task_parent(world: &mut SmokeWorld, parent_ref: String) {
    let parent_ref = world.resolve_vars(&parent_ref);
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let options = if parent_ref.is_empty() {
        UpdateTaskOptions::new().clear_parent()
    } else {
        UpdateTaskOptions::new().with_parent(parent_ref)
    };
    service
        .update_task(&task_id, options)
        .await
        .expect("failed to update task parent");
}

#[when(expr = "I update the task with --worktree {string}")]
async fn update_task_worktree(world: &mut SmokeWorld, worktree: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let options = if worktree.is_empty() {
        UpdateTaskOptions::new().clear_worktree()
    } else {
        UpdateTaskOptions::new().with_worktree(worktree)
    };
    service
        .update_task(&task_id, options)
        .await
        .expect("failed to update task worktree");
}

#[when(expr = "I attempt to update task {string} with --title {string}")]
async fn attempt_update_task_by_id(world: &mut SmokeWorld, task_ref: String, title: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();
    let options = UpdateTaskOptions::new().with_title(title);
    match service.update_task(&task_id, options).await {
        Ok(()) => {
            world.set_output("Task updated".to_string());
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

#[when(expr = "I attempt to update the task with --parent {string}")]
async fn attempt_update_task_parent(world: &mut SmokeWorld, parent_ref: String) {
    let parent_ref = world.resolve_vars(&parent_ref);
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let options = if parent_ref.is_empty() {
        UpdateTaskOptions::new().clear_parent()
    } else {
        UpdateTaskOptions::new().with_parent(parent_ref)
    };
    match service.update_task(&task_id, options).await {
        Ok(()) => {
            world.set_output("Task updated".to_string());
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

#[then(expr = "the task should not have tag {string}")]
async fn task_should_not_have_tag(world: &mut SmokeWorld, tag: String) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    assert!(
        !task.tags.contains(&tag),
        "expected task NOT to have tag '{}', but tags are: {:?}",
        tag,
        task.tags
    );
}

// ---------------------------------------------------------------------------
// Then steps: task_delete assertions
// ---------------------------------------------------------------------------

#[then(expr = "task {string} should no longer exist")]
async fn task_ref_should_not_exist(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();
    let result = service.get_task(&task_id).await;
    assert!(
        result.is_err(),
        "expected task '{}' to not exist after deletion, but get_task succeeded",
        task_id
    );
}

#[then(expr = "task {string} should still exist")]
async fn task_ref_should_still_exist(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();
    let result = service.get_task(&task_id).await;
    assert!(
        result.is_ok(),
        "expected task '{}' to still exist, but get_task failed: {:?}",
        task_id,
        result.err()
    );
}

#[then(expr = "task {string} should have no parent")]
async fn task_ref_should_have_no_parent(world: &mut SmokeWorld, task_ref: String) {
    let task_id = world.resolve_vars(&task_ref);
    let service = world.task_service();
    let task = service
        .get_task(&task_id)
        .await
        .unwrap_or_else(|e| panic!("failed to get task '{}': {:?}", task_id, e));
    assert!(
        task.parent_id.is_none(),
        "expected task '{}' to have no parent, but parent_id is {:?}",
        task_id,
        task.parent_id
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
// When steps: section (add) scenarios
// ---------------------------------------------------------------------------

fn parse_section_type(s: &str) -> SectionType {
    s.parse::<SectionType>()
        .unwrap_or_else(|e| panic!("invalid section type '{}': {}", s, e))
}

#[when(expr = "I add a {string} section with content {string}")]
async fn add_section(world: &mut SmokeWorld, section_type_str: String, content: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let section_type = parse_section_type(&section_type_str);
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for section add");

    let (ordinal, replaced) = if section_type.is_single_instance() {
        let existing = task.sections.iter().any(|s| s.section_type == section_type);
        if existing {
            service
                .remove_sections(&task_id, section_type.clone(), None)
                .await
                .expect("failed to remove existing single-instance section");
        }
        (None, existing)
    } else {
        let count = task
            .sections
            .iter()
            .filter(|s| s.section_type == section_type)
            .count();
        (Some(count as u32), false)
    };

    let section = vertebrae_core::Section {
        section_type: section_type.clone(),
        content: content.clone(),
        order: ordinal,
        done: None,
        done_at: None,
        refs: Vec::new(),
    };

    service
        .add_section(&task_id, section)
        .await
        .expect("failed to add section");

    let output = if replaced {
        format!("Replaced {} section for task: {}", section_type, task_id)
    } else if let Some(ord) = ordinal {
        format!(
            "Added {} section (ordinal {}) to task: {}",
            section_type, ord, task_id
        )
    } else {
        format!("Added {} section to task: {}", section_type, task_id)
    };

    world.set_output(output);
}

#[when(expr = "I attempt to add a {string} section with content {string}")]
async fn attempt_add_section(world: &mut SmokeWorld, section_type_str: String, content: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let section_type = parse_section_type(&section_type_str);

    if content.trim().is_empty() {
        world.set_service_error(ServiceError::validation_failed(
            "section content cannot be empty",
        ));
        return;
    }

    let service = world.task_service();
    let section = vertebrae_core::Section::new(section_type, content);
    match service.add_section(&task_id, section).await {
        Ok(()) => {
            world.set_output(format!(
                "Added {} section to task: {}",
                section_type_str, task_id
            ));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

// ---------------------------------------------------------------------------
// Then steps: section (add) assertions
// ---------------------------------------------------------------------------

#[then(expr = "the task should have a {word} section with content {string}")]
async fn task_should_have_section_with_content(
    world: &mut SmokeWorld,
    section_type_str: String,
    expected_content: String,
) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let section_type = parse_section_type(&section_type_str);

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

#[then(expr = "the task should have a {word} section")]
async fn task_should_have_section_of_type(world: &mut SmokeWorld, section_type_str: String) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let section_type = parse_section_type(&section_type_str);

    let count = task
        .sections
        .iter()
        .filter(|s| s.section_type == section_type)
        .count();

    assert!(
        count > 0,
        "expected task to have at least one {} section, but found 0",
        section_type_str
    );
}

// ---------------------------------------------------------------------------
// When steps: sections (list) scenarios
// ---------------------------------------------------------------------------

#[when("I list sections")]
async fn list_sections(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for sections list");

    if task.sections.is_empty() {
        world.set_output("No sections defined".to_string());
        return;
    }

    let mut out = String::new();
    out.push_str(&format!("Sections for task: {}\n", task_id));
    out.push_str(&"=".repeat(60));
    out.push('\n');

    let positive: Vec<_> = task
        .sections
        .iter()
        .filter(|s| is_positive_space(&s.section_type))
        .collect();
    let negative: Vec<_> = task
        .sections
        .iter()
        .filter(|s| !is_positive_space(&s.section_type))
        .collect();

    if !positive.is_empty() {
        out.push_str("\nDesired Behavior\n");
        out.push_str(&"-".repeat(40));
        out.push('\n');
        for s in &positive {
            out.push_str(&format!("{}: {}\n", s.section_type, s.content));
        }
    }

    if !negative.is_empty() {
        out.push_str("\nUndesired Behavior\n");
        out.push_str(&"-".repeat(40));
        out.push('\n');
        for s in &negative {
            out.push_str(&format!("{}: {}\n", s.section_type, s.content));
        }
    }

    world.set_output(out);
}

fn is_positive_space(section_type: &SectionType) -> bool {
    matches!(
        section_type,
        SectionType::Goal
            | SectionType::Context
            | SectionType::CurrentBehavior
            | SectionType::DesiredBehavior
            | SectionType::ChecklistItem
            | SectionType::TestingCriterion
    )
}

#[when(expr = "I list sections with --type {string}")]
async fn list_sections_with_type(world: &mut SmokeWorld, type_filter: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    let filter_type = parse_section_type(&type_filter);

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for sections list with type");

    let filtered: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == filter_type)
        .collect();

    if filtered.is_empty() {
        world.set_output(format!("No sections of type '{}'", filter_type));
        return;
    }

    let mut out = String::new();
    out.push_str(&format!("Sections for task: {}\n", task_id));
    for s in &filtered {
        out.push_str(&format!("{}: {}\n", s.section_type, s.content));
    }
    world.set_output(out);
}

// ---------------------------------------------------------------------------
// When steps: unsection (remove) scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I remove the {string} section")]
async fn remove_section(world: &mut SmokeWorld, section_type_str: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let section_type = parse_section_type(&section_type_str);
    let service = world.task_service();

    service
        .remove_sections(&task_id, section_type.clone(), None)
        .await
        .expect("failed to remove section");

    world.set_output(format!(
        "Removed {} section from task: {}",
        section_type, task_id
    ));
}

#[when(expr = "I remove the {string} section at index {int}")]
async fn remove_section_at_index(world: &mut SmokeWorld, section_type_str: String, index: u32) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let section_type = parse_section_type(&section_type_str);
    let service = world.task_service();

    service
        .remove_section_by_ordinal(&task_id, section_type.clone(), index)
        .await
        .expect("failed to remove section at index");

    world.set_output(format!(
        "Removed {} section from task: {}",
        section_type, task_id
    ));
}

#[when(expr = "I attempt to remove the {string} section without index")]
async fn attempt_remove_multi_section_without_index(
    world: &mut SmokeWorld,
    section_type_str: String,
) {
    let section_type = parse_section_type(&section_type_str);

    if !section_type.is_single_instance() {
        world.set_service_error(ServiceError::validation_failed(format!(
            "Section type '{}' can have multiple instances. Use --index <n> to remove a specific one",
            section_type
        )));
        return;
    }

    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();
    match service
        .remove_sections(&task_id, section_type.clone(), None)
        .await
    {
        Ok(()) => {
            world.set_output(format!(
                "Removed {} section from task: {}",
                section_type, task_id
            ));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

#[when(expr = "I attempt to remove the {string} section")]
async fn attempt_remove_section(world: &mut SmokeWorld, section_type_str: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let section_type = parse_section_type(&section_type_str);
    let service = world.task_service();

    let task = match service.get_task(&task_id).await {
        Ok(t) => t,
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    };

    let exists = task.sections.iter().any(|s| s.section_type == section_type);

    if !exists {
        world.set_service_error(ServiceError::validation_failed(format!(
            "No {} section found",
            section_type
        )));
        return;
    }

    match service
        .remove_sections(&task_id, section_type.clone(), None)
        .await
    {
        Ok(()) => {
            world.set_output(format!(
                "Removed {} section from task: {}",
                section_type, task_id
            ));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

#[when(expr = "I attempt to remove the {string} section at index {int}")]
async fn attempt_remove_section_at_index(
    world: &mut SmokeWorld,
    section_type_str: String,
    index: u32,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let section_type = parse_section_type(&section_type_str);
    let service = world.task_service();

    let task = match service.get_task(&task_id).await {
        Ok(t) => t,
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    };

    let exists = task
        .sections
        .iter()
        .any(|s| s.section_type == section_type && s.order == Some(index));

    if !exists {
        world.set_service_error(ServiceError::validation_failed(format!(
            "No {} section found at index {}",
            section_type, index
        )));
        return;
    }

    match service
        .remove_section_by_ordinal(&task_id, section_type.clone(), index)
        .await
    {
        Ok(()) => {
            world.set_output(format!(
                "Removed {} section from task: {}",
                section_type, task_id
            ));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

// ---------------------------------------------------------------------------
// When steps: check-item / uncheck-item scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I check item {int}")]
async fn check_item(world: &mut SmokeWorld, index: usize) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for check-item");

    let mut items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    items.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    let item = items
        .get(index - 1)
        .unwrap_or_else(|| panic!("checklist item {} not found", index));

    let section_order = item.order.unwrap_or(0);
    let content = item.content.clone();

    service
        .mark_checklist_item_done(&task_id, section_order)
        .await
        .expect("failed to mark checklist item done");

    world.set_output(format!(
        "Marked checklist item {} as done in {}: {}",
        index, task_id, content
    ));
}

#[when(expr = "I attempt to check item {int}")]
async fn attempt_check_item(world: &mut SmokeWorld, index: usize) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    if index == 0 {
        world.set_service_error(ServiceError::validation_failed(
            "Checklist item index must be 1 or greater",
        ));
        return;
    }

    let service = world.task_service();

    let task = match service.get_task(&task_id).await {
        Ok(t) => t,
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    };

    let mut items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    items.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    if index > items.len() {
        world.set_service_error(ServiceError::validation_failed(format!(
            "Checklist item {} not found. Task has {} checklist item(s).",
            index,
            items.len()
        )));
        return;
    }

    let item = &items[index - 1];
    let section_order = item.order.unwrap_or(0);
    let content = item.content.clone();

    match service
        .mark_checklist_item_done(&task_id, section_order)
        .await
    {
        Ok(()) => {
            world.set_output(format!(
                "Marked checklist item {} as done in {}: {}",
                index, task_id, content
            ));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

#[when(expr = "I uncheck item {int}")]
async fn uncheck_item(world: &mut SmokeWorld, index: usize) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for uncheck-item");

    let mut items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    items.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    let item = items
        .get(index - 1)
        .unwrap_or_else(|| panic!("checklist item {} not found", index));

    let section_order = item.order.unwrap_or(0);
    let content = item.content.clone();

    service
        .toggle_checklist_item_done(&task_id, section_order)
        .await
        .expect("failed to uncheck checklist item");

    world.set_output(format!(
        "Unchecked checklist item {} in {}: {}",
        index, task_id, content
    ));
}

#[when(expr = "I attempt to uncheck item {int}")]
async fn attempt_uncheck_item(world: &mut SmokeWorld, index: usize) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    if index == 0 {
        world.set_service_error(ServiceError::validation_failed(
            "Checklist item index must be 1 or greater",
        ));
        return;
    }

    let service = world.task_service();

    let task = match service.get_task(&task_id).await {
        Ok(t) => t,
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    };

    let mut items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    items.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    if index > items.len() {
        world.set_service_error(ServiceError::validation_failed(format!(
            "Checklist item {} not found. Task has {} checklist item(s).",
            index,
            items.len()
        )));
        return;
    }

    let item = &items[index - 1];

    if !item.done.unwrap_or(false) {
        world.set_service_error(ServiceError::validation_failed(format!(
            "Checklist item {} is not checked",
            index
        )));
        return;
    }

    let section_order = item.order.unwrap_or(0);
    let content = item.content.clone();

    match service
        .toggle_checklist_item_done(&task_id, section_order)
        .await
    {
        Ok(()) => {
            world.set_output(format!(
                "Unchecked checklist item {} in {}: {}",
                index, task_id, content
            ));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

// ---------------------------------------------------------------------------
// Then steps: checklist done/not-done assertions
// ---------------------------------------------------------------------------

#[then(expr = "checklist item {int} should not be done")]
async fn checklist_item_should_not_be_done(world: &mut SmokeWorld, index: usize) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let mut items: Vec<_> = task
        .sections
        .iter()
        .filter(|s| s.section_type == SectionType::ChecklistItem)
        .collect();
    items.sort_by_key(|s| s.order.unwrap_or(u32::MAX));

    let item = items
        .get(index - 1)
        .unwrap_or_else(|| panic!("checklist item {} not found for assertion", index));

    assert!(
        !item.done.unwrap_or(false),
        "expected checklist item {} ('{}') to NOT be done, but it was marked done",
        index,
        item.content
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

fn format_task_list(tasks: &[vertebrae_core::Task]) -> String {
    let mut out = String::new();
    for task in tasks {
        out.push_str(&format!("{} {}\n", task.id, task.title));
    }
    out
}

// ---------------------------------------------------------------------------
// Helpers: cascade delete descendant collection
// ---------------------------------------------------------------------------

async fn collect_descendant_ids(
    service: &vertebrae_sacrum_client::SacrumTaskService,
    task_id: &str,
) -> Vec<String> {
    let mut ids = Vec::new();
    let children = service.get_children(task_id).await.unwrap_or_default();
    for child_id in &children {
        ids.push(child_id.clone());
        let nested = Box::pin(collect_descendant_ids(service, child_id)).await;
        ids.extend(nested);
    }
    ids
}

// ---------------------------------------------------------------------------
// Helpers: file spec parsing for code ref tests
// ---------------------------------------------------------------------------

struct ParsedFileSpec {
    path: String,
    line_start: Option<u32>,
    line_end: Option<u32>,
}

fn parse_file_spec(spec: &str) -> Result<ParsedFileSpec, String> {
    if let Some(colon_pos) = spec.rfind(':') {
        let after_colon = &spec[colon_pos + 1..];

        if after_colon.starts_with('L') || after_colon.starts_with('l') {
            let path = spec[..colon_pos].to_string();
            let line_part = &after_colon[1..];

            if path.is_empty() {
                return Err("file path cannot be empty".to_string());
            }

            if let Some(dash_pos) = line_part.find('-') {
                let start_str = &line_part[..dash_pos];
                let end_str = &line_part[dash_pos + 1..];

                let start: u32 = start_str
                    .parse()
                    .map_err(|_| format!("invalid line number: '{}'", start_str))?;
                let end: u32 = end_str
                    .parse()
                    .map_err(|_| format!("invalid line number: '{}'", end_str))?;

                if start > end {
                    return Err(format!(
                        "invalid line range: start ({}) > end ({})",
                        start, end
                    ));
                }

                return Ok(ParsedFileSpec {
                    path,
                    line_start: Some(start),
                    line_end: Some(end),
                });
            }

            if line_part.is_empty() {
                return Err("line number required after 'L'".to_string());
            }

            let line: u32 = line_part
                .parse()
                .map_err(|_| format!("invalid line number: '{}'", line_part))?;

            return Ok(ParsedFileSpec {
                path,
                line_start: Some(line),
                line_end: None,
            });
        }
    }

    if spec.is_empty() {
        return Err("file path cannot be empty".to_string());
    }

    Ok(ParsedFileSpec {
        path: spec.to_string(),
        line_start: None,
        line_end: None,
    })
}

fn format_file_spec(path: &str, line_start: Option<u32>, line_end: Option<u32>) -> String {
    match (line_start, line_end) {
        (Some(start), Some(end)) => format!("{}:L{}-{}", path, start, end),
        (Some(line), None) => format!("{}:L{}", path, line),
        _ => path.to_string(),
    }
}

// ---------------------------------------------------------------------------
// When steps: ref (add) scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I add a ref {string}")]
async fn add_ref(world: &mut SmokeWorld, file_spec: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let parsed = parse_file_spec(&file_spec).expect("invalid file spec");
    let code_ref = vertebrae_core::CodeRef {
        path: parsed.path.clone(),
        line_start: parsed.line_start,
        line_end: parsed.line_end,
        name: None,
        description: None,
    };

    service
        .append_ref(&task_id, &code_ref)
        .await
        .expect("failed to add ref");

    let location = format_file_spec(&parsed.path, parsed.line_start, parsed.line_end);
    let mut output = format!("Added reference {} to task: {}", location, task_id);

    if !std::path::Path::new(&parsed.path).exists() {
        output.push_str(&format!("\nWarning: file '{}' does not exist", parsed.path));
    }

    world.set_output(output);
}

#[when(expr = "I add a ref {string} --name {string}")]
async fn add_ref_with_name(world: &mut SmokeWorld, file_spec: String, name: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let parsed = parse_file_spec(&file_spec).expect("invalid file spec");
    let code_ref = vertebrae_core::CodeRef {
        path: parsed.path.clone(),
        line_start: parsed.line_start,
        line_end: parsed.line_end,
        name: Some(name.clone()),
        description: None,
    };

    service
        .append_ref(&task_id, &code_ref)
        .await
        .expect("failed to add ref with name");

    let location = format_file_spec(&parsed.path, parsed.line_start, parsed.line_end);
    let mut output = format!(
        "Added reference {} to task: {} [{}]",
        location, task_id, name
    );

    if !std::path::Path::new(&parsed.path).exists() {
        output.push_str(&format!("\nWarning: file '{}' does not exist", parsed.path));
    }

    world.set_output(output);
}

#[when(expr = "I add a ref {string} --description {string}")]
async fn add_ref_with_description(world: &mut SmokeWorld, file_spec: String, desc: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let parsed = parse_file_spec(&file_spec).expect("invalid file spec");
    let code_ref = vertebrae_core::CodeRef {
        path: parsed.path.clone(),
        line_start: parsed.line_start,
        line_end: parsed.line_end,
        name: None,
        description: Some(desc.clone()),
    };

    service
        .append_ref(&task_id, &code_ref)
        .await
        .expect("failed to add ref with description");

    let location = format_file_spec(&parsed.path, parsed.line_start, parsed.line_end);
    let mut output = format!("Added reference {} to task: {}", location, task_id);

    if !std::path::Path::new(&parsed.path).exists() {
        output.push_str(&format!("\nWarning: file '{}' does not exist", parsed.path));
    }

    world.set_output(output);
}

#[when(expr = "I attempt to add a ref {string}")]
async fn attempt_add_ref(world: &mut SmokeWorld, file_spec: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    let parsed = match parse_file_spec(&file_spec) {
        Ok(p) => p,
        Err(msg) => {
            world.set_service_error(ServiceError::validation_failed(format!(
                "{}: {}",
                file_spec, msg
            )));
            return;
        }
    };

    let code_ref = vertebrae_core::CodeRef {
        path: parsed.path.clone(),
        line_start: parsed.line_start,
        line_end: parsed.line_end,
        name: None,
        description: None,
    };

    let service = world.task_service();
    match service.append_ref(&task_id, &code_ref).await {
        Ok(()) => {
            let location = format_file_spec(&parsed.path, parsed.line_start, parsed.line_end);
            world.set_output(format!("Added reference {} to task: {}", location, task_id));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

// ---------------------------------------------------------------------------
// When steps: refs (list) scenarios
// ---------------------------------------------------------------------------

#[when("I list refs")]
async fn list_refs(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for refs list");

    let mut refs = task.code_refs.clone();

    if refs.is_empty() {
        world.set_output("No code references defined".to_string());
        return;
    }

    refs.sort_by(|a, b| match a.path.cmp(&b.path) {
        std::cmp::Ordering::Equal => {
            let a_line = a.line_start.unwrap_or(0);
            let b_line = b.line_start.unwrap_or(0);
            a_line.cmp(&b_line)
        }
        other => other,
    });

    let mut out = String::new();
    out.push_str(&format!(
        "Code references for: {} \"{}\"\n",
        task_id, task.title
    ));
    out.push_str(&"\u{2550}".repeat(60));
    out.push('\n');
    out.push('\n');

    let file_width = refs.iter().map(|r| r.path.len()).max().unwrap_or(4).max(4);
    let lines_width = refs
        .iter()
        .map(|r| format_file_spec_lines(r.line_start, r.line_end).len())
        .max()
        .unwrap_or(5)
        .max(5);
    let name_width = refs
        .iter()
        .filter_map(|r| r.name.as_ref().map(|n| n.len()))
        .max()
        .unwrap_or(4)
        .max(4);

    out.push_str(&format!(
        "{:<fw$}  {:<lw$}  {:<nw$}  Description\n",
        "File",
        "Lines",
        "Name",
        fw = file_width,
        lw = lines_width,
        nw = name_width,
    ));
    out.push_str(&format!(
        "{}  {}  {}  {}\n",
        "\u{2500}".repeat(file_width),
        "\u{2500}".repeat(lines_width),
        "\u{2500}".repeat(name_width),
        "\u{2500}".repeat(23),
    ));

    for code_ref in &refs {
        let lines = format_file_spec_lines(code_ref.line_start, code_ref.line_end);
        let name = code_ref.name.as_deref().unwrap_or("-");
        let description = code_ref.description.as_deref().unwrap_or("");
        out.push_str(&format!(
            "{:<fw$}  {:<lw$}  {:<nw$}  {}\n",
            code_ref.path,
            lines,
            name,
            description,
            fw = file_width,
            lw = lines_width,
            nw = name_width,
        ));
    }

    world.set_output(out);
}

fn format_file_spec_lines(line_start: Option<u32>, line_end: Option<u32>) -> String {
    match (line_start, line_end) {
        (Some(start), Some(end)) => format!("L{}-{}", start, end),
        (Some(line), None) => format!("L{}", line),
        _ => "-".to_string(),
    }
}

// ---------------------------------------------------------------------------
// When steps: unref (remove) scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I unref {string}")]
async fn unref_by_file(world: &mut SmokeWorld, file: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for unref");

    let refs_to_remove: Vec<usize> = task
        .code_refs
        .iter()
        .enumerate()
        .filter(|(_, r)| r.path == file)
        .map(|(i, _)| i)
        .collect();

    let removed_count = refs_to_remove.len();

    if removed_count > 0 {
        service
            .remove_code_refs(&task_id, Some(refs_to_remove))
            .await
            .expect("failed to remove code refs");
    }

    if removed_count == 0 {
        world.set_output(format!(
            "Warning: No references to {} in task: {}",
            file, task_id
        ));
    } else {
        world.set_output(format!(
            "Removed {} reference(s) to {} from task: {}",
            removed_count, file, task_id
        ));
    }
}

#[when("I unref --all")]
async fn unref_all(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for unref --all");

    let original_count = task.code_refs.len();

    if original_count > 0 {
        service
            .remove_code_refs(&task_id, None)
            .await
            .expect("failed to remove all code refs");
    }

    if original_count == 0 {
        world.set_output(format!("No references to remove from task: {}", task_id));
    } else {
        world.set_output(format!(
            "Removed all {} reference(s) from task: {}",
            original_count, task_id
        ));
    }
}

// ---------------------------------------------------------------------------
// When steps: criterion-ref scenarios
// ---------------------------------------------------------------------------

#[when(expr = "I add a criterion-ref {int} {string}")]
async fn add_criterion_ref(world: &mut SmokeWorld, index: usize, file_spec: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let parsed = parse_file_spec(&file_spec).expect("invalid file spec in criterion-ref");

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for criterion-ref");

    let mut criteria: Vec<(usize, &vertebrae_core::Section)> = task
        .sections
        .iter()
        .enumerate()
        .filter(|(_, s)| s.section_type == SectionType::TestingCriterion)
        .collect();
    criteria.sort_by_key(|(_, s)| s.order.unwrap_or(u32::MAX));

    let criterion_idx = index - 1;
    let (original_idx, criterion) = criteria[criterion_idx];
    let criterion_content = criterion.content.clone();

    let code_ref = vertebrae_core::CodeRef {
        path: parsed.path.clone(),
        line_start: parsed.line_start,
        line_end: parsed.line_end,
        name: None,
        description: None,
    };

    service
        .append_section_ref(&task_id, original_idx, &code_ref)
        .await
        .expect("failed to append criterion ref");

    let location = format_file_spec(&parsed.path, parsed.line_start, parsed.line_end);
    world.set_output(format!(
        "Added reference {} to testing criterion {} in {}: {}",
        location, index, task_id, criterion_content
    ));
}

#[when(expr = "I add a criterion-ref {int} {string} --name {string}")]
async fn add_criterion_ref_with_name(
    world: &mut SmokeWorld,
    index: usize,
    file_spec: String,
    name: String,
) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();
    let service = world.task_service();

    let parsed = parse_file_spec(&file_spec).expect("invalid file spec in criterion-ref");

    let task = service
        .get_task(&task_id)
        .await
        .expect("failed to get task for criterion-ref");

    let mut criteria: Vec<(usize, &vertebrae_core::Section)> = task
        .sections
        .iter()
        .enumerate()
        .filter(|(_, s)| s.section_type == SectionType::TestingCriterion)
        .collect();
    criteria.sort_by_key(|(_, s)| s.order.unwrap_or(u32::MAX));

    let criterion_idx = index - 1;
    let (original_idx, criterion) = criteria[criterion_idx];
    let criterion_content = criterion.content.clone();

    let code_ref = vertebrae_core::CodeRef {
        path: parsed.path.clone(),
        line_start: parsed.line_start,
        line_end: parsed.line_end,
        name: Some(name.clone()),
        description: None,
    };

    service
        .append_section_ref(&task_id, original_idx, &code_ref)
        .await
        .expect("failed to append criterion ref with name");

    let location = format_file_spec(&parsed.path, parsed.line_start, parsed.line_end);
    world.set_output(format!(
        "Added reference {} to testing criterion {} in {}: {} [{}]",
        location, index, task_id, criterion_content, name
    ));
}

#[when(expr = "I attempt to add a criterion-ref {int} {string}")]
async fn attempt_add_criterion_ref(world: &mut SmokeWorld, index: usize, file_spec: String) {
    let task_id = world.task_id.as_ref().expect("no task ID stored").clone();

    if index == 0 {
        world.set_service_error(ServiceError::validation_failed(
            "Testing criterion index must be 1 or greater",
        ));
        return;
    }

    let parsed = match parse_file_spec(&file_spec) {
        Ok(p) => p,
        Err(msg) => {
            world.set_service_error(ServiceError::validation_failed(format!(
                "{}: {}",
                file_spec, msg
            )));
            return;
        }
    };

    let service = world.task_service();

    let task = match service.get_task(&task_id).await {
        Ok(t) => t,
        Err(e) => {
            world.set_service_error(e);
            return;
        }
    };

    let mut criteria: Vec<(usize, &vertebrae_core::Section)> = task
        .sections
        .iter()
        .enumerate()
        .filter(|(_, s)| s.section_type == SectionType::TestingCriterion)
        .collect();
    criteria.sort_by_key(|(_, s)| s.order.unwrap_or(u32::MAX));

    let criterion_idx = index - 1;
    if criterion_idx >= criteria.len() {
        world.set_service_error(ServiceError::validation_failed(format!(
            "Testing criterion at index {} not found. Task has {} testing criterion(s).",
            index,
            criteria.len()
        )));
        return;
    }

    let (original_idx, criterion) = criteria[criterion_idx];
    let criterion_content = criterion.content.clone();

    let code_ref = vertebrae_core::CodeRef {
        path: parsed.path.clone(),
        line_start: parsed.line_start,
        line_end: parsed.line_end,
        name: None,
        description: None,
    };

    match service
        .append_section_ref(&task_id, original_idx, &code_ref)
        .await
    {
        Ok(()) => {
            let location = format_file_spec(&parsed.path, parsed.line_start, parsed.line_end);
            world.set_output(format!(
                "Added reference {} to testing criterion {} in {}: {}",
                location, index, task_id, criterion_content
            ));
        }
        Err(e) => {
            world.set_service_error(e);
        }
    }
}

// ---------------------------------------------------------------------------
// Then steps: code ref assertions
// ---------------------------------------------------------------------------

#[then(expr = "the ref should have path {string} and line_start {int}")]
async fn ref_should_have_path_and_line_start(
    world: &mut SmokeWorld,
    expected_path: String,
    expected_line: u32,
) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let found = task
        .code_refs
        .iter()
        .any(|r| r.path == expected_path && r.line_start == Some(expected_line));

    assert!(
        found,
        "expected a code ref with path='{}' and line_start={}, but refs are: {:?}",
        expected_path, expected_line, task.code_refs
    );
}

#[then(expr = "the ref should have path {string} and line_start {int} and line_end {int}")]
async fn ref_should_have_path_and_line_range(
    world: &mut SmokeWorld,
    expected_path: String,
    expected_start: u32,
    expected_end: u32,
) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let found = task.code_refs.iter().any(|r| {
        r.path == expected_path
            && r.line_start == Some(expected_start)
            && r.line_end == Some(expected_end)
    });

    assert!(
        found,
        "expected a code ref with path='{}', line_start={}, line_end={}, but refs are: {:?}",
        expected_path, expected_start, expected_end, task.code_refs
    );
}

#[then(expr = "the ref should have description {string}")]
async fn ref_should_have_description(world: &mut SmokeWorld, expected_desc: String) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let found = task
        .code_refs
        .iter()
        .any(|r| r.description.as_deref() == Some(&expected_desc));

    assert!(
        found,
        "expected a code ref with description='{}', but refs are: {:?}",
        expected_desc, task.code_refs
    );
}

#[then(expr = "the task should have {int} refs")]
async fn task_should_have_n_refs(world: &mut SmokeWorld, expected_count: usize) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    assert_eq!(
        task.code_refs.len(),
        expected_count,
        "expected {} refs, but found {}. Refs: {:?}",
        expected_count,
        task.code_refs.len(),
        task.code_refs
    );
}

#[then(expr = "the refs should appear in order: {string}, {string}, {string}")]
async fn refs_should_appear_in_order(
    world: &mut SmokeWorld,
    first: String,
    second: String,
    third: String,
) {
    let service = world.task_service();
    let task_id = world.task_id.as_ref().expect("no task ID stored");
    let task = service.get_task(task_id).await.expect("failed to get task");

    let mut refs = task.code_refs.clone();
    refs.sort_by(|a, b| match a.path.cmp(&b.path) {
        std::cmp::Ordering::Equal => {
            let a_line = a.line_start.unwrap_or(0);
            let b_line = b.line_start.unwrap_or(0);
            a_line.cmp(&b_line)
        }
        other => other,
    });

    let actual_specs: Vec<String> = refs
        .iter()
        .map(|r| format_file_spec(&r.path, r.line_start, r.line_end))
        .collect();

    let expected = vec![first.clone(), second.clone(), third.clone()];
    assert_eq!(
        actual_specs, expected,
        "expected refs in order {:?}, but got {:?}",
        expected, actual_specs
    );
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
