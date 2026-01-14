//! Database schema initialization for Vertebrae
//!
//! Defines the SurrealDB schema for tasks, sections, code references,
//! and graph edges (hierarchy and dependencies).

use crate::error::DbError;
use crate::models::Task;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;

/// SQL statements for schema initialization
mod sql {
    /// Define the task table with all fields
    pub const DEFINE_TASK_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS task SCHEMAFULL;

        DEFINE FIELD title ON task TYPE string;

        DEFINE FIELD description ON task TYPE option<string>;

        DEFINE FIELD level ON task TYPE string
            ASSERT $value IN ["epic", "ticket", "task"];

        DEFINE FIELD status ON task TYPE string
            ASSERT $value IN ["backlog", "todo", "in_progress", "pending_review", "done", "rejected"];

        DEFINE FIELD priority ON task TYPE option<string>
            ASSERT $value IN [NONE, "low", "medium", "high", "critical"];

        DEFINE FIELD tags ON task TYPE array<string> DEFAULT [];

        DEFINE FIELD created_at ON task TYPE datetime DEFAULT time::now();

        DEFINE FIELD updated_at ON task TYPE datetime DEFAULT time::now();

        DEFINE FIELD started_at ON task TYPE option<datetime>;

        DEFINE FIELD completed_at ON task TYPE option<datetime>;

        DEFINE FIELD sections ON task FLEXIBLE TYPE array<object> DEFAULT [];

        DEFINE FIELD refs ON task FLEXIBLE TYPE array<object> DEFAULT [];

        DEFINE FIELD needs_human_review ON task TYPE option<bool> DEFAULT NONE;

        DEFINE FIELD workflow_id ON task TYPE option<record<workflow>>;

        DEFINE FIELD current_step ON task TYPE option<int>;
    "#;

    /// Define the child_of relation table for hierarchy edges
    pub const DEFINE_CHILD_OF_RELATION: &str = r#"
        DEFINE TABLE IF NOT EXISTS child_of TYPE RELATION IN task OUT task;
    "#;

    /// Define the depends_on relation table for dependency edges
    pub const DEFINE_DEPENDS_ON_RELATION: &str = r#"
        DEFINE TABLE IF NOT EXISTS depends_on TYPE RELATION IN task OUT task;
    "#;

    /// Define the workflow table with all fields
    pub const DEFINE_WORKFLOW_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS workflow SCHEMAFULL;

        DEFINE FIELD name ON workflow TYPE string;

        DEFINE FIELD description ON workflow TYPE option<string>;

        DEFINE FIELD steps ON workflow FLEXIBLE TYPE array<object> DEFAULT [];

        DEFINE FIELD metadata ON workflow FLEXIBLE TYPE object DEFAULT {};

        DEFINE FIELD on_done_workflow ON workflow TYPE option<string>;

        DEFINE FIELD on_reject_workflow ON workflow TYPE option<string>;

        DEFINE FIELD created_at ON workflow TYPE datetime DEFAULT time::now();

        DEFINE FIELD updated_at ON workflow TYPE datetime DEFAULT time::now();
    "#;

    /// Define the step_execution table for tracking workflow step execution history
    pub const DEFINE_STEP_EXECUTION_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS step_execution SCHEMAFULL;

        DEFINE FIELD task_id ON step_execution TYPE record<task>;

        DEFINE FIELD workflow_id ON step_execution TYPE record<workflow>;

        DEFINE FIELD step_name ON step_execution TYPE string;

        DEFINE FIELD started_at ON step_execution TYPE datetime DEFAULT time::now();

        DEFINE FIELD completed_at ON step_execution TYPE option<datetime>;

        DEFINE FIELD status ON step_execution TYPE string
            ASSERT $value IN ["in_progress", "completed", "failed"];
    "#;

    /// Define the session_log table for storing Claude session content during step execution
    pub const DEFINE_SESSION_LOG_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS session_log SCHEMAFULL;

        DEFINE FIELD step_execution_id ON session_log TYPE record<step_execution>;

        DEFINE FIELD content ON session_log TYPE string;

        DEFINE FIELD created_at ON session_log TYPE datetime DEFAULT time::now();
    "#;
}

/// Backfill section order values for existing sections with order: None.
///
/// This migration assigns sequential 0-based ordinals to sections that don't have one,
/// counting only sections of the same type that appear before them in the array.
/// This is idempotent - sections that already have ordinals are left unchanged.
async fn backfill_section_orders(client: &Surreal<Db>) -> Result<(), DbError> {
    // Query all tasks
    let mut result = client
        .query("SELECT * FROM task")
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    let tasks: Vec<Task> = result.take(0).map_err(|e| DbError::Schema(Box::new(e)))?;

    for task in tasks {
        let mut modified = false;
        let mut sections = task.sections.clone();

        // Track count of each section type as we iterate
        let mut type_counts: std::collections::HashMap<crate::models::SectionType, u32> =
            std::collections::HashMap::new();

        for section in &mut sections {
            if section.order.is_none() {
                // Assign ordinal based on count of same type seen so far
                let count = type_counts.entry(section.section_type.clone()).or_insert(0);
                section.order = Some(*count);
                modified = true;
            }
            // Increment count for this type
            *type_counts.entry(section.section_type.clone()).or_insert(0) += 1;
        }

        if modified {
            // Update the task with the new sections
            let sections_json =
                serde_json::to_string(&sections).map_err(|e| DbError::ValidationError {
                    message: format!("Failed to serialize sections: {}", e),
                })?;
            let query = format!(
                "UPDATE {} SET sections = {}",
                task.id.as_ref().map(|t| t.to_string()).unwrap_or_default(),
                sections_json
            );
            client
                .query(&query)
                .await
                .map_err(|e| DbError::Schema(Box::new(e)))?;
        }
    }

    Ok(())
}

