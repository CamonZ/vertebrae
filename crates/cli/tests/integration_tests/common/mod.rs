//! Test infrastructure for integration tests
//!
//! Provides isolated database setup/teardown and CLI command execution helpers.
//! Each test gets its own database instance to ensure no shared state.

#![allow(dead_code)] // Test helpers may not all be used yet

use std::path::PathBuf;
use vertebrae_cli::commands::{
    AddCommand, BlockersCommand, CriterionRefCommand, DeleteCommand, DependCommand, ExportCommand,
    ListCommand, PathCommand, ReadyCommand, RefCommand, SectionCommand, ShowCommand,
    StepDoneCommand, TransitionToCommand, UndependCommand, UnrefCommand, UnsectionCommand,
    UpdateCommand,
    transition_to::TargetStatus,
    workflow::{
        ParsedStep, WorkflowAddCommand, WorkflowAdvanceCommand, WorkflowAssignCommand,
        WorkflowDeleteCommand, WorkflowListCommand, WorkflowRejectCommand, WorkflowRetreatCommand,
        WorkflowShowCommand, WorkflowUnassignCommand, WorkflowUpdateCommand,
    },
};
use vertebrae_core::{DefaultTaskService, DefaultWorkflowService};
use vertebrae_db::{AgentConfig, CodeRef, Database, Level, Priority, Section, SectionType};

/// Test context containing an isolated database, service, and temp directory
pub struct TestContext {
    pub service: DefaultTaskService,
    pub workflow_service: DefaultWorkflowService,
    pub temp_dir: PathBuf,
}

