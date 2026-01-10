//! Test infrastructure for integration tests
//!
//! Provides isolated database setup/teardown and CLI command execution helpers.
//! Each test gets its own database instance to ensure no shared state.

use std::path::PathBuf;
use vertebrae_cli::commands::{
    AddCommand, DeleteCommand, DependCommand, ExportCommand, ListCommand, RefCommand,
    SectionCommand, TransitionToCommand, transition_to::TargetStatus,
};
use vertebrae_db::{Database, DbError, Level, SectionType};

/// Test context containing an isolated database and temp directory
pub struct TestContext {
    pub db: Database,
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

        Self { db, temp_dir }
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

        Self { db, temp_dir }
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
    }
}

/// Create an AddCommand with a specific level.
#[allow(dead_code)]
pub fn add_cmd_with_level(title: &str, level: Level) -> AddCommand {
    AddCommand {
        title: title.to_string(),
        level: Some(level),
        description: None,
        priority: None,
        tags: vec![],
        parent: None,
        depends_on: vec![],
        needs_review: false,
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
    }
}

/// Execute add command and return the task ID.
#[allow(dead_code)]
pub async fn execute_add(db: &Database, cmd: AddCommand) -> Result<String, DbError> {
    cmd.execute(db).await
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
        skip_validation: false,
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
        children: None,
        all: false,
        search: None,
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
        children: None,
        all: false,
        search: Some(search.to_string()),
    }
}

/// Create an export command.
pub fn export_cmd(output: Option<PathBuf>) -> ExportCommand {
    ExportCommand { output }
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

/// Helper to check if a task exists.
pub async fn task_exists(db: &Database, id: &str) -> bool {
    db.tasks().get(id).await.unwrap().is_some()
}

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
    rows.into_iter().map(|r| r.id.id.to_string()).collect()
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
        assert_eq!(count_tasks(&ctx1.db).await, 0);
        assert_eq!(count_tasks(&ctx2.db).await, 0);

        // Add task to ctx1
        create_task(&ctx1.db, "task1", "Test Task", "task", "todo").await;

        // Verify ctx1 has task but ctx2 does not
        assert_eq!(count_tasks(&ctx1.db).await, 1);
        assert_eq!(count_tasks(&ctx2.db).await, 0);
    }

    #[tokio::test]
    async fn test_context_with_name() {
        let ctx = TestContext::with_name("custom").await;
        assert!(ctx.temp_dir.to_string_lossy().contains("custom"));
    }

    #[tokio::test]
    async fn test_create_task_helper() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "abc123", "My Task", "ticket", "backlog").await;

        assert!(task_exists(&ctx.db, "abc123").await);
        assert_eq!(
            get_task_status(&ctx.db, "abc123").await,
            Some("backlog".to_string())
        );
        assert_eq!(
            get_task_level(&ctx.db, "abc123").await,
            Some("ticket".to_string())
        );
    }

    #[tokio::test]
    async fn test_relationship_helpers() {
        let ctx = TestContext::new().await;

        create_task(&ctx.db, "parent", "Parent", "epic", "todo").await;
        create_task(&ctx.db, "child", "Child", "ticket", "todo").await;
        create_task(&ctx.db, "blocker", "Blocker", "task", "done").await;

        create_child_of(&ctx.db, "child", "parent").await;
        create_depends_on(&ctx.db, "child", "blocker").await;

        assert!(child_of_exists(&ctx.db, "child", "parent").await);
        assert!(dependency_exists(&ctx.db, "child", "blocker").await);
    }

    #[tokio::test]
    async fn test_count_and_get_all_helpers() {
        let ctx = TestContext::new().await;

        assert_eq!(count_tasks(&ctx.db).await, 0);

        create_task(&ctx.db, "task1", "Task 1", "task", "todo").await;
        create_task(&ctx.db, "task2", "Task 2", "task", "todo").await;
        create_task(&ctx.db, "task3", "Task 3", "task", "todo").await;

        assert_eq!(count_tasks(&ctx.db).await, 3);

        let ids = get_all_task_ids(&ctx.db).await;
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&"task1".to_string()));
        assert!(ids.contains(&"task2".to_string()));
        assert!(ids.contains(&"task3".to_string()));
    }
}