/// Initialize the database schema.
///
/// Creates the task table, workflow table, step_execution table, session_log table,
/// child_of relation, and depends_on relation with all required fields and constraints.
///
/// This function is idempotent - it can be called multiple times safely
/// as it uses `IF NOT EXISTS` clauses.
///
/// # Arguments
///
/// * `client` - Reference to the SurrealDB client
///
/// # Errors
///
/// Returns `DbError::Schema` if any schema definition fails.
pub async fn init_schema(client: &Surreal<Db>) -> Result<(), DbError> {
    // Define the task table
    client
        .query(sql::DEFINE_TASK_TABLE)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the child_of relation for hierarchy
    client
        .query(sql::DEFINE_CHILD_OF_RELATION)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the depends_on relation for dependencies
    client
        .query(sql::DEFINE_DEPENDS_ON_RELATION)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the workflow table
    client
        .query(sql::DEFINE_WORKFLOW_TABLE)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the step_execution table for tracking workflow execution history
    client
        .query(sql::DEFINE_STEP_EXECUTION_TABLE)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the session_log table for storing Claude session content
    client
        .query(sql::DEFINE_SESSION_LOG_TABLE)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Migration: Backfill section order values for existing sections with order: None
    backfill_section_orders(client).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use surrealdb::engine::local::Mem;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Surreal<Db> {
        let client = Surreal::new::<Mem>(()).await.unwrap();
        client.use_ns("vertebrae").use_db("test").await.unwrap();
        client
    }

    #[tokio::test]
    async fn test_init_schema_succeeds() {
        let client = setup_test_db().await;

        let result = init_schema(&client).await;
        assert!(result.is_ok(), "Schema init failed: {:?}", result.err());
    }

    #[tokio::test]
    async fn test_init_schema_is_idempotent() {
        let client = setup_test_db().await;

        // First call
        let result1 = init_schema(&client).await;
        assert!(result1.is_ok(), "First init failed: {:?}", result1.err());

        // Second call should also succeed
        let result2 = init_schema(&client).await;
        assert!(result2.is_ok(), "Second init failed: {:?}", result2.err());

        // Third call for good measure
        let result3 = init_schema(&client).await;
        assert!(result3.is_ok(), "Third init failed: {:?}", result3.err());
    }

    #[tokio::test]
    async fn test_task_table_accepts_valid_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert a valid task
        let result = client
            .query(
                r#"
                CREATE task SET
                    title = "Test Task",
                    level = "task",
                    status = "todo",
                    priority = "high",
                    tags = ["test", "example"]
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Valid task insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_task_table_accepts_minimal_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert with only required fields
        let result = client
            .query(
                r#"
                CREATE task SET
                    title = "Minimal Task",
                    level = "task",
                    status = "done"
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Minimal task insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_task_table_rejects_invalid_level() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Try to insert with invalid level
        let mut response = client
            .query(
                r#"
                CREATE task SET
                    title = "Invalid Task",
                    level = "invalid_level",
                    status = "todo"
            "#,
            )
            .await
            .unwrap();

        // SurrealDB returns an error in the response, not as a query error
        let check: Result<Option<surrealdb::Value>, _> = response.take(0);
        assert!(check.is_err(), "Should reject invalid level");
    }

    #[tokio::test]
    async fn test_task_table_rejects_invalid_status() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Try to insert with invalid status
        let mut response = client
            .query(
                r#"
                CREATE task SET
                    title = "Invalid Task",
                    level = "task",
                    status = "unknown_status"
            "#,
            )
            .await
            .unwrap();

        let check: Result<Option<surrealdb::Value>, _> = response.take(0);
        assert!(check.is_err(), "Should reject invalid status");
    }

    #[tokio::test]
    async fn test_task_table_rejects_invalid_priority() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Try to insert with invalid priority
        let mut response = client
            .query(
                r#"
                CREATE task SET
                    title = "Invalid Task",
                    level = "task",
                    status = "todo",
                    priority = "super_urgent"
            "#,
            )
            .await
            .unwrap();

        let check: Result<Option<surrealdb::Value>, _> = response.take(0);
        assert!(check.is_err(), "Should reject invalid priority");
    }

    #[tokio::test]
    async fn test_task_with_null_priority_succeeds() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert with explicit NONE priority
        let result = client
            .query(
                r#"
                CREATE task SET
                    title = "No Priority Task",
                    level = "task",
                    status = "todo",
                    priority = NONE
            "#,
            )
            .await;

        assert!(result.is_ok(), "Null priority should be allowed");
    }

    #[tokio::test]
    async fn test_child_of_relation_between_tasks() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create parent and child tasks
        client
            .query(
                r#"
                CREATE task:parent SET
                    title = "Parent Epic",
                    level = "epic",
                    status = "in_progress";
                CREATE task:child SET
                    title = "Child Ticket",
                    level = "ticket",
                    status = "todo";
            "#,
            )
            .await
            .unwrap();

        // Create child_of relationship
        let result = client
            .query(
                r#"
                RELATE task:child -> child_of -> task:parent
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "child_of relation failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_depends_on_relation_between_tasks() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create two tasks
        client
            .query(
                r#"
                CREATE task:first SET
                    title = "First Task",
                    level = "task",
                    status = "done";
                CREATE task:second SET
                    title = "Second Task",
                    level = "task",
                    status = "backlog";
            "#,
            )
            .await
            .unwrap();

        // Create depends_on relationship
        let result = client
            .query(
                r#"
                RELATE task:second -> depends_on -> task:first
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "depends_on relation failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_task_with_sections() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert task with sections
        let result = client
            .query(
                r#"
                CREATE task SET
                    title = "Task with Sections",
                    level = "ticket",
                    status = "todo",
                    sections = [
                        { type: "goal", content: "Implement feature X" },
                        { type: "context", content: "Background information" },
                        { type: "step", content: "First step", order: 1 }
                    ]
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Task with sections failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_task_with_refs() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert task with code references
        let result = client
            .query(
                r#"
                CREATE task SET
                    title = "Task with Refs",
                    level = "task",
                    status = "todo",
                    refs = [
                        { path: "src/main.rs", line_start: 1, line_end: 50 },
                        { path: "README.md" }
                    ]
            "#,
            )
            .await;

        assert!(result.is_ok(), "Task with refs failed: {:?}", result.err());
    }

    #[tokio::test]
    async fn test_task_default_values() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert minimal task and check defaults
        client
            .query(
                r#"
                CREATE task:defaults SET
                    title = "Default Test",
                    level = "task",
                    status = "todo"
            "#,
            )
            .await
            .unwrap();

        // Query the task to verify defaults - use a struct for deserialization
        #[derive(Debug, serde::Deserialize)]
        struct TaskRow {
            tags: Vec<String>,
            sections: Vec<serde_json::Value>,
            refs: Vec<serde_json::Value>,
            created_at: String,
            updated_at: String,
        }

        let mut result = client
            .query("SELECT tags, sections, refs, created_at, updated_at FROM task:defaults")
            .await
            .unwrap();

        let task: Option<TaskRow> = result.take(0).unwrap();
        let task = task.expect("Task should exist");

        // Check that arrays defaulted to empty
        assert!(task.tags.is_empty(), "tags should default to empty");
        assert!(task.sections.is_empty(), "sections should default to empty");
        assert!(task.refs.is_empty(), "refs should default to empty");

        // Check that timestamps were set (not empty)
        assert!(!task.created_at.is_empty(), "created_at should be set");
        assert!(!task.updated_at.is_empty(), "updated_at should be set");
    }

    #[tokio::test]
    async fn test_all_valid_levels() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        for level in ["epic", "ticket", "task"] {
            let query = format!(
                r#"CREATE task SET title = "Test {}", level = "{}", status = "todo""#,
                level, level
            );
            let result = client.query(&query).await;
            assert!(result.is_ok(), "Level '{}' should be valid", level);
        }
    }

    #[tokio::test]
    async fn test_all_valid_statuses() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        for (i, status) in [
            "backlog",
            "todo",
            "in_progress",
            "pending_review",
            "done",
            "rejected",
        ]
        .iter()
        .enumerate()
        {
            let query = format!(
                r#"CREATE task SET title = "Test {}", level = "task", status = "{}""#,
                i, status
            );
            let result = client.query(&query).await;
            assert!(result.is_ok(), "Status '{}' should be valid", status);
        }
    }

    #[tokio::test]
    async fn test_all_valid_priorities() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        for (i, priority) in ["low", "medium", "high", "critical"].iter().enumerate() {
            let query = format!(
                r#"CREATE task SET title = "Test {}", level = "task", status = "todo", priority = "{}""#,
                i, priority
            );
            let result = client.query(&query).await;
            assert!(result.is_ok(), "Priority '{}' should be valid", priority);
        }
    }

    // Test SQL constant accessibility
    #[test]
    fn test_sql_constants_defined() {
        assert!(!sql::DEFINE_TASK_TABLE.is_empty());
        assert!(!sql::DEFINE_CHILD_OF_RELATION.is_empty());
        assert!(!sql::DEFINE_DEPENDS_ON_RELATION.is_empty());
    }

    #[test]
    fn test_sql_contains_expected_definitions() {
        assert!(sql::DEFINE_TASK_TABLE.contains("DEFINE TABLE"));
        assert!(sql::DEFINE_TASK_TABLE.contains("task"));
        assert!(sql::DEFINE_TASK_TABLE.contains("SCHEMAFULL"));
        assert!(sql::DEFINE_TASK_TABLE.contains("title"));
        assert!(sql::DEFINE_TASK_TABLE.contains("level"));
        assert!(sql::DEFINE_TASK_TABLE.contains("status"));

        assert!(sql::DEFINE_CHILD_OF_RELATION.contains("RELATION"));
        assert!(sql::DEFINE_CHILD_OF_RELATION.contains("child_of"));

        assert!(sql::DEFINE_DEPENDS_ON_RELATION.contains("RELATION"));
        assert!(sql::DEFINE_DEPENDS_ON_RELATION.contains("depends_on"));
    }

    #[test]
    fn test_sql_contains_timestamp_fields() {
        assert!(
            sql::DEFINE_TASK_TABLE.contains("started_at"),
            "Schema should define started_at field"
        );
        assert!(
            sql::DEFINE_TASK_TABLE.contains("completed_at"),
            "Schema should define completed_at field"
        );
        assert!(
            sql::DEFINE_TASK_TABLE.contains("option<datetime>"),
            "Timestamp fields should use option<datetime> type"
        );
    }

    #[tokio::test]
    async fn test_task_creation_without_timestamps_succeeds() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task without providing started_at or completed_at
        let result = client
            .query(
                r#"
                CREATE task:no_timestamps SET
                    title = "Task without timestamps",
                    level = "task",
                    status = "todo"
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Task creation without timestamps should succeed: {:?}",
            result.err()
        );

        // Verify the timestamps are NULL
        #[derive(Debug, serde::Deserialize)]
        struct TimestampRow {
            started_at: Option<surrealdb::sql::Datetime>,
            completed_at: Option<surrealdb::sql::Datetime>,
        }

        let mut result = client
            .query("SELECT started_at, completed_at FROM task:no_timestamps")
            .await
            .unwrap();

        let row: Option<TimestampRow> = result.take(0).unwrap();
        let row = row.expect("Task should exist");
        assert!(row.started_at.is_none(), "started_at should be NULL");
        assert!(row.completed_at.is_none(), "completed_at should be NULL");
    }

    #[tokio::test]
    async fn test_started_at_accepts_datetime() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task with started_at set to time::now()
        let result = client
            .query(
                r#"
                CREATE task:with_started SET
                    title = "Started task",
                    level = "task",
                    status = "in_progress",
                    started_at = time::now()
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Task creation with started_at should succeed: {:?}",
            result.err()
        );

        // Query and verify it's a datetime type, not string
        let mut result = client
            .query("SELECT started_at FROM task:with_started WHERE started_at IS NOT NULL")
            .await
            .unwrap();

        #[derive(Debug, serde::Deserialize)]
        struct DatetimeRow {
            started_at: surrealdb::sql::Datetime,
        }

        let row: Option<DatetimeRow> = result.take(0).unwrap();
        let row = row.expect("Task should exist with non-null started_at");
        // If we can deserialize as Datetime (not String), the type is correct
        // The Datetime type in SurrealDB should be a proper datetime
        let timestamp = row.started_at.0;
        assert!(
            timestamp.timestamp() > 0,
            "started_at should be a valid datetime with positive timestamp"
        );
    }

    #[tokio::test]
    async fn test_completed_at_accepts_datetime() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task with completed_at set to time::now()
        let result = client
            .query(
                r#"
                CREATE task:with_completed SET
                    title = "Completed task",
                    level = "task",
                    status = "done",
                    completed_at = time::now()
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Task creation with completed_at should succeed: {:?}",
            result.err()
        );

        // Query and verify it's a datetime type, not string
        let mut result = client
            .query("SELECT completed_at FROM task:with_completed WHERE completed_at IS NOT NULL")
            .await
            .unwrap();

        #[derive(Debug, serde::Deserialize)]
        struct DatetimeRow {
            completed_at: surrealdb::sql::Datetime,
        }

        let row: Option<DatetimeRow> = result.take(0).unwrap();
        let row = row.expect("Task should exist with non-null completed_at");
        // If we can deserialize as Datetime (not String), the type is correct
        let timestamp = row.completed_at.0;
        assert!(
            timestamp.timestamp() > 0,
            "completed_at should be a valid datetime with positive timestamp"
        );
    }

    #[tokio::test]
    async fn test_timestamp_persists_across_queries() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task and set started_at
        client
            .query(
                r#"
                CREATE task:persist_test SET
                    title = "Persistence test",
                    level = "task",
                    status = "in_progress",
                    started_at = time::now()
            "#,
            )
            .await
            .unwrap();

        // Query the timestamp multiple times to ensure persistence
        #[derive(Debug, serde::Deserialize)]
        struct DatetimeRow {
            started_at: surrealdb::sql::Datetime,
        }

        let mut result1 = client
            .query("SELECT started_at FROM task:persist_test")
            .await
            .unwrap();
        let row1: Option<DatetimeRow> = result1.take(0).unwrap();
        let ts1 = row1.expect("Should have timestamp").started_at.0;

        let mut result2 = client
            .query("SELECT started_at FROM task:persist_test")
            .await
            .unwrap();
        let row2: Option<DatetimeRow> = result2.take(0).unwrap();
        let ts2 = row2.expect("Should have timestamp").started_at.0;

        assert_eq!(ts1, ts2, "Timestamp should persist and be consistent");
    }

    #[tokio::test]
    async fn test_update_started_at_with_time_now() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task without started_at
        client
            .query(
                r#"
                CREATE task:update_test SET
                    title = "Update test",
                    level = "task",
                    status = "todo"
            "#,
            )
            .await
            .unwrap();

        // Update to set started_at
        let result = client
            .query(
                r#"
                UPDATE task:update_test SET
                    status = "in_progress",
                    started_at = time::now()
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Update with started_at should succeed: {:?}",
            result.err()
        );

        // Verify the update persisted
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct DatetimeRow {
            started_at: surrealdb::sql::Datetime,
        }

        let mut result = client
            .query("SELECT started_at FROM task:update_test")
            .await
            .unwrap();
        let row: Option<DatetimeRow> = result.take(0).unwrap();
        assert!(row.is_some(), "started_at should be set after update");
    }

    // Workflow schema tests
    #[test]
    fn test_workflow_sql_constant_defined() {
        assert!(!sql::DEFINE_WORKFLOW_TABLE.is_empty());
    }

    #[test]
    fn test_workflow_sql_contains_expected_definitions() {
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("DEFINE TABLE"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("workflow"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("SCHEMAFULL"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("name"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("description"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("steps"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("metadata"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("created_at"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("updated_at"));
    }

    #[tokio::test]
    async fn test_workflow_table_accepts_valid_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert a valid workflow
        let result = client
            .query(
                r#"
                CREATE workflow SET
                    name = "Test Workflow",
                    description = "A test workflow",
                    steps = [
                        { name: "Step 1", agent_config: { model: "sonnet" }, order: 0 },
                        { name: "Step 2", agent_config: { model: "opus" }, order: 1 }
                    ],
                    metadata = { version: "1.0", env: "test" }
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Valid workflow insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_workflow_table_accepts_minimal_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert with only required fields
        let result = client
            .query(
                r#"
                CREATE workflow SET
                    name = "Minimal Workflow"
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Minimal workflow insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_workflow_default_values() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert minimal workflow and check defaults
        client
            .query(
                r#"
                CREATE workflow:defaults SET
                    name = "Default Test"
            "#,
            )
            .await
            .unwrap();

        // Query the workflow to verify defaults
        #[derive(Debug, serde::Deserialize)]
        struct WorkflowRow {
            steps: Vec<serde_json::Value>,
            metadata: serde_json::Value,
            created_at: String,
            updated_at: String,
        }

        let mut result = client
            .query("SELECT steps, metadata, created_at, updated_at FROM workflow:defaults")
            .await
            .unwrap();

        let workflow: Option<WorkflowRow> = result.take(0).unwrap();
        let workflow = workflow.expect("Workflow should exist");

        // Check that arrays and objects defaulted to empty
        assert!(workflow.steps.is_empty(), "steps should default to empty");
        assert!(
            workflow.metadata.as_object().is_none_or(|m| m.is_empty()),
            "metadata should default to empty object"
        );

        // Check that timestamps were set (not empty)
        assert!(!workflow.created_at.is_empty(), "created_at should be set");
        assert!(!workflow.updated_at.is_empty(), "updated_at should be set");
    }

    #[tokio::test]
    async fn test_workflow_steps_maintain_insertion_order() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert workflow with ordered steps
        client
            .query(
                r#"
                CREATE workflow:ordered SET
                    name = "Ordered Workflow",
                    steps = [
                        { name: "First", agent_config: { model: "a" }, order: 0 },
                        { name: "Second", agent_config: { model: "b" }, order: 1 },
                        { name: "Third", agent_config: { model: "c" }, order: 2 }
                    ]
            "#,
            )
            .await
            .unwrap();

        // Query and verify step order is maintained
        #[derive(Debug, serde::Deserialize)]
        struct StepInfo {
            name: String,
            order: u32,
        }

        #[derive(Debug, serde::Deserialize)]
        struct WorkflowSteps {
            steps: Vec<StepInfo>,
        }

        let mut result = client
            .query("SELECT steps FROM workflow:ordered")
            .await
            .unwrap();

        let workflow: Option<WorkflowSteps> = result.take(0).unwrap();
        let workflow = workflow.expect("Workflow should exist");

        assert_eq!(workflow.steps.len(), 3);
        // Verify insertion order is preserved
        assert_eq!(workflow.steps[0].name, "First");
        assert_eq!(workflow.steps[0].order, 0);
        assert_eq!(workflow.steps[1].name, "Second");
        assert_eq!(workflow.steps[1].order, 1);
        assert_eq!(workflow.steps[2].name, "Third");
        assert_eq!(workflow.steps[2].order, 2);
    }

    #[tokio::test]
    async fn test_workflow_can_be_created_and_retrieved() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create a complete workflow
        client
            .query(
                r#"
                CREATE workflow:complete SET
                    name = "Complete Workflow",
                    description = "A fully populated workflow",
                    steps = [
                        { name: "Lint", agent_config: { model: "linter" }, order: 0 },
                        { name: "Test", agent_config: { model: "tester" }, order: 1 },
                        { name: "Build", agent_config: { model: "builder" }, order: 2 }
                    ],
                    metadata = { version: "2.0", team: "platform", environment: "ci" }
            "#,
            )
            .await
            .unwrap();

        // Retrieve and verify all fields
        #[derive(Debug, serde::Deserialize)]
        struct WorkflowFull {
            name: String,
            description: Option<String>,
            steps: Vec<serde_json::Value>,
            metadata: serde_json::Value,
        }

        let mut result = client
            .query("SELECT name, description, steps, metadata FROM workflow:complete")
            .await
            .unwrap();

        let workflow: Option<WorkflowFull> = result.take(0).unwrap();
        let workflow = workflow.expect("Workflow should exist");

        assert_eq!(workflow.name, "Complete Workflow");
        assert_eq!(
            workflow.description,
            Some("A fully populated workflow".to_string())
        );
        assert_eq!(workflow.steps.len(), 3);

        // Verify metadata
        let metadata = workflow.metadata.as_object().unwrap();
        assert_eq!(metadata.get("version").unwrap().as_str().unwrap(), "2.0");
        assert_eq!(metadata.get("team").unwrap().as_str().unwrap(), "platform");
        assert_eq!(metadata.get("environment").unwrap().as_str().unwrap(), "ci");

        // Verify first step structure
        let first_step = &workflow.steps[0];
        assert_eq!(first_step["name"].as_str().unwrap(), "Lint");
        assert_eq!(
            first_step["agent_config"]["model"].as_str().unwrap(),
            "linter"
        );
        assert_eq!(first_step["order"].as_u64().unwrap(), 0);
    }

    #[tokio::test]
    async fn test_workflow_update_preserves_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create initial workflow
        client
            .query(
                r#"
                CREATE workflow:update_test SET
                    name = "Initial Name",
                    description = "Initial description",
                    steps = [
                        { name: "Step 1", agent_config: { model: "agent1" }, order: 0 }
                    ]
            "#,
            )
            .await
            .unwrap();

        // Update the workflow
        client
            .query(
                r#"
                UPDATE workflow:update_test SET
                    name = "Updated Name",
                    steps = [
                        { name: "Step 1", agent_config: { model: "agent1" }, order: 0 },
                        { name: "Step 2", agent_config: { model: "agent2" }, order: 1 }
                    ],
                    updated_at = time::now()
            "#,
            )
            .await
            .unwrap();

        // Verify the update
        #[derive(Debug, serde::Deserialize)]
        struct WorkflowCheck {
            name: String,
            description: Option<String>,
            steps: Vec<serde_json::Value>,
        }

        let mut result = client
            .query("SELECT name, description, steps FROM workflow:update_test")
            .await
            .unwrap();

        let workflow: Option<WorkflowCheck> = result.take(0).unwrap();
        let workflow = workflow.expect("Workflow should exist");

        assert_eq!(workflow.name, "Updated Name");
        // Description should be preserved
        assert_eq!(
            workflow.description,
            Some("Initial description".to_string())
        );
        // Steps should be updated
        assert_eq!(workflow.steps.len(), 2);
    }

    #[tokio::test]
    async fn test_workflow_with_empty_steps() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow with explicit empty steps
        let result = client
            .query(
                r#"
                CREATE workflow:empty_steps SET
                    name = "Empty Steps Workflow",
                    steps = []
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Workflow with empty steps should succeed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_workflow_with_null_description() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow with explicit null description
        let result = client
            .query(
                r#"
                CREATE workflow:null_desc SET
                    name = "No Description",
                    description = NONE
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Workflow with null description should succeed: {:?}",
            result.err()
        );

        // Verify description is null
        #[derive(Debug, serde::Deserialize)]
        struct DescRow {
            description: Option<String>,
        }

        let mut query_result = client
            .query("SELECT description FROM workflow:null_desc")
            .await
            .unwrap();

        let row: Option<DescRow> = query_result.take(0).unwrap();
        let row = row.expect("Workflow should exist");
        assert!(row.description.is_none(), "description should be null");
    }

    // ========================================
    // Step Execution schema tests
    // ========================================

    #[test]
    fn test_step_execution_sql_constant_defined() {
        assert!(!sql::DEFINE_STEP_EXECUTION_TABLE.is_empty());
    }

    #[test]
    fn test_step_execution_sql_contains_expected_definitions() {
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("DEFINE TABLE"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("step_execution"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("SCHEMAFULL"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("task_id"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("workflow_id"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("step_name"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("started_at"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("completed_at"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("status"));
        // Verify status constraints
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("in_progress"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("completed"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("failed"));
    }

    #[tokio::test]
    async fn test_step_execution_table_accepts_valid_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // First create a task and workflow to reference
        client
            .query(
                r#"
                CREATE task:exec_test SET
                    title = "Test Task",
                    level = "task",
                    status = "in_progress";
                CREATE workflow:exec_wf SET
                    name = "Test Workflow"
            "#,
            )
            .await
            .unwrap();

        // Insert a valid step execution
        let result = client
            .query(
                r#"
                CREATE step_execution SET
                    task_id = task:exec_test,
                    workflow_id = workflow:exec_wf,
                    step_name = "review",
                    status = "in_progress"
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Valid step_execution insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_step_execution_all_valid_statuses() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task and workflow
        client
            .query(
                r#"
                CREATE task:status_test SET
                    title = "Status Test Task",
                    level = "task",
                    status = "in_progress";
                CREATE workflow:status_wf SET
                    name = "Status Workflow"
            "#,
            )
            .await
            .unwrap();

        for (i, status) in ["in_progress", "completed", "failed"].iter().enumerate() {
            let query = format!(
                r#"CREATE step_execution:status_{} SET
                    task_id = task:status_test,
                    workflow_id = workflow:status_wf,
                    step_name = "step_{}",
                    status = "{}""#,
                i, i, status
            );
            let result = client.query(&query).await;
            assert!(
                result.is_ok(),
                "Status '{}' should be valid: {:?}",
                status,
                result.err()
            );
        }
    }

    #[tokio::test]
    async fn test_step_execution_rejects_invalid_status() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task and workflow
        client
            .query(
                r#"
                CREATE task:invalid_status SET
                    title = "Invalid Status Test",
                    level = "task",
                    status = "todo";
                CREATE workflow:invalid_wf SET
                    name = "Invalid Status Workflow"
            "#,
            )
            .await
            .unwrap();

        // Try to insert with invalid status
        let mut response = client
            .query(
                r#"
                CREATE step_execution SET
                    task_id = task:invalid_status,
                    workflow_id = workflow:invalid_wf,
                    step_name = "bad_step",
                    status = "invalid_status"
            "#,
            )
            .await
            .unwrap();

        let check: Result<Option<surrealdb::Value>, _> = response.take(0);
        assert!(check.is_err(), "Should reject invalid status");
    }

    #[tokio::test]
    async fn test_step_execution_with_completed_at() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task and workflow
        client
            .query(
                r#"
                CREATE task:completed_exec SET
                    title = "Completed Execution Task",
                    level = "task",
                    status = "done";
                CREATE workflow:completed_wf SET
                    name = "Completed Workflow"
            "#,
            )
            .await
            .unwrap();

        // Create a completed step execution
        let result = client
            .query(
                r#"
                CREATE step_execution:completed SET
                    task_id = task:completed_exec,
                    workflow_id = workflow:completed_wf,
                    step_name = "build",
                    started_at = time::now(),
                    completed_at = time::now(),
                    status = "completed"
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Step execution with completed_at should succeed: {:?}",
            result.err()
        );

        // Verify the completed_at is set
        #[derive(Debug, serde::Deserialize)]
        struct ExecRow {
            status: String,
            completed_at: Option<surrealdb::sql::Datetime>,
        }

        let mut query_result = client
            .query("SELECT status, completed_at FROM step_execution:completed")
            .await
            .unwrap();

        let row: Option<ExecRow> = query_result.take(0).unwrap();
        let row = row.expect("Step execution should exist");
        assert_eq!(row.status, "completed");
        assert!(row.completed_at.is_some(), "completed_at should be set");
    }

    #[tokio::test]
    async fn test_step_execution_default_started_at() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task and workflow
        client
            .query(
                r#"
                CREATE task:default_time SET
                    title = "Default Time Task",
                    level = "task",
                    status = "in_progress";
                CREATE workflow:default_wf SET
                    name = "Default Time Workflow"
            "#,
            )
            .await
            .unwrap();

        // Create step execution without explicit started_at
        client
            .query(
                r#"
                CREATE step_execution:default_time SET
                    task_id = task:default_time,
                    workflow_id = workflow:default_wf,
                    step_name = "test",
                    status = "in_progress"
            "#,
            )
            .await
            .unwrap();

        // Verify started_at was set by default
        #[derive(Debug, serde::Deserialize)]
        struct TimeRow {
            started_at: surrealdb::sql::Datetime,
        }

        let mut result = client
            .query("SELECT started_at FROM step_execution:default_time")
            .await
            .unwrap();

        let row: Option<TimeRow> = result.take(0).unwrap();
        let row = row.expect("Step execution should exist");
        // If we can deserialize, started_at was set
        assert!(
            row.started_at.0.timestamp() > 0,
            "started_at should have a valid timestamp"
        );
    }

    #[tokio::test]
    async fn test_step_execution_can_query_by_task() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task and workflow
        client
            .query(
                r#"
                CREATE task:query_task SET
                    title = "Query Test Task",
                    level = "task",
                    status = "in_progress";
                CREATE workflow:query_wf SET
                    name = "Query Workflow"
            "#,
            )
            .await
            .unwrap();

        // Create multiple step executions for the same task
        client
            .query(
                r#"
                CREATE step_execution:exec1 SET
                    task_id = task:query_task,
                    workflow_id = workflow:query_wf,
                    step_name = "step1",
                    status = "completed";
                CREATE step_execution:exec2 SET
                    task_id = task:query_task,
                    workflow_id = workflow:query_wf,
                    step_name = "step2",
                    status = "in_progress"
            "#,
            )
            .await
            .unwrap();

        // Query executions for the task
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct ExecRow {
            step_name: String,
            status: String,
        }

        let mut result = client
            .query("SELECT step_name, status FROM step_execution WHERE task_id = task:query_task")
            .await
            .unwrap();

        let rows: Vec<ExecRow> = result.take(0).unwrap();
        assert_eq!(rows.len(), 2, "Should have 2 executions for the task");
    }

    // ========================================
    // Session Log Schema Tests
    // ========================================

    #[test]
    fn test_session_log_sql_constant_defined() {
        assert!(!sql::DEFINE_SESSION_LOG_TABLE.is_empty());
    }

    #[test]
    fn test_session_log_sql_contains_expected_definitions() {
        assert!(sql::DEFINE_SESSION_LOG_TABLE.contains("DEFINE TABLE"));
        assert!(sql::DEFINE_SESSION_LOG_TABLE.contains("session_log"));
        assert!(sql::DEFINE_SESSION_LOG_TABLE.contains("SCHEMAFULL"));
        assert!(sql::DEFINE_SESSION_LOG_TABLE.contains("step_execution_id"));
        assert!(sql::DEFINE_SESSION_LOG_TABLE.contains("content"));
        assert!(sql::DEFINE_SESSION_LOG_TABLE.contains("created_at"));
    }

    #[tokio::test]
    async fn test_session_log_table_accepts_valid_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // First create prerequisite records
        client
            .query(
                r#"
                CREATE task:log_test SET
                    title = "Test Task",
                    level = "task",
                    status = "backlog";

                CREATE workflow:log_test SET
                    name = "Test Workflow";

                CREATE step_execution:log_exec SET
                    task_id = task:log_test,
                    workflow_id = workflow:log_test,
                    step_name = "test_step",
                    status = "in_progress";
                "#,
            )
            .await
            .unwrap();

        // Create a session log
        let result = client
            .query(
                r#"
                CREATE session_log:test_log SET
                    step_execution_id = step_execution:log_exec,
                    content = "Test log content from Claude session"
                "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Creating session_log should succeed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_session_log_default_created_at() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create prerequisites
        client
            .query(
                r#"
                CREATE task:created_test SET title = "Test", level = "task", status = "backlog";
                CREATE workflow:created_test SET name = "Test WF";
                CREATE step_execution:created_test SET
                    task_id = task:created_test,
                    workflow_id = workflow:created_test,
                    step_name = "step",
                    status = "in_progress";
                "#,
            )
            .await
            .unwrap();

        // Create session log without explicit created_at
        client
            .query(
                r#"
                CREATE session_log:created_test SET
                    step_execution_id = step_execution:created_test,
                    content = "Content"
                "#,
            )
            .await
            .unwrap();

        // Verify created_at was auto-set
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct DatetimeRow {
            created_at: surrealdb::sql::Datetime,
        }

        let mut result = client
            .query("SELECT created_at FROM session_log:created_test")
            .await
            .unwrap();
        let row: Option<DatetimeRow> = result.take(0).unwrap();
        assert!(row.is_some(), "created_at should be set by default");
    }

    #[tokio::test]
    async fn test_session_log_stores_arbitrary_content() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create prerequisites
        client
            .query(
                r#"
                CREATE task:content_test SET title = "Test", level = "task", status = "backlog";
                CREATE workflow:content_test SET name = "Test WF";
                CREATE step_execution:content_test SET
                    task_id = task:content_test,
                    workflow_id = workflow:content_test,
                    step_name = "step",
                    status = "in_progress";
                "#,
            )
            .await
            .unwrap();

        // Test various content types
        let contents = vec![
            ("log1", "Simple text"),
            ("log2", ""),
            ("log3", "Multi\nline\ncontent"),
            ("log4", "Special: @#$%^&*()"),
            ("log5", "Unicode: 日本語"),
        ];

        for (id, content) in contents {
            let query = format!(
                r#"CREATE session_log:{} SET
                    step_execution_id = step_execution:content_test,
                    content = "{}""#,
                id, content
            );
            let result = client.query(&query).await;
            assert!(
                result.is_ok(),
                "Content '{}' should be stored: {:?}",
                content,
                result.err()
            );
        }
    }

    #[tokio::test]
    async fn test_session_log_multiple_logs_per_execution() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create prerequisites
        client
            .query(
                r#"
                CREATE task:multi_test SET title = "Test", level = "task", status = "backlog";
                CREATE workflow:multi_test SET name = "Test WF";
                CREATE step_execution:multi_exec SET
                    task_id = task:multi_test,
                    workflow_id = workflow:multi_test,
                    step_name = "step",
                    status = "in_progress";
                "#,
            )
            .await
            .unwrap();

        // Create multiple logs for the same execution
        client
            .query(
                r#"
                CREATE session_log:multi1 SET
                    step_execution_id = step_execution:multi_exec,
                    content = "First log entry";

                CREATE session_log:multi2 SET
                    step_execution_id = step_execution:multi_exec,
                    content = "Second log entry";

                CREATE session_log:multi3 SET
                    step_execution_id = step_execution:multi_exec,
                    content = "Third log entry";
                "#,
            )
            .await
            .unwrap();

        // Query logs for the execution
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct LogRow {
            content: String,
        }

        let mut result = client
            .query("SELECT content FROM session_log WHERE step_execution_id = step_execution:multi_exec")
            .await
            .unwrap();

        let rows: Vec<LogRow> = result.take(0).unwrap();
        assert_eq!(
            rows.len(),
            3,
            "Should have 3 logs attached to one execution"
        );
    }
}