impl TestContext {
    /// Create a new test context with an isolated database.
    ///
    /// Each call creates a uniquely named temp directory using process ID,
    /// thread ID, and nanosecond timestamp to guarantee isolation.
    pub async fn new() -> Self {
        let temp_dir = std::env::temp_dir().join(format!(
            "vtb-integration-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let db = Database::connect(&temp_dir).await.unwrap();
        db.init().await.unwrap();
        let service = DefaultTaskService::new(db.clone());
        let workflow_service = DefaultWorkflowService::new(db);

        Self {
            service,
            workflow_service,
            temp_dir,
        }
    }

    /// Create a new test context with a specific suffix for debugging.
    pub async fn with_name(name: &str) -> Self {
        let temp_dir = std::env::temp_dir().join(format!(
            "vtb-integration-{}-{}-{:?}-{}",
            name,
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let db = Database::connect(&temp_dir).await.unwrap();
        db.init().await.unwrap();
        let service = DefaultTaskService::new(db.clone());
        let workflow_service = DefaultWorkflowService::new(db);

        Self {
            service,
            workflow_service,
            temp_dir,
        }
    }

    /// Get a reference to the database for direct queries in tests
    pub fn db(&self) -> &Database {
        self.service.database()
    }

    /// Clean up the test database directory.
    #[allow(dead_code)]
    pub fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.temp_dir);
    }
}

impl Drop for TestContext {
    fn drop(&mut self) {
        // Auto-cleanup on drop
        let _ = std::fs::remove_dir_all(&self.temp_dir);
    }
}

// =============================================================================
// Command Builder Helpers
// =============================================================================

/// Create an AddCommand with default optional fields filled in.
pub fn add_cmd(title: &str) -> AddCommand {
    AddCommand {
        title: title.to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    }
}

/// Create an AddCommand with parent.
pub fn add_cmd_with_parent(title: &str, parent: &str) -> AddCommand {
    AddCommand {
        title: title.to_string(),
        level: None,
        description: None,
        priority: None,
        tags: vec![],
        parent: Some(parent.to_string()),
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    }
}

/// Create an AddCommand with level, description, and parent.
pub fn add_cmd_full(
    title: &str,
    level: Option<Level>,
    description: Option<&str>,
    parent: Option<&str>,
) -> AddCommand {
    AddCommand {
        title: title.to_string(),
        level,
        description: description.map(String::from),
        priority: None,
        tags: vec![],
        parent: parent.map(String::from),
        depends_on: vec![],
        needs_review: false,
        workflow: None,
    }
}

/// Create a transition-to command for triage (backlog -> todo).
/// By default skips validation for test convenience. Use `triage_cmd_with_validation` for validation tests.
pub fn triage_cmd(id: &str) -> TransitionToCommand {
    TransitionToCommand {
        id: id.to_string(),
        target: TargetStatus::Todo,
        reason: None,
        force: false,
        skip_validation: true, // Skip validation by default for existing tests
    }
}

/// Create a transition-to command for triage with validation enabled.
#[allow(dead_code)]
pub fn triage_cmd_with_validation(id: &str) -> TransitionToCommand {
    TransitionToCommand {
        id: id.to_string(),
        target: TargetStatus::Todo,
        reason: None,
        force: false,
        skip_validation: false,
    }
}

/// Create a transition-to command for triage with --force flag.
#[allow(dead_code)]
pub fn triage_cmd_force(id: &str) -> TransitionToCommand {
    TransitionToCommand {
        id: id.to_string(),
        target: TargetStatus::Todo,
        reason: None,
        force: true,
        skip_validation: false,
    }
}

/// Create a transition-to command for start (todo -> in_progress).
pub fn start_cmd(id: &str) -> TransitionToCommand {
    TransitionToCommand {
        id: id.to_string(),
        target: TargetStatus::InProgress,
        reason: None,
        force: false,
        skip_validation: false,
    }
}

/// Create a transition-to command for submit (in_progress -> pending_review).
pub fn submit_cmd(id: &str) -> TransitionToCommand {
    TransitionToCommand {
        id: id.to_string(),
        target: TargetStatus::PendingReview,
        reason: None,
        force: false,
        skip_validation: false,
    }
}

/// Create a transition-to command for done (pending_review -> done).
pub fn done_cmd(id: &str) -> TransitionToCommand {
    TransitionToCommand {
        id: id.to_string(),
        target: TargetStatus::Done,
        reason: None,
        force: false,
        skip_validation: false,
    }
}

/// Create a transition-to command for reject (todo -> rejected).
pub fn reject_cmd(id: &str) -> TransitionToCommand {
    TransitionToCommand {
        id: id.to_string(),
        target: TargetStatus::Rejected,
        reason: None,
        force: false,
        skip_validation: true, // Skip validation by default for basic transition tests
    }
}

/// Create a transition-to command for reject with reason.
#[allow(dead_code)]
pub fn reject_cmd_with_reason(id: &str, reason: &str) -> TransitionToCommand {
    TransitionToCommand {
        id: id.to_string(),
        target: TargetStatus::Rejected,
        reason: Some(reason.to_string()),
        force: false,
        skip_validation: false,
    }
}

/// Create a depend command.
pub fn depend_cmd(id: &str, blocker_id: &str) -> DependCommand {
    DependCommand {
        id: id.to_string(),
        blocker_id: blocker_id.to_string(),
    }
}

/// Create a section command.
pub fn section_cmd(id: &str, section_type: SectionType, content: &str) -> SectionCommand {
    SectionCommand {
        id: id.to_string(),
        section_type,
        content: content.to_string(),
    }
}

/// Create a ref command.
pub fn ref_cmd(id: &str, file_spec: &str) -> RefCommand {
    RefCommand {
        id: id.to_string(),
        file_spec: file_spec.to_string(),
        name: None,
        description: None,
    }
}

/// Create a ref command with name and description.
pub fn ref_cmd_full(
    id: &str,
    file_spec: &str,
    name: Option<&str>,
    description: Option<&str>,
) -> RefCommand {
    RefCommand {
        id: id.to_string(),
        file_spec: file_spec.to_string(),
        name: name.map(String::from),
        description: description.map(String::from),
    }
}

/// Create a delete command.
pub fn delete_cmd(id: &str, cascade: bool) -> DeleteCommand {
    DeleteCommand {
        id: id.to_string(),
        cascade,
        force: true,
    }
}

/// Create a list command with defaults.
pub fn list_cmd() -> ListCommand {
    ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        root: false,
        parent: None,
        all: false,
        search: None,
        flat: false,
    }
}

/// Create a list command with a search query.
pub fn list_cmd_with_search(search: &str) -> ListCommand {
    ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        root: false,
        parent: None,
        all: false,
        search: Some(search.to_string()),
        flat: false,
    }
}

