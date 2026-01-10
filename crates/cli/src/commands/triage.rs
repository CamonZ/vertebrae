//! Triage command for backwards compatibility
//!
//! Implements the `vtb triage` command as an alias for workflow advance operations.
//! This maintains backwards compatibility with the traditional status-based commands.

use clap::Args;
use vertebrae_db::{
    Database, DbError, DbResult, Status, TaskUpdate, TriageValidationResult, TriageValidator,
};

/// Triage a task (transition from backlog to todo)
///
/// This command is provided for backwards compatibility and operates on the task's
/// workflow assignment. It advances the task from the 'backlog' step to the 'todo' step.
#[derive(Debug, Args)]
pub struct TriageCommand {
    /// Task ID to triage (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Override warnings (but not errors) when triaging
    #[arg(short, long)]
    pub force: bool,

    /// Bypass all validation (escape hatch)
    #[arg(long)]
    pub skip_validation: bool,
}

/// Result of the triage command execution
#[derive(Debug)]
pub struct TriageResult {
    /// The task ID that was triaged
    pub id: String,
    /// Whether the task was already in todo
    pub already_triaged: bool,
    /// Validation result (for todo transition)
    pub validation: Option<TriageValidationResult>,
    /// Whether validation was skipped
    pub validation_skipped: bool,
    /// Whether warnings were forced
    pub warnings_forced: bool,
}

impl std::fmt::Display for TriageResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Show validation skipped notice
        if self.validation_skipped {
            writeln!(f, "Note: Validation skipped (--skip-validation)")?;
            writeln!(f)?;
        }

        // Show validation results for triage
        if let Some(validation) = &self.validation {
            // Show warnings and notes even if forced
            if validation.has_warnings() || validation.has_notes() {
                let warnings = validation.warnings();
                let notes = validation.notes();

                if !warnings.is_empty() {
                    if self.warnings_forced {
                        writeln!(f, "WARNINGS (forced with --force):")?;
                    } else {
                        writeln!(f, "WARNINGS ({}):", warnings.len())?;
                    }
                    for issue in warnings {
                        writeln!(f, "  - {}", issue.message)?;
                    }
                    writeln!(f)?;
                }

                if !notes.is_empty() {
                    writeln!(f, "NOTES ({}):", notes.len())?;
                    for issue in notes {
                        writeln!(f, "  - {}", issue.message)?;
                    }
                    writeln!(f)?;
                }
            }
        }

        // Main result message
        if self.already_triaged {
            write!(f, "Task '{}' is already in todo", self.id)
        } else {
            write!(f, "Triaged task: {}", self.id)
        }
    }
}

impl TriageCommand {
    /// Execute the triage command.
    ///
    /// Transitions a task from backlog to todo status, advancing it in the workflow.
    /// Validates the task has required sections before transitioning.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The status transition is invalid (not in backlog status)
    /// - The task fails validation (missing required sections)
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<TriageResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = db
            .tasks()
            .get(&id)
            .await?
            .ok_or_else(|| DbError::TaskNotFound {
                task_id: self.id.clone(),
            })?;

        // Check if already in todo
        if task.status == Status::Todo {
            return Ok(TriageResult {
                id,
                already_triaged: true,
                validation: None,
                validation_skipped: false,
                warnings_forced: false,
            });
        }

        // Validate the status transition
        validate_status_transition(&id, &task.status, &Status::Todo)?;

        // If validation is skipped, proceed directly
        if self.skip_validation {
            let updates = TaskUpdate::new().with_status(Status::Todo);
            db.tasks().update(&id, &updates).await?;

            // If task has a workflow assignment, advance the workflow step
            if task.workflow_id.is_some() {
                // Advance to step 1 (todo)
                db.tasks().update_current_step(&id, 1).await?;
            }

            return Ok(TriageResult {
                id,
                already_triaged: false,
                validation: None,
                validation_skipped: true,
                warnings_forced: false,
            });
        }

        // Run validation
        let validator = TriageValidator::new();
        let validation_result = validator.validate(&task);

        // Check for errors (block transition)
        if validation_result.has_errors() {
            return Err(DbError::TriageValidationFailed {
                task_id: id,
                error_count: validation_result.error_count(),
                warning_count: validation_result.warning_count(),
                note_count: validation_result.note_count(),
                details: format!("{}", validation_result),
            });
        }

