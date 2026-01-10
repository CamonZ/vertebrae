//! Transition-to command for all state transitions
//!
//! Implements the `vtb transition-to` command to handle all task state transitions
//! with proper validation. This consolidates the functionality of start, submit,
//! done, triage, and reject commands into a single unified interface.

use clap::{Args, ValueEnum};
use vertebrae_db::{
    Database, DbError, Status, TaskUpdate, TriageValidationResult, TriageValidator,
};

/// Target status for the transition-to command
#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
pub enum TargetStatus {
    /// Transition to todo status (from backlog)
    Todo,
    /// Transition to in_progress status (from todo or pending_review)
    #[value(name = "in_progress")]
    InProgress,
    /// Transition to pending_review status (from in_progress)
    #[value(name = "pending_review")]
    PendingReview,
    /// Transition to done status (from pending_review)
    Done,
    /// Transition to rejected status (from todo)
    Rejected,
}

impl TargetStatus {
    /// Convert to the database Status enum
    pub fn to_status(&self) -> Status {
        match self {
            TargetStatus::Todo => Status::Todo,
            TargetStatus::InProgress => Status::InProgress,
            TargetStatus::PendingReview => Status::PendingReview,
            TargetStatus::Done => Status::Done,
            TargetStatus::Rejected => Status::Rejected,
        }
    }

    /// Get the string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetStatus::Todo => "todo",
            TargetStatus::InProgress => "in_progress",
            TargetStatus::PendingReview => "pending_review",
            TargetStatus::Done => "done",
            TargetStatus::Rejected => "rejected",
        }
    }
}

/// Transition a task to a specific status
#[derive(Debug, Args)]
pub struct TransitionToCommand {
    /// Task ID to transition (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Target status to transition to
    #[arg(required = true, value_enum)]
    pub target: TargetStatus,

    /// Optional reason for rejection (only used with 'rejected' target)
    #[arg(short, long)]
    pub reason: Option<String>,

    /// Override warnings (but not errors) when transitioning to todo
    #[arg(short, long)]
    pub force: bool,

    /// Bypass all validation when transitioning to todo (escape hatch)
    #[arg(long)]
    pub skip_validation: bool,
}

/// Result of the transition-to command execution
#[derive(Debug)]
pub struct TransitionToResult {
    /// The task ID that was transitioned
    pub id: String,
    /// The target status
    pub target: TargetStatus,
    /// Whether the task was already in the target status
    pub already_in_target: bool,
    /// List of incomplete dependencies (warnings, for in_progress)
    pub incomplete_deps: Vec<(String, String, String)>, // (id, title, status)
    /// List of tasks that are now unblocked (for done)
    pub unblocked_tasks: Vec<(String, String)>, // (id, title)
    /// The reason provided (for rejected)
    pub reason: Option<String>,
    /// Validation result (for todo transition)
    pub validation: Option<TriageValidationResult>,
    /// Whether validation was skipped
    pub validation_skipped: bool,
    /// Whether warnings were forced
    pub warnings_forced: bool,
}

impl std::fmt::Display for TransitionToResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Show validation skipped notice
        if self.validation_skipped {
            writeln!(f, "Note: Validation skipped (--skip-validation)")?;
            writeln!(f)?;
        }

        // Show validation results for todo transitions
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

        // Show warnings for incomplete deps (for in_progress)
        if !self.incomplete_deps.is_empty() {
            writeln!(f, "Warning: Task depends on incomplete tasks:")?;
            for (id, title, status) in &self.incomplete_deps {
                writeln!(f, "  - {} ({}) [{}]", id, title, status)?;
            }
            writeln!(f)?;
        }

        // Main result message
        if self.already_in_target {
            match self.target {
                TargetStatus::Todo => write!(f, "Task '{}' is already in todo", self.id)?,
                TargetStatus::InProgress => {
                    write!(f, "Warning: Task '{}' is already in progress", self.id)?
                }
                TargetStatus::PendingReview => {
                    write!(f, "Task '{}' is already pending review", self.id)?
                }
                TargetStatus::Done => write!(f, "Task '{}' is already done", self.id)?,
                TargetStatus::Rejected => {
                    write!(f, "Task '{}' is already rejected", self.id)?;
                    if let Some(reason) = &self.reason {
                        write!(f, " (added reason: {})", reason)?;
                    }
                }
            }
        } else {
            match self.target {
                TargetStatus::Todo => write!(f, "Triaged task: {}", self.id)?,
                TargetStatus::InProgress => write!(f, "Started task: {}", self.id)?,
                TargetStatus::PendingReview => write!(f, "Submitted task for review: {}", self.id)?,
                TargetStatus::Done => write!(f, "Completed task: {}", self.id)?,
                TargetStatus::Rejected => {
                    write!(f, "Rejected task: {}", self.id)?;
                    if let Some(reason) = &self.reason {
                        write!(f, "\nReason: {}", reason)?;
                    }
                }
            }
        }

        // Show unblocked tasks if any (for done)
        if !self.unblocked_tasks.is_empty() {
            writeln!(f)?;
            writeln!(f)?;
            writeln!(f, "Unblocked tasks:")?;
            for (id, title) in &self.unblocked_tasks {
                writeln!(f, "  - {} ({})", id, title)?;
            }
        }

        Ok(())
    }
}