/// Create an export command.
pub fn export_cmd(output: Option<PathBuf>) -> ExportCommand {
    ExportCommand { output }
}

// =============================================================================
// Workflow Command Helpers
// =============================================================================

/// Create a workflow add command with a single step.
pub fn workflow_add_cmd(name: &str, step_name: &str, model: &str) -> WorkflowAddCommand {
    WorkflowAddCommand {
        name: name.to_string(),
        description: None,
        steps: vec![ParsedStep {
            name: step_name.to_string(),
            agent_config: AgentConfig::new().with_model(model),
        }],
    }
}

/// Create a workflow list command.
#[allow(dead_code)]
pub fn workflow_list_cmd() -> WorkflowListCommand {
    WorkflowListCommand {}
}

/// Create a workflow show command.
#[allow(dead_code)]
pub fn workflow_show_cmd(id: &str) -> WorkflowShowCommand {
    WorkflowShowCommand { id: id.to_string() }
}

/// Create a workflow update command.
#[allow(dead_code)]
pub fn workflow_update_cmd(
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
) -> WorkflowUpdateCommand {
    WorkflowUpdateCommand {
        id: id.to_string(),
        name: name.map(String::from),
        description: description.map(String::from),
        clear_description: false,
    }
}

/// Create a workflow delete command.
#[allow(dead_code)]
pub fn workflow_delete_cmd(id: &str) -> WorkflowDeleteCommand {
    WorkflowDeleteCommand { id: id.to_string() }
}

/// Create a workflow assign command.
#[allow(dead_code)]
pub fn workflow_assign_cmd(task_id: &str, workflow_id: &str) -> WorkflowAssignCommand {
    WorkflowAssignCommand {
        task_id: task_id.to_string(),
        workflow_id: workflow_id.to_string(),
    }
}

/// Create a workflow unassign command.
#[allow(dead_code)]
pub fn workflow_unassign_cmd(task_id: &str) -> WorkflowUnassignCommand {
    WorkflowUnassignCommand {
        task_id: task_id.to_string(),
    }
}

/// Create a workflow advance command.
#[allow(dead_code)]
pub fn workflow_advance_cmd(task_id: &str) -> WorkflowAdvanceCommand {
    WorkflowAdvanceCommand {
        task_id: task_id.to_string(),
    }
}

/// Create a workflow retreat command.
#[allow(dead_code)]
pub fn workflow_retreat_cmd(task_id: &str) -> WorkflowRetreatCommand {
    WorkflowRetreatCommand {
        task_id: task_id.to_string(),
    }
}

/// Create a workflow reject command.
#[allow(dead_code)]
pub fn workflow_reject_cmd(task_id: &str) -> WorkflowRejectCommand {
    WorkflowRejectCommand {
        task_id: task_id.to_string(),
    }
}

/// Extract workflow ID from "Created workflow: {id}" message.
#[allow(dead_code)]
pub fn extract_workflow_id(msg: &str) -> String {
    msg.strip_prefix("Created workflow: ")
        .unwrap_or(msg)
        .to_string()
}

/// Helper to check if a workflow exists.
#[allow(dead_code)]
pub async fn workflow_exists(db: &Database, id: &str) -> bool {
    db.workflows().exists(id).await.unwrap_or(false)
}

// =============================================================================
// Additional Command Builders
// =============================================================================

/// Create a show command.
pub fn show_cmd(id: &str) -> ShowCommand {
    ShowCommand { id: id.to_string() }
}

/// Create a blockers command.
pub fn blockers_cmd(id: &str) -> BlockersCommand {
    BlockersCommand {
        id: id.to_string(),
        depth: None,
        all: false,
    }
}

/// Create a blockers command with options.
pub fn blockers_cmd_full(id: &str, depth: Option<usize>, all: bool) -> BlockersCommand {
    BlockersCommand {
        id: id.to_string(),
        depth,
        all,
    }
}

/// Create a path command.
pub fn path_cmd(from_id: &str, to_id: &str) -> PathCommand {
    PathCommand {
        from_id: from_id.to_string(),
        to_id: to_id.to_string(),
    }
}

/// Create a ready command.
pub fn ready_cmd() -> ReadyCommand {
    ReadyCommand {}
}

