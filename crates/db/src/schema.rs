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

        DEFINE FIELD revision_feedback ON task TYPE option<string>;

        DEFINE FIELD rejection_reason ON task TYPE option<string>;

        DEFINE FIELD workflow_id ON task TYPE option<record<workflow>>;

        DEFINE FIELD current_step ON task TYPE option<int>;

        DEFINE FIELD current_step_id ON task TYPE option<record<step>>;
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

        DEFINE FIELD initial_step ON workflow TYPE option<record<step>>;

        DEFINE FIELD metadata ON workflow FLEXIBLE TYPE object DEFAULT {};

        DEFINE FIELD auto_advance ON workflow TYPE bool DEFAULT false;

        DEFINE FIELD order ON workflow TYPE int DEFAULT 0;

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

        -- Turn data fields (populated after execution)
        DEFINE FIELD context ON step_execution TYPE option<string>;

        DEFINE FIELD prompt ON step_execution TYPE option<string>;

        DEFINE FIELD output ON step_execution TYPE option<string>;

        DEFINE FIELD transition_result ON step_execution TYPE option<string>;

        DEFINE FIELD model_used ON step_execution TYPE option<string>;

        DEFINE FIELD session_id ON step_execution TYPE option<string>;

        DEFINE FIELD token_usage ON step_execution TYPE option<object>;

        DEFINE FIELD token_usage.input_tokens ON step_execution TYPE option<int>;

        DEFINE FIELD token_usage.output_tokens ON step_execution TYPE option<int>;

        DEFINE FIELD token_usage.cache_read_input_tokens ON step_execution TYPE option<int>;

        DEFINE FIELD token_usage.cache_creation_input_tokens ON step_execution TYPE option<int>;

        DEFINE FIELD cost_usd ON step_execution TYPE option<float>;

        DEFINE FIELD duration_ms ON step_execution TYPE option<int>;
    "#;

    /// Define the session_log table for storing Claude session content during step execution
    pub const DEFINE_SESSION_LOG_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS session_log SCHEMAFULL;

        DEFINE FIELD step_execution_id ON session_log TYPE record<step_execution>;

        DEFINE FIELD content ON session_log TYPE string;

        DEFINE FIELD created_at ON session_log TYPE datetime DEFAULT time::now();
    "#;

    /// Define the step table for first-class workflow steps
    pub const DEFINE_STEP_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS step SCHEMAFULL;

        DEFINE FIELD name ON step TYPE string;

        DEFINE FIELD workflow_id ON step TYPE record<workflow>;

        DEFINE FIELD goal ON step TYPE option<string>;

        DEFINE FIELD agents ON step TYPE array<string> DEFAULT [];

        DEFINE FIELD skills ON step TYPE array<string> DEFAULT [];

        DEFINE FIELD agent_config ON step FLEXIBLE TYPE object DEFAULT {};

        DEFINE FIELD is_final ON step TYPE bool DEFAULT false;

        DEFINE FIELD transitions_to ON step TYPE array<record<step>> DEFAULT [];

        DEFINE FIELD order ON step TYPE int DEFAULT 0;

        DEFINE FIELD created_at ON step TYPE datetime DEFAULT time::now();

        DEFINE FIELD updated_at ON step TYPE datetime DEFAULT time::now();
    "#;

    /// Define the chat_session table for storing Claude PTY chat sessions
    pub const DEFINE_CHAT_SESSION_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS chat_session SCHEMAFULL;

        DEFINE FIELD title ON chat_session TYPE option<string>;

        DEFINE FIELD working_dir ON chat_session TYPE option<string>;

        DEFINE FIELD started_at ON chat_session TYPE datetime DEFAULT time::now();

        DEFINE FIELD ended_at ON chat_session TYPE option<datetime>;
    "#;

    /// Define the chat_message table for storing conversation history within a chat session
    pub const DEFINE_CHAT_MESSAGE_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS chat_message SCHEMAFULL;

        DEFINE FIELD session_id ON chat_message TYPE record<chat_session>;

        DEFINE FIELD content ON chat_message TYPE string;

        DEFINE FIELD created_at ON chat_message TYPE datetime DEFAULT time::now();
    "#;

    /// Define the status_schema table for configurable status definitions
    ///
    /// StatusSchema is the single source of truth for what statuses exist
    /// and how tasks can transition between them. The default schema is
    /// created on database initialization.
    pub const DEFINE_STATUS_SCHEMA_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS status_schema SCHEMAFULL;

        DEFINE FIELD name ON status_schema TYPE string;

        DEFINE FIELD description ON status_schema TYPE option<string>;

        DEFINE FIELD is_default ON status_schema TYPE bool DEFAULT false;

        DEFINE FIELD statuses ON status_schema FLEXIBLE TYPE array<object> DEFAULT [];

        DEFINE FIELD progressions ON status_schema FLEXIBLE TYPE array<object> DEFAULT [];

        DEFINE FIELD created_at ON status_schema TYPE datetime DEFAULT time::now();

        DEFINE FIELD updated_at ON status_schema TYPE datetime DEFAULT time::now();
    "#;

    /// Define the validation_gate table for workflow completion validation
    ///
    /// ValidationGate defines how workflow completion is validated before status transition.
    /// Gates can be simple (command execution, manual approval) or composite (combining multiple gates).
    pub const DEFINE_VALIDATION_GATE_TABLE: &str = r#"
        DEFINE TABLE IF NOT EXISTS validation_gate SCHEMAFULL;

        DEFINE FIELD name ON validation_gate TYPE string;

        DEFINE FIELD description ON validation_gate TYPE option<string>;

        DEFINE FIELD gate_type ON validation_gate TYPE string
            ASSERT $value IN ["command_execution", "agent_classification", "manual_approval", "composite"];

        DEFINE FIELD mechanism ON validation_gate TYPE option<string>
            ASSERT $value IN [NONE, "all_must_pass", "any_must_pass", "weighted"];

        DEFINE FIELD child_gates ON validation_gate TYPE array<record<validation_gate>> DEFAULT [];

        DEFINE FIELD pass_threshold ON validation_gate TYPE option<float>;

        DEFINE FIELD command ON validation_gate TYPE option<string>;

        DEFINE FIELD timeout_seconds ON validation_gate TYPE option<int>;

        DEFINE FIELD agent_config ON validation_gate FLEXIBLE TYPE option<object>;

        DEFINE FIELD classification_prompt ON validation_gate TYPE option<string>;

        DEFINE FIELD created_at ON validation_gate TYPE datetime DEFAULT time::now();

        DEFINE FIELD updated_at ON validation_gate TYPE datetime DEFAULT time::now();
    "#;

    /// Add validation_gate_id field to workflow table (migration)
    pub const ADD_VALIDATION_GATE_TO_WORKFLOW: &str = r#"
        DEFINE FIELD validation_gate_id ON workflow TYPE option<record<validation_gate>>;
    "#;

    /// Define the workflow_transitions relation table for valid workflow-to-workflow transitions.
    ///
    /// This edge table defines which workflows can transition to other workflows,
    /// with an optional target step to start at in the destination workflow.
    pub const DEFINE_WORKFLOW_TRANSITIONS_RELATION: &str = r#"
        DEFINE TABLE IF NOT EXISTS workflow_transitions TYPE RELATION IN workflow OUT workflow;

        DEFINE FIELD label ON workflow_transitions TYPE string;

        DEFINE FIELD target_step ON workflow_transitions TYPE option<record<step>>;

        DEFINE FIELD created_at ON workflow_transitions TYPE datetime DEFAULT time::now();
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
/// Creates the task table, workflow table, step table, step_execution table, session_log table,
/// chat_session table, chat_message table, status_schema table, validation_gate table,
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

    // Define the step table for first-class workflow steps
    client
        .query(sql::DEFINE_STEP_TABLE)
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

    // Define the chat_session table for storing PTY chat sessions
    client
        .query(sql::DEFINE_CHAT_SESSION_TABLE)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the chat_message table for storing conversation history
    client
        .query(sql::DEFINE_CHAT_MESSAGE_TABLE)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the status_schema table for configurable status definitions
    client
        .query(sql::DEFINE_STATUS_SCHEMA_TABLE)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the validation_gate table for workflow completion validation
    client
        .query(sql::DEFINE_VALIDATION_GATE_TABLE)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Add validation_gate_id field to workflow table (migration)
    client
        .query(sql::ADD_VALIDATION_GATE_TO_WORKFLOW)
        .await
        .map_err(|e| DbError::Schema(Box::new(e)))?;

    // Define the workflow_transitions relation for workflow-to-workflow transitions
    client
        .query(sql::DEFINE_WORKFLOW_TRANSITIONS_RELATION)
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
                    status = "in_progress",
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
                    status = "in_progress"
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
                    status = "in_progress",
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
                    status = "in_progress",
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
                    status = "in_progress";
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
                    status = "in_progress",
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
                    status = "in_progress",
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
                    status = "in_progress"
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
                r#"CREATE task SET title = "Test {}", level = "{}", status = "in_progress""#,
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
            "in_progress",
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
                r#"CREATE task SET title = "Test {}", level = "task", status = "in_progress", priority = "{}""#,
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
        // Note: status field removed - status is now derived from current_step_id
        assert!(sql::DEFINE_TASK_TABLE.contains("current_step_id"));

        assert!(sql::DEFINE_CHILD_OF_RELATION.contains("RELATION"));
        assert!(sql::DEFINE_CHILD_OF_RELATION.contains("child_of"));

        assert!(sql::DEFINE_DEPENDS_ON_RELATION.contains("RELATION"));
        assert!(sql::DEFINE_DEPENDS_ON_RELATION.contains("depends_on"));

        assert!(sql::DEFINE_WORKFLOW_TRANSITIONS_RELATION.contains("RELATION"));
        assert!(sql::DEFINE_WORKFLOW_TRANSITIONS_RELATION.contains("workflow_transitions"));
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
                    status = "in_progress"
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
                    status = "in_progress"
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

    #[tokio::test]
    async fn test_task_with_current_step_id() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow and step first
        client
            .query(
                r#"
                CREATE workflow:step_ref_test SET
                    name = "Step Reference Test";
                CREATE step:test_step SET
                    name = "Test Step",
                    workflow_id = workflow:step_ref_test,
                    order = 0
            "#,
            )
            .await
            .unwrap();

        // Create task with current_step_id referencing a step
        let result = client
            .query(
                r#"
                CREATE task:with_step_id SET
                    title = "Task with Step ID",
                    level = "task",
                    status = "in_progress",
                    workflow_id = workflow:step_ref_test,
                    current_step_id = step:test_step
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Task with current_step_id should succeed: {:?}",
            result.err()
        );

        // Verify current_step_id is set
        #[derive(Debug, serde::Deserialize)]
        struct StepIdRow {
            current_step_id: Option<surrealdb::sql::Thing>,
        }

        let mut query_result = client
            .query("SELECT current_step_id FROM task:with_step_id")
            .await
            .unwrap();

        let row: Option<StepIdRow> = query_result.take(0).unwrap();
        let row = row.expect("Task should exist");
        assert!(
            row.current_step_id.is_some(),
            "current_step_id should be set"
        );
        assert_eq!(
            row.current_step_id.unwrap().to_string(),
            "step:test_step",
            "current_step_id should reference the correct step"
        );
    }

    #[tokio::test]
    async fn test_task_current_step_id_defaults_to_none() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create task without current_step_id
        client
            .query(
                r#"
                CREATE task:no_step_id SET
                    title = "Task without Step ID",
                    level = "task",
                    status = "in_progress"
            "#,
            )
            .await
            .unwrap();

        // Verify current_step_id is None by default
        #[derive(Debug, serde::Deserialize)]
        struct StepIdRow {
            current_step_id: Option<surrealdb::sql::Thing>,
        }

        let mut query_result = client
            .query("SELECT current_step_id FROM task:no_step_id")
            .await
            .unwrap();

        let row: Option<StepIdRow> = query_result.take(0).unwrap();
        let row = row.expect("Task should exist");
        assert!(
            row.current_step_id.is_none(),
            "current_step_id should be None by default"
        );
    }

    #[tokio::test]
    async fn test_task_can_have_both_step_fields() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow and step
        client
            .query(
                r#"
                CREATE workflow:both_fields SET
                    name = "Both Fields Test";
                CREATE step:both_step SET
                    name = "Both Step",
                    workflow_id = workflow:both_fields,
                    order = 0
            "#,
            )
            .await
            .unwrap();

        // Create task with both current_step (legacy) and current_step_id (new)
        let result = client
            .query(
                r#"
                CREATE task:both_steps SET
                    title = "Task with Both Step Fields",
                    level = "task",
                    status = "in_progress",
                    workflow_id = workflow:both_fields,
                    current_step = 0,
                    current_step_id = step:both_step
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Task with both step fields should succeed: {:?}",
            result.err()
        );

        // Verify both fields are set
        #[derive(Debug, serde::Deserialize)]
        struct BothRow {
            current_step: Option<i32>,
            current_step_id: Option<surrealdb::sql::Thing>,
        }

        let mut query_result = client
            .query("SELECT current_step, current_step_id FROM task:both_steps")
            .await
            .unwrap();

        let row: Option<BothRow> = query_result.take(0).unwrap();
        let row = row.expect("Task should exist");
        assert_eq!(row.current_step, Some(0), "current_step should be 0");
        assert!(
            row.current_step_id.is_some(),
            "current_step_id should be set"
        );
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
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("initial_step"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("metadata"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("auto_advance"));
        assert!(sql::DEFINE_WORKFLOW_TABLE.contains("order"));
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

    #[tokio::test]
    async fn test_workflow_with_initial_step() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow first
        client
            .query(
                r#"
                CREATE workflow:with_initial SET
                    name = "Workflow with Initial Step"
            "#,
            )
            .await
            .unwrap();

        // Create a step for the workflow
        client
            .query(
                r#"
                CREATE step:first_step SET
                    name = "First Step",
                    workflow_id = workflow:with_initial,
                    order = 0
            "#,
            )
            .await
            .unwrap();

        // Update workflow to set initial_step
        let result = client
            .query(
                r#"
                UPDATE workflow:with_initial SET
                    initial_step = step:first_step
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Setting initial_step should succeed: {:?}",
            result.err()
        );

        // Verify initial_step is set
        #[derive(Debug, serde::Deserialize)]
        struct InitialStepRow {
            initial_step: Option<surrealdb::sql::Thing>,
        }

        let mut query_result = client
            .query("SELECT initial_step FROM workflow:with_initial")
            .await
            .unwrap();

        let row: Option<InitialStepRow> = query_result.take(0).unwrap();
        let row = row.expect("Workflow should exist");
        assert!(row.initial_step.is_some(), "initial_step should be set");
        assert_eq!(
            row.initial_step.unwrap().to_string(),
            "step:first_step",
            "initial_step should reference the correct step"
        );
    }

    #[tokio::test]
    async fn test_workflow_initial_step_defaults_to_none() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow without initial_step
        client
            .query(
                r#"
                CREATE workflow:no_initial SET
                    name = "Workflow without Initial Step"
            "#,
            )
            .await
            .unwrap();

        // Verify initial_step is None by default
        #[derive(Debug, serde::Deserialize)]
        struct InitialStepRow {
            initial_step: Option<surrealdb::sql::Thing>,
        }

        let mut query_result = client
            .query("SELECT initial_step FROM workflow:no_initial")
            .await
            .unwrap();

        let row: Option<InitialStepRow> = query_result.take(0).unwrap();
        let row = row.expect("Workflow should exist");
        assert!(
            row.initial_step.is_none(),
            "initial_step should be None by default"
        );
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
        // Verify turn data fields
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("prompt"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("output"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("model_used"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("session_id"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("token_usage"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("cost_usd"));
        assert!(sql::DEFINE_STEP_EXECUTION_TABLE.contains("duration_ms"));
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
                    status = "in_progress";
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
            #[allow(dead_code)]
            started_at: surrealdb::sql::Datetime,
        }

        let mut result = client
            .query("SELECT started_at FROM step_execution:default_time")
            .await
            .unwrap();
        let row: Option<TimeRow> = result.take(0).unwrap();
        assert!(row.is_some(), "started_at should be set by default");
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

    // ========================================
    // Step Table Schema Tests
    // ========================================

    #[test]
    fn test_step_sql_constant_defined() {
        assert!(!sql::DEFINE_STEP_TABLE.is_empty());
    }

    #[test]
    fn test_step_sql_contains_expected_definitions() {
        assert!(sql::DEFINE_STEP_TABLE.contains("DEFINE TABLE"));
        assert!(sql::DEFINE_STEP_TABLE.contains("step"));
        assert!(sql::DEFINE_STEP_TABLE.contains("SCHEMAFULL"));
        assert!(sql::DEFINE_STEP_TABLE.contains("name"));
        assert!(sql::DEFINE_STEP_TABLE.contains("workflow_id"));
        assert!(sql::DEFINE_STEP_TABLE.contains("agent_config"));
        assert!(sql::DEFINE_STEP_TABLE.contains("is_final"));
        assert!(sql::DEFINE_STEP_TABLE.contains("transitions_to"));
        assert!(sql::DEFINE_STEP_TABLE.contains("order"));
        assert!(sql::DEFINE_STEP_TABLE.contains("created_at"));
        assert!(sql::DEFINE_STEP_TABLE.contains("updated_at"));
    }

    #[tokio::test]
    async fn test_step_table_accepts_valid_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // First create a workflow to reference
        client
            .query(
                r#"
                CREATE workflow:step_test SET
                    name = "Test Workflow"
            "#,
            )
            .await
            .unwrap();

        // Insert a valid step
        let result = client
            .query(
                r#"
                CREATE step SET
                    name = "Review",
                    workflow_id = workflow:step_test,
                    agent_config = { model: "opus", temperature: 0.7 },
                    is_final = false,
                    order = 0
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Valid step insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_step_table_accepts_minimal_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create a workflow first
        client
            .query(
                r#"
                CREATE workflow:minimal_step SET
                    name = "Minimal Workflow"
            "#,
            )
            .await
            .unwrap();

        // Insert with only required fields
        let result = client
            .query(
                r#"
                CREATE step SET
                    name = "Basic Step",
                    workflow_id = workflow:minimal_step
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Minimal step insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_step_default_values() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow
        client
            .query(
                r#"
                CREATE workflow:default_step SET
                    name = "Default Step Workflow"
            "#,
            )
            .await
            .unwrap();

        // Insert step with minimal fields to check defaults
        client
            .query(
                r#"
                CREATE step:defaults SET
                    name = "Default Test",
                    workflow_id = workflow:default_step
            "#,
            )
            .await
            .unwrap();

        // Query the step to verify defaults
        #[derive(Debug, serde::Deserialize)]
        struct StepRow {
            is_final: bool,
            order: i32,
            agent_config: serde_json::Value,
            transitions_to: Vec<serde_json::Value>,
            created_at: String,
            updated_at: String,
        }

        let mut result = client
            .query("SELECT is_final, order, agent_config, transitions_to, created_at, updated_at FROM step:defaults")
            .await
            .unwrap();

        let step: Option<StepRow> = result.take(0).unwrap();
        let step = step.expect("Step should exist");

        // Check defaults
        assert!(!step.is_final, "is_final should default to false");
        assert_eq!(step.order, 0, "order should default to 0");
        assert!(
            step.agent_config.as_object().is_none_or(|m| m.is_empty()),
            "agent_config should default to empty object"
        );
        assert!(
            step.transitions_to.is_empty(),
            "transitions_to should default to empty array"
        );
        assert!(!step.created_at.is_empty(), "created_at should be set");
        assert!(!step.updated_at.is_empty(), "updated_at should be set");
    }

    #[tokio::test]
    async fn test_step_with_transitions() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow
        client
            .query(
                r#"
                CREATE workflow:transitions SET
                    name = "Transition Workflow"
            "#,
            )
            .await
            .unwrap();

        // Create two steps where one transitions to another
        client
            .query(
                r#"
                CREATE step:start SET
                    name = "Start",
                    workflow_id = workflow:transitions,
                    order = 0;
                CREATE step:branch_a SET
                    name = "Branch A",
                    workflow_id = workflow:transitions,
                    order = 1;
                CREATE step:branch_b SET
                    name = "Branch B",
                    workflow_id = workflow:transitions,
                    order = 1
            "#,
            )
            .await
            .unwrap();

        // Update step1 to transition to step2
        let result = client
            .query(
                r#"
                UPDATE step:start SET
                    transitions_to = [step:branch_a]
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Setting transitions_to failed: {:?}",
            result.err()
        );

        // Verify the transition
        #[derive(Debug, serde::Deserialize)]
        struct TransitionRow {
            transitions_to: Vec<surrealdb::sql::Thing>,
        }

        let mut query_result = client
            .query("SELECT transitions_to FROM step:start")
            .await
            .unwrap();

        let row: Option<TransitionRow> = query_result.take(0).unwrap();
        let row = row.expect("Step should exist");
        assert_eq!(row.transitions_to.len(), 1, "Should have one transition");
        assert_eq!(
            row.transitions_to[0].to_string(),
            "step:branch_a",
            "Should transition to step2"
        );
    }

    #[tokio::test]
    async fn test_step_with_agent_config() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow
        client
            .query(
                r#"
                CREATE workflow:agent_config SET
                    name = "Agent Config Workflow"
            "#,
            )
            .await
            .unwrap();

        // Create step with complex agent config
        let result = client
            .query(
                r#"
                CREATE step:configured SET
                    name = "Configured Step",
                    workflow_id = workflow:agent_config,
                    agent_config = {
                        model: "opus",
                        temperature: 0.5,
                        max_tokens: 4096,
                        system_prompt: "You are a helpful assistant",
                        tools: ["read", "write", "bash"]
                    }
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Step with agent_config failed: {:?}",
            result.err()
        );

        // Verify the agent config was stored
        #[derive(Debug, serde::Deserialize)]
        struct ConfigRow {
            agent_config: serde_json::Value,
        }

        let mut query_result = client
            .query("SELECT agent_config FROM step:configured")
            .await
            .unwrap();

        let row: Option<ConfigRow> = query_result.take(0).unwrap();
        let row = row.expect("Step should exist");
        let config = row.agent_config.as_object().unwrap();

        assert_eq!(config.get("model").unwrap().as_str().unwrap(), "opus");
        assert_eq!(config.get("temperature").unwrap().as_f64().unwrap(), 0.5);
        assert_eq!(config.get("max_tokens").unwrap().as_i64().unwrap(), 4096);
    }

    #[tokio::test]
    async fn test_step_multiple_transitions() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow
        client
            .query(
                r#"
                CREATE workflow:multi_trans SET
                    name = "Multi Transition Workflow"
            "#,
            )
            .await
            .unwrap();

        // Create steps with branching transitions
        client
            .query(
                r#"
                CREATE step:start SET
                    name = "Start",
                    workflow_id = workflow:multi_trans,
                    order = 0;
                CREATE step:branch_a SET
                    name = "Branch A",
                    workflow_id = workflow:multi_trans,
                    order = 1;
                CREATE step:branch_b SET
                    name = "Branch B",
                    workflow_id = workflow:multi_trans,
                    order = 1
            "#,
            )
            .await
            .unwrap();

        // Set multiple transitions from start
        let result = client
            .query(
                r#"
                UPDATE step:start SET
                    transitions_to = [step:branch_a, step:branch_b]
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Multiple transitions failed: {:?}",
            result.err()
        );

        // Verify multiple transitions
        #[derive(Debug, serde::Deserialize)]
        struct TransitionRow {
            transitions_to: Vec<surrealdb::sql::Thing>,
        }

        let mut query_result = client
            .query("SELECT transitions_to FROM step:start")
            .await
            .unwrap();

        let row: Option<TransitionRow> = query_result.take(0).unwrap();
        let row = row.expect("Step should exist");
        assert_eq!(row.transitions_to.len(), 2, "Should have two transitions");
    }

    #[tokio::test]
    async fn test_step_query_by_workflow() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow
        client
            .query(
                r#"
                CREATE workflow:query_wf SET
                    name = "Query Workflow"
            "#,
            )
            .await
            .unwrap();

        // Create multiple steps for the workflow
        client
            .query(
                r#"
                CREATE step:q1 SET name = "Step 1", workflow_id = workflow:query_wf, order = 0;
                CREATE step:q2 SET name = "Step 2", workflow_id = workflow:query_wf, order = 1;
                CREATE step:q3 SET name = "Step 3", workflow_id = workflow:query_wf, order = 2
            "#,
            )
            .await
            .unwrap();

        // Query steps for the workflow
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct StepRow {
            name: String,
            order: i32,
        }

        let mut result = client
            .query(
                "SELECT name, order FROM step WHERE workflow_id = workflow:query_wf ORDER BY order",
            )
            .await
            .unwrap();

        let rows: Vec<StepRow> = result.take(0).unwrap();
        assert_eq!(rows.len(), 3, "Should have 3 steps for the workflow");
        assert_eq!(rows[0].name, "Step 1");
        assert_eq!(rows[1].name, "Step 2");
        assert_eq!(rows[2].name, "Step 3");
    }

    #[tokio::test]
    async fn test_step_is_final_flag() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create workflow
        client
            .query(
                r#"
                CREATE workflow:final_test SET
                    name = "Final Test Workflow"
            "#,
            )
            .await
            .unwrap();

        // Create steps with different is_final values
        client
            .query(
                r#"
                CREATE step:not_final SET
                    name = "Not Final",
                    workflow_id = workflow:final_test,
                    is_final = false;
                CREATE step:is_final SET
                    name = "Is Final",
                    workflow_id = workflow:final_test,
                    is_final = true
            "#,
            )
            .await
            .unwrap();

        // Query final steps
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct FinalRow {
            name: String,
            is_final: bool,
        }

        let mut result = client
            .query("SELECT name, is_final FROM step WHERE workflow_id = workflow:final_test AND is_final = true")
            .await
            .unwrap();

        let rows: Vec<FinalRow> = result.take(0).unwrap();
        assert_eq!(rows.len(), 1, "Should have 1 final step");
        assert_eq!(rows[0].name, "Is Final");
    }

    // StatusSchema table tests
    #[test]
    fn test_status_schema_sql_constant_defined() {
        assert!(!sql::DEFINE_STATUS_SCHEMA_TABLE.is_empty());
    }

    #[test]
    fn test_status_schema_sql_contains_expected_definitions() {
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("DEFINE TABLE"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("status_schema"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("SCHEMAFULL"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("name"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("description"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("is_default"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("statuses"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("progressions"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("created_at"));
        assert!(sql::DEFINE_STATUS_SCHEMA_TABLE.contains("updated_at"));
    }

    #[tokio::test]
    async fn test_status_schema_table_accepts_valid_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert a valid status schema
        let result = client
            .query(
                r#"
                CREATE status_schema SET
                    name = "default",
                    description = "Default status schema",
                    is_default = true,
                    statuses = [
                        {
                            name: "backlog",
                            label: "Backlog",
                            description: "Items waiting to be prioritized",
                            color: "gray",
                            is_terminal: false,
                            unblocks_dependents: false,
                            order: 0
                        },
                        {
                            name: "done",
                            label: "Done",
                            description: "Completed",
                            color: "green",
                            is_terminal: true,
                            unblocks_dependents: true,
                            order: 1
                        }
                    ],
                    progressions = [
                        {
                            from_status: "backlog",
                            to_status: "done",
                            label: "Complete",
                            requires_validation: false
                        }
                    ]
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Valid status schema insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_status_schema_table_accepts_minimal_data() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Insert with only required field (name)
        let result = client
            .query(
                r#"
                CREATE status_schema SET
                    name = "minimal"
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Minimal status schema insert failed: {:?}",
            result.err()
        );

        // Verify defaults were applied
        #[derive(Debug, serde::Deserialize)]
        struct SchemaRow {
            name: String,
            is_default: bool,
            statuses: Vec<serde_json::Value>,
            progressions: Vec<serde_json::Value>,
        }

        let mut result = client
            .query("SELECT name, is_default, statuses, progressions FROM status_schema WHERE name = 'minimal'")
            .await
            .unwrap();

        let row: Option<SchemaRow> = result.take(0).unwrap();
        let row = row.expect("Schema should exist");

        assert_eq!(row.name, "minimal");
        assert!(!row.is_default, "is_default should default to false");
        assert!(row.statuses.is_empty(), "statuses should default to empty");
        assert!(
            row.progressions.is_empty(),
            "progressions should default to empty"
        );
    }

    #[tokio::test]
    async fn test_status_schema_timestamps_auto_populated() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create schema without timestamps
        client
            .query(
                r#"
                CREATE status_schema:timestamps_test SET
                    name = "timestamp_test"
            "#,
            )
            .await
            .unwrap();

        // Verify timestamps were auto-populated
        #[derive(Debug, serde::Deserialize)]
        struct TimestampRow {
            created_at: String,
            updated_at: String,
        }

        let mut result = client
            .query("SELECT created_at, updated_at FROM status_schema:timestamps_test")
            .await
            .unwrap();

        let row: Option<TimestampRow> = result.take(0).unwrap();
        let row = row.expect("Schema should exist");

        assert!(
            !row.created_at.is_empty(),
            "created_at should be auto-populated"
        );
        assert!(
            !row.updated_at.is_empty(),
            "updated_at should be auto-populated"
        );
    }

    #[tokio::test]
    async fn test_status_schema_can_have_multiple_schemas() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create multiple schemas
        client
            .query(
                r#"
                CREATE status_schema:agile SET
                    name = "agile",
                    is_default = false;
                CREATE status_schema:kanban SET
                    name = "kanban",
                    is_default = false;
                CREATE status_schema:default SET
                    name = "default",
                    is_default = true
            "#,
            )
            .await
            .unwrap();

        // Query all schemas
        let mut result = client
            .query("SELECT name FROM status_schema ORDER BY name")
            .await
            .unwrap();

        #[derive(Debug, serde::Deserialize)]
        struct NameRow {
            name: String,
        }

        let rows: Vec<NameRow> = result.take(0).unwrap();
        assert_eq!(rows.len(), 3, "Should have 3 schemas");
        assert_eq!(rows[0].name, "agile");
        assert_eq!(rows[1].name, "default");
        assert_eq!(rows[2].name, "kanban");
    }

    // ========================================
    // ValidationGate table tests
    // ========================================

    #[test]
    fn test_validation_gate_sql_constant_defined() {
        assert!(!sql::DEFINE_VALIDATION_GATE_TABLE.is_empty());
    }

    #[test]
    fn test_validation_gate_sql_contains_expected_definitions() {
        let sql = sql::DEFINE_VALIDATION_GATE_TABLE;
        assert!(sql.contains("DEFINE TABLE IF NOT EXISTS validation_gate"));
        assert!(sql.contains("DEFINE FIELD name ON validation_gate"));
        assert!(sql.contains("DEFINE FIELD gate_type ON validation_gate"));
        assert!(sql.contains("DEFINE FIELD mechanism ON validation_gate"));
        assert!(sql.contains("DEFINE FIELD child_gates ON validation_gate"));
        assert!(sql.contains("DEFINE FIELD command ON validation_gate"));
        assert!(sql.contains("DEFINE FIELD agent_config ON validation_gate"));
    }

    #[tokio::test]
    async fn test_validation_gate_table_accepts_command_execution() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create a command execution gate
        let result = client
            .query(
                r#"
                CREATE validation_gate:test_cmd SET
                    name = "Test Runner",
                    gate_type = "command_execution",
                    command = "cargo test",
                    timeout_seconds = 60
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Valid command execution gate insert failed: {:?}",
            result.err()
        );

        // Verify the data
        #[derive(Debug, serde::Deserialize)]
        struct GateRow {
            name: String,
            gate_type: String,
            command: Option<String>,
            timeout_seconds: Option<i64>,
        }

        let mut result = client
            .query("SELECT name, gate_type, command, timeout_seconds FROM validation_gate:test_cmd")
            .await
            .unwrap();

        let row: Option<GateRow> = result.take(0).unwrap();
        let row = row.expect("Gate should exist");

        assert_eq!(row.name, "Test Runner");
        assert_eq!(row.gate_type, "command_execution");
        assert_eq!(row.command, Some("cargo test".to_string()));
        assert_eq!(row.timeout_seconds, Some(60));
    }

    #[tokio::test]
    async fn test_validation_gate_table_accepts_manual_approval() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create a manual approval gate
        let result = client
            .query(
                r#"
                CREATE validation_gate:test_manual SET
                    name = "Code Review",
                    gate_type = "manual_approval",
                    description = "Requires human approval before proceeding"
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Valid manual approval gate insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_validation_gate_table_accepts_composite() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create child gates first
        client
            .query(
                r#"
                CREATE validation_gate:child1 SET
                    name = "Child Gate 1",
                    gate_type = "manual_approval";
                CREATE validation_gate:child2 SET
                    name = "Child Gate 2",
                    gate_type = "command_execution",
                    command = "echo test"
            "#,
            )
            .await
            .unwrap();

        // Create a composite gate
        let result = client
            .query(
                r#"
                CREATE validation_gate:composite SET
                    name = "Combined Gate",
                    gate_type = "composite",
                    mechanism = "all_must_pass",
                    child_gates = [validation_gate:child1, validation_gate:child2]
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Valid composite gate insert failed: {:?}",
            result.err()
        );
    }

    #[tokio::test]
    async fn test_validation_gate_table_rejects_invalid_gate_type() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Try to create gate with invalid type
        let result = client
            .query(
                r#"
                CREATE validation_gate:invalid SET
                    name = "Invalid",
                    gate_type = "invalid_type"
            "#,
            )
            .await;

        // The query should fail due to ASSERT constraint
        assert!(
            result.is_err() || {
                let mut r = result.unwrap();
                let check: Result<Option<serde_json::Value>, _> = r.take(0);
                check.is_err()
            }
        );
    }

    #[tokio::test]
    async fn test_validation_gate_table_rejects_invalid_mechanism() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Try to create gate with invalid mechanism
        let result = client
            .query(
                r#"
                CREATE validation_gate:invalid SET
                    name = "Invalid",
                    gate_type = "composite",
                    mechanism = "invalid_mechanism"
            "#,
            )
            .await;

        // The query should fail due to ASSERT constraint
        assert!(
            result.is_err() || {
                let mut r = result.unwrap();
                let check: Result<Option<serde_json::Value>, _> = r.take(0);
                check.is_err()
            }
        );
    }

    #[tokio::test]
    async fn test_workflow_validation_gate_id_field() {
        let client = setup_test_db().await;
        init_schema(&client).await.unwrap();

        // Create a validation gate
        client
            .query(
                r#"
                CREATE validation_gate:test_gate SET
                    name = "Test Gate",
                    gate_type = "manual_approval"
            "#,
            )
            .await
            .unwrap();

        // Create a workflow with the validation_gate_id
        let result = client
            .query(
                r#"
                CREATE workflow:test_workflow SET
                    name = "Test Workflow",
                    validation_gate_id = validation_gate:test_gate
            "#,
            )
            .await;

        assert!(
            result.is_ok(),
            "Workflow with validation_gate_id failed: {:?}",
            result.err()
        );

        // Verify the workflow has the gate reference
        #[derive(Debug, serde::Deserialize)]
        struct WorkflowRow {
            name: String,
            validation_gate_id: Option<surrealdb::sql::Thing>,
        }

        let mut result = client
            .query("SELECT name, validation_gate_id FROM workflow:test_workflow")
            .await
            .unwrap();

        let row: Option<WorkflowRow> = result.take(0).unwrap();
        let row = row.expect("Workflow should exist");

        assert_eq!(row.name, "Test Workflow");
        assert!(row.validation_gate_id.is_some());
    }
}