impl TransitionToCommand {
    /// Execute the transition-to command.
    ///
    /// Transitions a task to the specified target status with proper validation.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The task with the given ID does not exist
    /// - The status transition is invalid
    /// - The task has incomplete children (for done transition)
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<TransitionToResult, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Fetch task and verify it exists
        let task = db
            .tasks()
            .get(&id)
            .await?
            .ok_or_else(|| DbError::NotFound {
                task_id: self.id.clone(),
            })?;

        let target_status = self.target.to_status();

        // Handle already in target status case
        if task.status == target_status {
            // For rejected, still add reason if provided
            if self.target == TargetStatus::Rejected {
                if let Some(reason) = &self.reason {
                    self.add_constraint_section(db, &id, reason).await?;
                }
                db.tasks().update_timestamp(&id).await?;
            }

            return Ok(TransitionToResult {
                id,
                target: self.target,
                already_in_target: true,
                incomplete_deps: vec![],
                unblocked_tasks: vec![],
                reason: self.reason.clone(),
                validation: None,
                validation_skipped: false,
                warnings_forced: false,
            });
        }

        // Validate the status transition
        db.tasks()
            .validate_status_transition(&id, &task.status, &target_status)?;

        // Execute target-specific logic
        match self.target {
            TargetStatus::Todo => self.execute_todo_transition(db, &id).await,
            TargetStatus::InProgress => self.execute_in_progress_transition(db, &id).await,
            TargetStatus::PendingReview => self.execute_pending_review_transition(db, &id).await,
            TargetStatus::Done => self.execute_done_transition(db, &id).await,
            TargetStatus::Rejected => self.execute_rejected_transition(db, &id).await,
        }
    }

    /// Execute transition to todo status
    ///
    /// Validates the task has required sections before transitioning.
    /// - Required sections (block if missing): testing_criterion (>=2), step (>=1), constraint (>=2)
    /// - Encouraged sections (warn but allow): anti_pattern (>=1), failure_test (>=1)
    /// - Recommended sections (note if missing): goal, context, current_behavior, desired_behavior
    ///
    /// Use --force to bypass warnings, --skip-validation to bypass all validation.
    async fn execute_todo_transition(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<TransitionToResult, DbError> {
        // If validation is skipped, proceed directly
        if self.skip_validation {
            let updates = TaskUpdate::new().with_status(Status::Todo);
            db.tasks().update(id, &updates).await?;

            return Ok(TransitionToResult {
                id: id.to_string(),
                target: self.target,
                already_in_target: false,
                incomplete_deps: vec![],
                unblocked_tasks: vec![],
                reason: None,
                validation: None,
                validation_skipped: true,
                warnings_forced: false,
            });
        }

        // Fetch the task to validate its sections
        let task = db.tasks().get(id).await?.ok_or_else(|| DbError::NotFound {
            task_id: id.to_string(),
        })?;

        // Run validation
        let validator = TriageValidator::new();
        let validation_result = validator.validate(&task);

        // Check for errors (block transition)
        if validation_result.has_errors() {
            return Err(DbError::TriageValidationFailed {
                task_id: id.to_string(),
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
        db.tasks().update(id, &updates).await?;

        Ok(TransitionToResult {
            id: id.to_string(),
            target: self.target,
            already_in_target: false,
            incomplete_deps: vec![],
            unblocked_tasks: vec![],
            reason: None,
            validation: Some(validation_result),
            validation_skipped: false,
            warnings_forced: self.force,
        })
    }

    /// Execute transition to in_progress status
    async fn execute_in_progress_transition(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<TransitionToResult, DbError> {
        // Check for incomplete dependencies (soft enforcement - warn only)
        let incomplete_deps = db.graph().get_incomplete_dependencies_info(id).await?;

        // Update status to in_progress and set started_at if not already set
        let updates = TaskUpdate::new()
            .with_status(Status::InProgress)
            .set_started_at_if_null();
        db.tasks().update(id, &updates).await?;

        Ok(TransitionToResult {
            id: id.to_string(),
            target: self.target,
            already_in_target: false,
            incomplete_deps,
            unblocked_tasks: vec![],
            reason: None,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        })
    }

    /// Execute transition to pending_review status
    async fn execute_pending_review_transition(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<TransitionToResult, DbError> {
        let updates = TaskUpdate::new().with_status(Status::PendingReview);
        db.tasks().update(id, &updates).await?;

        Ok(TransitionToResult {
            id: id.to_string(),
            target: self.target,
            already_in_target: false,
            incomplete_deps: vec![],
            unblocked_tasks: vec![],
            reason: None,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        })
    }

    /// Execute transition to done status
    async fn execute_done_transition(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<TransitionToResult, DbError> {
        // Check for incomplete descendants (hard enforcement - error if any exist)
        let incomplete_descendants = db.graph().get_incomplete_descendants(id).await?;

        if !incomplete_descendants.is_empty() {
            return Err(DbError::IncompleteChildren {
                task_id: id.to_string(),
                children: incomplete_descendants,
            });
        }

        // Find tasks that depend on this one and will become unblocked
        let unblocked_tasks = db.graph().get_unblocked_tasks(id).await?;

        // Mark task as done
        db.tasks().mark_done(id).await?;

        Ok(TransitionToResult {
            id: id.to_string(),
            target: self.target,
            already_in_target: false,
            incomplete_deps: vec![],
            unblocked_tasks,
            reason: None,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        })
    }

    /// Execute transition to rejected status
    async fn execute_rejected_transition(
        &self,
        db: &Database,
        id: &str,
    ) -> Result<TransitionToResult, DbError> {
        // Add constraint section with reason if provided
        if let Some(reason) = &self.reason {
            self.add_constraint_section(db, id, reason).await?;
        }

        // Update status to rejected
        db.tasks().update_status(id, Status::Rejected).await?;

        Ok(TransitionToResult {
            id: id.to_string(),
            target: self.target,
            already_in_target: false,
            incomplete_deps: vec![],
            unblocked_tasks: vec![],
            reason: self.reason.clone(),
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        })
    }

    /// Add a constraint section with the rejection reason.
    async fn add_constraint_section(
        &self,
        db: &Database,
        id: &str,
        reason: &str,
    ) -> Result<(), DbError> {
        let content = format!("REJECTED: {}", reason);
        db.tasks()
            .add_section(id, vertebrae_db::SectionType::Constraint, &content)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    /// Helper to create a test database
    async fn setup_test_db() -> (Database, std::path::PathBuf) {
        let temp_dir = env::temp_dir().join(format!(
            "vtb-transition-to-test-{}-{:?}-{}",
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let db = Database::connect(&temp_dir).await.unwrap();
        db.init().await.unwrap();

        (db, temp_dir)
    }

    /// Helper to create a task in the database
    async fn create_task(db: &Database, id: &str, title: &str, level: &str, status: &str) {
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

    /// Helper to create a child_of relationship (child -> parent)
    async fn create_child_of(db: &Database, child_id: &str, parent_id: &str) {
        let query = format!("RELATE task:{} -> child_of -> task:{}", child_id, parent_id);
        db.client().query(&query).await.unwrap();
    }

    /// Helper to create a depends_on relationship (dependent -> dependency)
    async fn create_depends_on(db: &Database, dependent_id: &str, dependency_id: &str) {
        let query = format!(
            "RELATE task:{} -> depends_on -> task:{}",
            dependent_id, dependency_id
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

    /// Helper to get started_at timestamp from database
    async fn get_started_at(db: &Database, id: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        db.tasks().get(id).await.unwrap().unwrap().started_at
    }

    /// Helper to get completed_at timestamp from database
    async fn get_completed_at(db: &Database, id: &str) -> Option<chrono::DateTime<chrono::Utc>> {
        db.tasks().get(id).await.unwrap().unwrap().completed_at
    }

    /// Helper to get constraint sections from a task
    async fn get_constraint_sections(db: &Database, id: &str) -> Vec<String> {
        let task = db.tasks().get(id).await.unwrap().unwrap();
        task.sections
            .iter()
            .filter(|s| s.section_type == vertebrae_db::SectionType::Constraint)
            .map(|s| s.content.clone())
            .collect()
    }

    /// Clean up test database
    fn cleanup(path: &std::path::Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    // ==========================================================================
    // transition-to todo tests
    // ==========================================================================

    #[tokio::test]
    async fn test_transition_to_todo_from_backlog() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "backlog").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Todo,
            reason: None,
            force: false,
            skip_validation: true, // Skip validation in unit tests
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Transition failed: {:?}", result.err());

        let transition_result = result.unwrap();
        assert_eq!(transition_result.id, "task1");
        assert_eq!(transition_result.target, TargetStatus::Todo);
        assert!(!transition_result.already_in_target);

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "todo");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_todo_from_in_progress_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Todo,
            reason: None,
            force: false,
            skip_validation: true, // Skip validation in unit tests
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

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_todo_from_done_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "done").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Todo,
            reason: None,
            force: false,
            skip_validation: true, // Skip validation in unit tests
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition { message, .. }) => {
                assert!(
                    message.contains("final state"),
                    "Expected 'final state' in error, got: {}",
                    message
                );
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_todo_already_todo() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Todo,
            reason: None,
            force: false,
            skip_validation: true, // Skip validation in unit tests
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let transition_result = result.unwrap();
        assert!(transition_result.already_in_target);

        cleanup(&temp_dir);
    }

    // ==========================================================================
    // transition-to in_progress tests
    // ==========================================================================

    #[tokio::test]
    async fn test_transition_to_in_progress_from_todo() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::InProgress,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Transition failed: {:?}", result.err());

        let transition_result = result.unwrap();
        assert_eq!(transition_result.id, "task1");
        assert!(!transition_result.already_in_target);
        assert!(transition_result.incomplete_deps.is_empty());

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        // Verify started_at was set
        let started_at = get_started_at(&db, "task1").await;
        assert!(started_at.is_some(), "started_at should be set");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_in_progress_from_pending_review() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::InProgress,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Transition failed: {:?}", result.err());

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_in_progress_from_backlog_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "backlog").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::InProgress,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition {
                from_status,
                to_status,
                ..
            }) => {
                assert_eq!(from_status, "backlog");
                assert_eq!(to_status, "in_progress");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "backlog");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_in_progress_with_incomplete_deps_warns() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "dep1", "Dependency Task", "task", "todo").await;
        create_task(&db, "task1", "Main Task", "task", "todo").await;
        create_depends_on(&db, "task1", "dep1").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::InProgress,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Start should succeed with warnings");

        let transition_result = result.unwrap();
        assert!(!transition_result.incomplete_deps.is_empty());
        assert_eq!(transition_result.incomplete_deps.len(), 1);

        let (dep_id, dep_title, dep_status) = &transition_result.incomplete_deps[0];
        assert_eq!(dep_id, "dep1");
        assert_eq!(dep_title, "Dependency Task");
        assert_eq!(dep_status, "todo");

        // Task should still be started despite incomplete deps
        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "in_progress");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_in_progress_preserves_started_at() {
        let (db, temp_dir) = setup_test_db().await;

        // Create a pending_review task with an existing started_at
        let query = r#"CREATE task:task1 SET
            title = "Test Task",
            level = "task",
            status = "pending_review",
            tags = [],
            sections = [],
            refs = [],
            started_at = d'2025-01-01T00:00:00Z'"#;
        db.client().query(query).await.unwrap();

        let original_started_at = get_started_at(&db, "task1").await;
        assert!(original_started_at.is_some());

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::InProgress,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let new_started_at = get_started_at(&db, "task1").await;
        assert_eq!(
            original_started_at, new_started_at,
            "started_at should be preserved"
        );

        cleanup(&temp_dir);
    }

    // ==========================================================================
    // transition-to pending_review tests
    // ==========================================================================

    #[tokio::test]
    async fn test_transition_to_pending_review_from_in_progress() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::PendingReview,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Transition failed: {:?}", result.err());

        let transition_result = result.unwrap();
        assert!(!transition_result.already_in_target);

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "pending_review");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_pending_review_from_todo_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::PendingReview,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition {
                from_status,
                to_status,
                ..
            }) => {
                assert_eq!(from_status, "todo");
                assert_eq!(to_status, "pending_review");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    // ==========================================================================
    // transition-to done tests
    // ==========================================================================

    #[tokio::test]
    async fn test_transition_to_done_from_pending_review() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "pending_review").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Done,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Transition failed: {:?}", result.err());

        let transition_result = result.unwrap();
        assert!(!transition_result.already_in_target);
        assert!(transition_result.unblocked_tasks.is_empty());

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "done");

        // Verify completed_at was set
        let completed_at = get_completed_at(&db, "task1").await;
        assert!(completed_at.is_some(), "completed_at should be set");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_done_from_in_progress_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Done,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition {
                from_status,
                to_status,
                ..
            }) => {
                assert_eq!(from_status, "in_progress");
                assert_eq!(to_status, "done");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_done_with_incomplete_children_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "parent", "Parent Task", "ticket", "pending_review").await;
        create_task(&db, "child1", "Child Task", "task", "todo").await;
        create_child_of(&db, "child1", "parent").await;

        let cmd = TransitionToCommand {
            id: "parent".to_string(),
            target: TargetStatus::Done,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::IncompleteChildren { task_id, children }) => {
                assert_eq!(task_id, "parent");
                assert_eq!(children.len(), 1);
                assert_eq!(children[0].id, "child1");
                assert_eq!(children[0].status, "todo");
            }
            Err(other) => panic!("Expected IncompleteChildren error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        let status = get_task_status(&db, "parent").await;
        assert_eq!(status, "pending_review");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_done_unblocks_dependent_tasks() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "blocker", "Blocker Task", "task", "pending_review").await;
        create_task(&db, "dependent", "Dependent Task", "task", "backlog").await;
        create_depends_on(&db, "dependent", "blocker").await;

        let cmd = TransitionToCommand {
            id: "blocker".to_string(),
            target: TargetStatus::Done,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Transition failed: {:?}", result.err());

        let transition_result = result.unwrap();
        assert!(!transition_result.unblocked_tasks.is_empty());
        assert_eq!(transition_result.unblocked_tasks.len(), 1);

        let (unblocked_id, unblocked_title) = &transition_result.unblocked_tasks[0];
        assert_eq!(unblocked_id, "dependent");
        assert_eq!(unblocked_title, "Dependent Task");

        cleanup(&temp_dir);
    }

    // ==========================================================================
    // transition-to rejected tests
    // ==========================================================================

    #[tokio::test]
    async fn test_transition_to_rejected_from_todo() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Rejected,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Transition failed: {:?}", result.err());

        let transition_result = result.unwrap();
        assert!(!transition_result.already_in_target);
        assert!(transition_result.reason.is_none());

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "rejected");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_rejected_with_reason() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "todo").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Rejected,
            reason: Some("Out of scope".to_string()),
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Transition failed: {:?}", result.err());

        let transition_result = result.unwrap();
        assert_eq!(transition_result.reason, Some("Out of scope".to_string()));

        // Verify constraint section was added
        let constraints = get_constraint_sections(&db, "task1").await;
        assert_eq!(constraints.len(), 1);
        assert_eq!(constraints[0], "REJECTED: Out of scope");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "rejected");

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_rejected_from_in_progress_fails() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "in_progress").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Rejected,
            reason: None,
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidStatusTransition {
                from_status,
                to_status,
                ..
            }) => {
                assert_eq!(from_status, "in_progress");
                assert_eq!(to_status, "rejected");
            }
            Err(other) => panic!("Expected InvalidStatusTransition error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_rejected_already_rejected_adds_reason() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "rejected").await;

        let cmd = TransitionToCommand {
            id: "task1".to_string(),
            target: TargetStatus::Rejected,
            reason: Some("Additional reason".to_string()),
            force: false,
            skip_validation: false,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok());

        let transition_result = result.unwrap();
        assert!(transition_result.already_in_target);
        assert_eq!(
            transition_result.reason,
            Some("Additional reason".to_string())
        );

        // Verify constraint section was added even for already rejected task
        let constraints = get_constraint_sections(&db, "task1").await;
        assert_eq!(constraints.len(), 1);
        assert_eq!(constraints[0], "REJECTED: Additional reason");

        cleanup(&temp_dir);
    }

    // ==========================================================================
    // Common tests
    // ==========================================================================

    #[tokio::test]
    async fn test_transition_to_nonexistent_task_fails() {
        let (db, temp_dir) = setup_test_db().await;

        let cmd = TransitionToCommand {
            id: "nonexistent".to_string(),
            target: TargetStatus::Todo,
            reason: None,
            force: false,
            skip_validation: true,
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::NotFound { task_id }) => {
                assert_eq!(task_id, "nonexistent");
            }
            Err(other) => panic!("Expected NotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }

        cleanup(&temp_dir);
    }

    #[tokio::test]
    async fn test_transition_to_case_insensitive_id() {
        let (db, temp_dir) = setup_test_db().await;

        create_task(&db, "task1", "Test Task", "task", "backlog").await;

        let cmd = TransitionToCommand {
            id: "TASK1".to_string(), // Uppercase
            target: TargetStatus::Todo,
            reason: None,
            force: false,
            skip_validation: true,
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        let status = get_task_status(&db, "task1").await;
        assert_eq!(status, "todo");

        cleanup(&temp_dir);
    }

    // ==========================================================================
    // Display tests
    // ==========================================================================

    #[test]
    fn test_transition_to_result_display_todo() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target: TargetStatus::Todo,
            already_in_target: false,
            incomplete_deps: vec![],
            unblocked_tasks: vec![],
            reason: None,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Triaged task: task1");
    }

    #[test]
    fn test_transition_to_result_display_in_progress() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target: TargetStatus::InProgress,
            already_in_target: false,
            incomplete_deps: vec![],
            unblocked_tasks: vec![],
            reason: None,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Started task: task1");
    }

    #[test]
    fn test_transition_to_result_display_in_progress_with_deps() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target: TargetStatus::InProgress,
            already_in_target: false,
            incomplete_deps: vec![(
                "dep1".to_string(),
                "Dependency".to_string(),
                "todo".to_string(),
            )],
            unblocked_tasks: vec![],
            reason: None,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning: Task depends on incomplete tasks"));
        assert!(output.contains("dep1"));
        assert!(output.contains("Dependency"));
        assert!(output.contains("todo"));
        assert!(output.contains("Started task: task1"));
    }

    #[test]
    fn test_transition_to_result_display_done_with_unblocked() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target: TargetStatus::Done,
            already_in_target: false,
            incomplete_deps: vec![],
            unblocked_tasks: vec![("dep1".to_string(), "Dependent Task".to_string())],
            reason: None,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Completed task: task1"));
        assert!(output.contains("Unblocked tasks:"));
        assert!(output.contains("dep1"));
        assert!(output.contains("Dependent Task"));
    }

    #[test]
    fn test_transition_to_result_display_rejected_with_reason() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target: TargetStatus::Rejected,
            already_in_target: false,
            incomplete_deps: vec![],
            unblocked_tasks: vec![],
            reason: Some("Out of scope".to_string()),
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Rejected task: task1"));
        assert!(output.contains("Reason: Out of scope"));
    }

    #[test]
    fn test_transition_to_result_display_already_in_target() {
        let result = TransitionToResult {
            id: "task1".to_string(),
            target: TargetStatus::InProgress,
            already_in_target: true,
            incomplete_deps: vec![],
            unblocked_tasks: vec![],
            reason: None,
            validation: None,
            validation_skipped: false,
            warnings_forced: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Warning: Task 'task1' is already in progress"));
    }

    #[test]
    fn test_target_status_as_str() {
        assert_eq!(TargetStatus::Todo.as_str(), "todo");
        assert_eq!(TargetStatus::InProgress.as_str(), "in_progress");
        assert_eq!(TargetStatus::PendingReview.as_str(), "pending_review");
        assert_eq!(TargetStatus::Done.as_str(), "done");
        assert_eq!(TargetStatus::Rejected.as_str(), "rejected");
    }

    #[test]
    fn test_target_status_to_status() {
        assert_eq!(TargetStatus::Todo.to_status(), Status::Todo);
        assert_eq!(TargetStatus::InProgress.to_status(), Status::InProgress);
        assert_eq!(
            TargetStatus::PendingReview.to_status(),
            Status::PendingReview
        );
        assert_eq!(TargetStatus::Done.to_status(), Status::Done);
        assert_eq!(TargetStatus::Rejected.to_status(), Status::Rejected);
    }

    #[test]
    fn test_transition_to_command_debug() {
        let cmd = TransitionToCommand {
            id: "test123".to_string(),
            target: TargetStatus::Todo,
            reason: None,
            force: false,
            skip_validation: false,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("TransitionToCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("Todo"),
            "Debug output should contain TransitionToCommand and its fields: {}",
            debug_str
        );
    }
}