/// Create an update command with title only.
pub fn update_cmd(id: &str) -> UpdateCommand {
    UpdateCommand {
        id: id.to_string(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        edit_section: None,
        remove_section: None,
    }
}

/// Create an update command with title change.
pub fn update_cmd_with_title(id: &str, title: &str) -> UpdateCommand {
    UpdateCommand {
        id: id.to_string(),
        title: Some(title.to_string()),
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        edit_section: None,
        remove_section: None,
    }
}

/// Create an update command with description change.
pub fn update_cmd_with_description(id: &str, description: Option<&str>) -> UpdateCommand {
    UpdateCommand {
        id: id.to_string(),
        title: None,
        description: description.map(String::from),
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        edit_section: None,
        remove_section: None,
    }
}

/// Create an update command with parent change.
pub fn update_cmd_with_parent(id: &str, parent: Option<&str>) -> UpdateCommand {
    UpdateCommand {
        id: id.to_string(),
        title: None,
        description: None,
        priority: None,
        add_tags: vec![],
        remove_tags: vec![],
        parent: parent.map(String::from),
        edit_section: None,
        remove_section: None,
    }
}

/// Create an update command with priority change.
pub fn update_cmd_with_priority(id: &str, priority: Priority) -> UpdateCommand {
    UpdateCommand {
        id: id.to_string(),
        title: None,
        description: None,
        priority: Some(priority),
        add_tags: vec![],
        remove_tags: vec![],
        parent: None,
        edit_section: None,
        remove_section: None,
    }
}

/// Create an update command with tag changes.
pub fn update_cmd_with_tags(
    id: &str,
    add_tags: Vec<&str>,
    remove_tags: Vec<&str>,
) -> UpdateCommand {
    UpdateCommand {
        id: id.to_string(),
        title: None,
        description: None,
        priority: None,
        add_tags: add_tags.into_iter().map(String::from).collect(),
        remove_tags: remove_tags.into_iter().map(String::from).collect(),
        parent: None,
        edit_section: None,
        remove_section: None,
    }
}

/// Create an undepend command.
pub fn undepend_cmd(id: &str, blocker_id: &str) -> UndependCommand {
    UndependCommand {
        id: id.to_string(),
        blocker_id: blocker_id.to_string(),
    }
}

/// Create an unsection command to remove a specific section by index.
pub fn unsection_cmd(id: &str, section_type: SectionType, index: u32) -> UnsectionCommand {
    UnsectionCommand {
        id: id.to_string(),
        section_type: Some(section_type),
        index: Some(index),
        all: false,
    }
}

/// Create an unsection command to remove all sections of a type.
pub fn unsection_cmd_all_of_type(id: &str, section_type: SectionType) -> UnsectionCommand {
    UnsectionCommand {
        id: id.to_string(),
        section_type: Some(section_type),
        index: None,
        all: true,
    }
}

/// Create an unsection command to remove all sections.
pub fn unsection_cmd_all(id: &str) -> UnsectionCommand {
    UnsectionCommand {
        id: id.to_string(),
        section_type: None,
        index: None,
        all: true,
    }
}

/// Create an unref command to remove references by file.
pub fn unref_cmd(id: &str, file: &str) -> UnrefCommand {
    UnrefCommand {
        id: id.to_string(),
        file: Some(file.to_string()),
        all: false,
    }
}

/// Create an unref command to remove all references.
pub fn unref_cmd_all(id: &str) -> UnrefCommand {
    UnrefCommand {
        id: id.to_string(),
        file: None,
        all: true,
    }
}

/// Create a step-done command.
pub fn step_done_cmd(id: &str, index: usize) -> StepDoneCommand {
    StepDoneCommand {
        id: id.to_string(),
        index,
    }
}

/// Create a criterion-ref command.
pub fn criterion_ref_cmd(id: &str, index: usize, file_spec: &str) -> CriterionRefCommand {
    CriterionRefCommand {
        id: id.to_string(),
        index,
        file_spec: file_spec.to_string(),
        name: None,
        description: None,
    }
}

/// Create a criterion-ref command with name and description.
pub fn criterion_ref_cmd_full(
    id: &str,
    index: usize,
    file_spec: &str,
    name: Option<&str>,
    description: Option<&str>,
) -> CriterionRefCommand {
    CriterionRefCommand {
        id: id.to_string(),
        index,
        file_spec: file_spec.to_string(),
        name: name.map(String::from),
        description: description.map(String::from),
    }
}

/// Create a list command with status filter.
pub fn list_cmd_with_status(statuses: Vec<&str>) -> ListCommand {
    let parsed_statuses: Vec<String> = statuses.into_iter().map(|s| s.to_lowercase()).collect();
    ListCommand {
        levels: vec![],
        statuses: parsed_statuses,
        priorities: vec![],
        tags: vec![],
        root: false,
        parent: None,
        all: false,
        search: None,
        flat: false,
    }
}

/// Create a list command with level filter.
pub fn list_cmd_with_level(levels: Vec<Level>) -> ListCommand {
    ListCommand {
        levels,
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        root: false,
        parent: None,
        all: false,
        search: None,
        flat: false,
    }
}

/// Create a list command with tag filter.
pub fn list_cmd_with_tags(tags: Vec<&str>) -> ListCommand {
    ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: tags.into_iter().map(String::from).collect(),
        root: false,
        parent: None,
        all: false,
        search: None,
        flat: false,
    }
}

