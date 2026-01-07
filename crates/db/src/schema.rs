//! Database schema initialization for Vertebrae
//!
//! Defines the SurrealDB schema for tasks, sections, code references,
//! and graph edges (hierarchy and dependencies).

use crate::error::DbError;
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
            ASSERT $value IN ["todo", "in_progress", "done", "blocked"];

        DEFINE FIELD priority ON task TYPE option<string>
            ASSERT $value IN [NONE, "low", "medium", "high", "critical"];

        DEFINE FIELD tags ON task TYPE array<string> DEFAULT [];

        DEFINE FIELD created_at ON task TYPE datetime DEFAULT time::now();

        DEFINE FIELD updated_at ON task TYPE datetime DEFAULT time::now();

        DEFINE FIELD started_at ON task TYPE option<datetime>;

        DEFINE FIELD completed_at ON task TYPE option<datetime>;

        DEFINE FIELD sections ON task FLEXIBLE TYPE array<object> DEFAULT [];

        DEFINE FIELD refs ON task FLEXIBLE TYPE array<object> DEFAULT [];

        DEFINE FIELD needs_human_review ON task TYPE bool DEFAULT false;
    "#;

    /// Define the child_of relation table for hierarchy edges
    pub const DEFINE_CHILD_OF_RELATION: &str = r#"
        DEFINE TABLE IF NOT EXISTS child_of TYPE RELATION IN task OUT task;
    "#;

    /// Define the depends_on relation table for dependency edges
    pub const DEFINE_DEPENDS_ON_RELATION: &str = r#"
        DEFINE TABLE IF NOT EXISTS depends_on TYPE RELATION IN task OUT task;
    "#;
}

/// Initialize the database schema.
///
/// Creates the task table, child_of relation, and depends_on relation
/// with all required fields and constraints.
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

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use surrealdb::engine::local::RocksDb;

    /// Helper to create a test database
    async fn setup_test_db() -> (Surreal<Db>, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-schema-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        // Create directory
        std::fs::create_dir_all(&temp_dir).unwrap();

        // Connect to database
        let client = Surreal::new::<RocksDb>(temp_dir.clone()).await.unwrap();

        // Select namespace and database
        client.use_ns("vertebrae").use_db("test").await.unwrap();

        (client, temp_dir)
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn test_init_schema_succeeds() {
        let (client, temp_dir) = setup_test_db().await;

        let result = init_schema(&client).await;
        assert!(result.is_ok(), "Schema init failed: {:?}", result.err());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_init_schema_is_idempotent() {
        let (client, temp_dir) = setup_test_db().await;

        // First call
        let result1 = init_schema(&client).await;
        assert!(result1.is_ok(), "First init failed: {:?}", result1.err());

        // Second call should also succeed
        let result2 = init_schema(&client).await;
        assert!(result2.is_ok(), "Second init failed: {:?}", result2.err());

        // Third call for good measure
        let result3 = init_schema(&client).await;
        assert!(result3.is_ok(), "Third init failed: {:?}", result3.err());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_table_accepts_valid_data() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_table_accepts_minimal_data() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_table_rejects_invalid_level() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_table_rejects_invalid_status() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_table_rejects_invalid_priority() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_with_null_priority_succeeds() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_child_of_relation_between_tasks() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_depends_on_relation_between_tasks() {
        let (client, temp_dir) = setup_test_db().await;
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
                    status = "blocked";
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_with_sections() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_with_refs() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_task_default_values() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_all_valid_levels() {
        let (client, temp_dir) = setup_test_db().await;
        init_schema(&client).await.unwrap();

        for level in ["epic", "ticket", "task"] {
            let query = format!(
                r#"CREATE task SET title = "Test {}", level = "{}", status = "todo""#,
                level, level
            );
            let result = client.query(&query).await;
            assert!(result.is_ok(), "Level '{}' should be valid", level);
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_all_valid_statuses() {
        let (client, temp_dir) = setup_test_db().await;
        init_schema(&client).await.unwrap();

        for (i, status) in ["todo", "in_progress", "done", "blocked"]
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_all_valid_priorities() {
        let (client, temp_dir) = setup_test_db().await;
        init_schema(&client).await.unwrap();

        for (i, priority) in ["low", "medium", "high", "critical"].iter().enumerate() {
            let query = format!(
                r#"CREATE task SET title = "Test {}", level = "task", status = "todo", priority = "{}""#,
                i, priority
            );
            let result = client.query(&query).await;
            assert!(result.is_ok(), "Priority '{}' should be valid", priority);
        }

        cleanup(&temp_dir);
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
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_started_at_accepts_datetime() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_completed_at_accepts_datetime() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_timestamp_persists_across_queries() {
        let (client, temp_dir) = setup_test_db().await;
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_update_started_at_with_time_now() {
        let (client, temp_dir) = setup_test_db().await;
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
        struct DatetimeRow {
            started_at: surrealdb::sql::Datetime,
        }

        let mut result = client
            .query("SELECT started_at FROM task:update_test")
            .await
            .unwrap();
        let row: Option<DatetimeRow> = result.take(0).unwrap();
        assert!(row.is_some(), "started_at should be set after update");

        cleanup(&temp_dir);
    }
}