        // Check for warnings (require --force unless in force mode)
        if validation_result.has_warnings() && !self.force {
            // Build a helpful error message
            let mut message = format!(
                "Task '{}' has validation warnings. Use --force to override:\n\n{}",
                id, validation_result
            );
            message.push_str("\nRun with --force to proceed anyway, or add the missing sections.");
            return Err(DbError::ValidationError { message });
        }

        // All checks passed - perform the transition
        let updates = TaskUpdate::new().with_status(Status::Todo);
        db.tasks().update(&id, &updates).await?;

        // If task has a workflow assignment, advance the workflow step
        if task.workflow_id.is_some() {
            // Advance to step 1 (todo)
            db.tasks().update_current_step(&id, 1).await?;
        }

        Ok(TriageResult {
            id,
            already_triaged: false,
            validation: Some(validation_result),
            validation_skipped: false,
            warnings_forced: self.force,
        })
    }
}

/// Validate a status transition for a task.
fn validate_status_transition(id: &str, from: &Status, to: &Status) -> DbResult<()> {
    from.validate_transition(to)
        .map_err(|message| DbError::InvalidStatusTransition {
            task_id: id.to_string(),
            from_status: from.as_str().to_string(),
            to_status: to.as_str().to_string(),
            message,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Database {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        db
    }

    /// Helper to create a task in the database
    async fn create_task(db: &Database, id: &str, title: &str, status: &str) {
        let query = format!(
            r#"CREATE task:{} SET
                title = "{}",
                level = "task",
                status = "{}",
                tags = [],
                sections = [],
                refs = []"#,
            id, title, status
        );
        db.client().query(&query).await.unwrap();
    }

    /// Helper to get task status from database
    async fn get_task_status(db: &Database, id: &str) -> String {
        db.tasks()
            .get(id)
            .await
            .unwrap()
            .unwrap()
            .status
            .as_str()
            .to_string()
    }

    #[tokio::test]
    async fn test_triage_from_backlog() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "backlog").await;

        let cmd = TriageCommand {
            id: "task1".to_string(),
            force: false,
            skip_validation: true, // Skip validation in unit tests
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Triage failed: {:?}", result.err());

        let triage_result = result.unwrap();
        assert_eq!(triage_result.id, "task1");
        assert!(!triage_result.already_triaged);

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "todo");
    }

    #[tokio::test]
    async fn test_triage_from_in_progress_fails() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "in_progress").await;

        let cmd = TriageCommand {
            id: "task1".to_string(),
            force: false,
            skip_validation: true,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition {
                from_status,
                to_status,
                ..
            }) => {
                assert_eq!(from_status, "in_progress");
                assert_eq!(to_status, "todo");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");
    }

    #[tokio::test]
    async fn test_triage_already_todo() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "todo").await;

        let cmd = TriageCommand {
            id: "task1".to_string(),
            force: false,
            skip_validation: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let triage_result = result.unwrap();
        assert!(triage_result.already_triaged);
    }

    #[tokio::test]
    async fn test_triage_nonexistent_task_fails() {
        let db = setup_test_db().await;

        let cmd = TriageCommand {
            id: "nonexistent".to_string(),
            force: false,
            skip_validation: true,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::TaskNotFound { task_id }) => {
                assert_eq!(task_id, "nonexistent");
            }
            Err(other) => panic!("Expected TaskNotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_triage_case_insensitive() {
        let db = setup_test_db().await;
        create_task(&db, "task1", "Test Task", "backlog").await;

        let cmd = TriageCommand {
            id: "TASK1".to_string(),
            force: false,
            skip_validation: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "todo");
    }

    #[test]
    fn test_triage_result_display() {
        let result = TriageResult {
            id: "task1".to_string(),
            already_triaged: false,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Triaged task: task1");
    }

    #[test]
    fn test_triage_result_display_already_triaged() {
        let result = TriageResult {
            id: "task1".to_string(),
            already_triaged: true,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Task 'task1' is already in todo"));
    }

    #[test]
    fn test_triage_result_display_validation_skipped() {
        let result = TriageResult {
            id: "task1".to_string(),
            already_triaged: false,
            validation: None,
            validation_skipped: true,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Note: Validation skipped (--skip-validation)"));
        assert!(output.contains("Triaged task: task1"));
    }
}