/// Create a list command with root filter.
pub fn list_cmd_root() -> ListCommand {
    ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        root: true,
        parent: None,
        all: false,
        search: None,
        flat: false,
    }
}

/// Create a list command with parent filter.
pub fn list_cmd_with_parent(parent: &str) -> ListCommand {
    ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        root: false,
        parent: Some(parent.to_string()),
        all: false,
        search: None,
        flat: false,
    }
}

/// Create a list command with flat output.
pub fn list_cmd_flat() -> ListCommand {
    ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        root: false,
        parent: None,
        all: false,
        search: None,
        flat: true,
    }
}

/// Create a list command with --all flag.
pub fn list_cmd_all() -> ListCommand {
    ListCommand {
        levels: vec![],
        statuses: vec![],
        priorities: vec![],
        tags: vec![],
        root: false,
        parent: None,
        all: true,
        search: None,
        flat: false,
    }
}

// =============================================================================
// Database Setup Helpers
// =============================================================================

/// Helper to create a task directly in the database for test setup.
pub async fn create_task(db: &Database, id: &str, title: &str, level: &str, status: &str) {
    let query = format!(
        r#"CREATE task:{} SET
            title = "{}",
            level = "{}",
            status = "{}",
            tags = [],
            sections = [],
            refs = []"#,
        id, title, level, status
    );
    db.client().query(&query).await.unwrap();
}

/// Helper to create a task with description.
#[allow(dead_code)]
pub async fn create_task_with_description(
    db: &Database,
    id: &str,
    title: &str,
    level: &str,
    status: &str,
    description: &str,
) {
    let query = format!(
        r#"CREATE task:{} SET
            title = "{}",
            level = "{}",
            status = "{}",
            description = "{}",
            tags = [],
            sections = [],
            refs = []"#,
        id, title, level, status, description
    );
    db.client().query(&query).await.unwrap();
}

/// Helper to create a task with tags.
pub async fn create_task_with_tags(
    db: &Database,
    id: &str,
    title: &str,
    level: &str,
    status: &str,
    tags: &[&str],
) {
    let tags_str = if tags.is_empty() {
        "[]".to_string()
    } else {
        format!(
            "[{}]",
            tags.iter()
                .map(|t| format!("\"{}\"", t))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let query = format!(
        r#"CREATE task:{} SET
            title = "{}",
            level = "{}",
            status = "{}",
            tags = {},
            sections = [],
            refs = []"#,
        id, title, level, status, tags_str
    );
    db.client().query(&query).await.unwrap();
}

/// Helper to create a child_of relationship (child -> parent).
pub async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
    let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
    db.client().query(&query).await.unwrap();
}

/// Helper to create a depends_on relationship (dependent -> dependency).
pub async fn create_depends_on(db: &Database, dependent_id: &str, dependency_id: &str) {
    let query = format!(
        "RELATE task:{} -> depends_on -> task:{}",
        dependent_id, dependency_id
    );
    db.client().query(&query).await.unwrap();
}

// =============================================================================
// Query Helpers
// =============================================================================

/// Helper to get task status.
pub async fn get_task_status(db: &Database, id: &str) -> Option<String> {
    db.tasks()
        .get(id)
        .await
        .unwrap()
        .map(|t| t.status.as_str().to_string())
}

/// Helper to get task level.
pub async fn get_task_level(db: &Database, id: &str) -> Option<String> {
    db.tasks()
        .get(id)
        .await
        .unwrap()
        .map(|t| t.level.as_str().to_string())
}

/// Helper to check if a dependency exists.
pub async fn dependency_exists(db: &Database, task_id: &str, blocker_id: &str) -> bool {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct EdgeRow {
        #[allow(dead_code)]
        id: surrealdb::sql::Thing,
    }

    let query = format!(
        "SELECT id FROM depends_on WHERE in = task:{} AND out = task:{}",
        task_id, blocker_id
    );
    let mut result = db.client().query(&query).await.unwrap();
    let edges: Vec<EdgeRow> = result.take(0).unwrap();
    !edges.is_empty()
}

/// Helper to check if a child_of relationship exists.
pub async fn child_of_exists(db: &Database, child_id: &str, parent_id: &str) -> bool {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct EdgeRow {
        #[allow(dead_code)]
        id: surrealdb::sql::Thing,
    }

    let query = format!(
        "SELECT id FROM child_of WHERE in = task:{} AND out = task:{}",
        child_id, parent_id
    );
    let mut result = db.client().query(&query).await.unwrap();
    let edges: Vec<EdgeRow> = result.take(0).unwrap();
    !edges.is_empty()
}

/// Helper to get number of tasks in database.
pub async fn count_tasks(db: &Database) -> usize {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct CountRow {
        count: usize,
    }

    let query = "SELECT count() as count FROM task GROUP ALL";
    let mut result = db.client().query(query).await.unwrap();
    let rows: Vec<CountRow> = result.take(0).unwrap();
    rows.first().map(|r| r.count).unwrap_or(0)
}

/// Helper to get all task IDs.
pub async fn get_all_task_ids(db: &Database) -> Vec<String> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct IdRow {
        id: surrealdb::sql::Thing,
    }

    let query = "SELECT id FROM task";
    let mut result = db.client().query(query).await.unwrap();
    let rows: Vec<IdRow> = result.take(0).unwrap();
    rows.into_iter().map(|r| r.id.id.to_raw()).collect()
}

/// Helper to get task sections.
pub async fn get_task_sections(db: &Database, id: &str) -> Vec<Section> {
    db.tasks()
        .get(id)
        .await
        .unwrap()
        .map(|t| t.sections)
        .unwrap_or_default()
}

/// Helper to get task code refs.
pub async fn get_task_refs(db: &Database, id: &str) -> Vec<CodeRef> {
    db.tasks()
        .get(id)
        .await
        .unwrap()
        .map(|t| t.code_refs)
        .unwrap_or_default()
}

/// Helper to get task title.
pub async fn get_task_title(db: &Database, id: &str) -> Option<String> {
    db.tasks().get(id).await.unwrap().map(|t| t.title)
}

/// Helper to get task description.
pub async fn get_task_description(db: &Database, id: &str) -> Option<String> {
    db.tasks()
        .get(id)
        .await
        .unwrap()
        .and_then(|t| t.description)
}

/// Helper to get task priority.
pub async fn get_task_priority(db: &Database, id: &str) -> Option<Priority> {
    db.tasks().get(id).await.unwrap().and_then(|t| t.priority)
}

/// Helper to get task tags.
pub async fn get_task_tags(db: &Database, id: &str) -> Vec<String> {
    db.tasks()
        .get(id)
        .await
        .unwrap()
        .map(|t| t.tags)
        .unwrap_or_default()
}

/// Helper to check if a task exists.
pub async fn task_exists(db: &Database, id: &str) -> bool {
    db.tasks().get(id).await.unwrap().is_some()
}

/// Helper to get step sections only (sorted by order).
pub async fn get_task_steps(db: &Database, id: &str) -> Vec<Section> {
    let sections = get_task_sections(db, id).await;
    let mut steps: Vec<Section> = sections
        .into_iter()
        .filter(|s| s.section_type == SectionType::Step)
        .collect();
    steps.sort_by_key(|s| s.order.unwrap_or(u32::MAX));
    steps
}

/// Helper to get sections of a specific type.
pub async fn get_task_sections_of_type(
    db: &Database,
    id: &str,
    section_type: SectionType,
) -> Vec<Section> {
    let sections = get_task_sections(db, id).await;
    let mut filtered: Vec<Section> = sections
        .into_iter()
        .filter(|s| s.section_type == section_type)
        .collect();
    filtered.sort_by_key(|s| s.order.unwrap_or(u32::MAX));
    filtered
}

/// Helper to count direct children of a task.
pub async fn count_children(db: &Database, parent_id: &str) -> usize {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct CountRow {
        count: usize,
    }

    let query = format!(
        "SELECT count() as count FROM child_of WHERE out = task:{} GROUP ALL",
        parent_id
    );
    let mut result = db.client().query(&query).await.unwrap();
    let rows: Vec<CountRow> = result.take(0).unwrap();
    rows.first().map(|r| r.count).unwrap_or(0)
}

/// Helper to count dependencies of a task.
pub async fn count_dependencies(db: &Database, task_id: &str) -> usize {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct CountRow {
        count: usize,
    }

    let query = format!(
        "SELECT count() as count FROM depends_on WHERE in = task:{} GROUP ALL",
        task_id
    );
    let mut result = db.client().query(&query).await.unwrap();
    let rows: Vec<CountRow> = result.take(0).unwrap();
    rows.first().map(|r| r.count).unwrap_or(0)
}

/// Helper to get parent task ID.
pub async fn get_parent_id(db: &Database, child_id: &str) -> Option<String> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct ParentRow {
        out: surrealdb::sql::Thing,
    }

    let query = format!("SELECT out FROM child_of WHERE in = task:{}", child_id);
    let mut result = db.client().query(&query).await.unwrap();
    let rows: Vec<ParentRow> = result.take(0).unwrap();
    rows.first().map(|r| r.out.id.to_raw())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_context_creates_isolated_database() {
        let ctx1 = TestContext::new().await;
        let ctx2 = TestContext::new().await;

        // Verify different temp directories
        assert_ne!(
            ctx1.temp_dir, ctx2.temp_dir,
            "Each context should have unique temp dir"
        );

        // Verify both are empty initially
        assert_eq!(count_tasks(ctx1.db()).await, 0);
        assert_eq!(count_tasks(ctx2.db()).await, 0);

        // Add task to ctx1
        create_task(ctx1.db(), "task1", "Test Task", "task", "todo").await;

        // Verify ctx1 has task but ctx2 does not
        assert_eq!(count_tasks(ctx1.db()).await, 1);
        assert_eq!(count_tasks(ctx2.db()).await, 0);
    }

    #[tokio::test]
    async fn test_context_with_name() {
        let ctx = TestContext::with_name("custom").await;
        assert!(ctx.temp_dir.to_string_lossy().contains("custom"));
    }

    #[tokio::test]
    async fn test_relationship_helpers() {
        let ctx = TestContext::new().await;

        create_task(ctx.db(), "parent", "Parent", "epic", "todo").await;
        create_task(ctx.db(), "child", "Child", "ticket", "todo").await;
        create_task(ctx.db(), "blocker", "Blocker", "task", "done").await;

        create_child_of(ctx.db(), "child", "parent").await;
        create_depends_on(ctx.db(), "child", "blocker").await;

        assert!(child_of_exists(ctx.db(), "child", "parent").await);
        assert!(dependency_exists(ctx.db(), "child", "blocker").await);
    }

    #[tokio::test]
    async fn test_count_and_get_all_helpers() {
        let ctx = TestContext::new().await;

        assert_eq!(count_tasks(ctx.db()).await, 0);

        create_task(ctx.db(), "task1", "Task 1", "task", "todo").await;
        create_task(ctx.db(), "task2", "Task 2", "task", "todo").await;
        create_task(ctx.db(), "task3", "Task 3", "task", "todo").await;

        assert_eq!(count_tasks(ctx.db()).await, 3);

        let ids = get_all_task_ids(ctx.db()).await;
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&"task1".to_string()));
        assert!(ids.contains(&"task2".to_string()));
        assert!(ids.contains(&"task3".to_string()));
    }
}
