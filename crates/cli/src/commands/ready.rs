//! Ready command for showing highest-level actionable items
//!
//! Implements the `vtb ready` command to show entry points for work.
//! Shows highest-level unblocked items prioritized by hierarchy (epic > ticket > task).

use clap::Args;
use vertebrae_core::{ServiceError, TaskService};
use vertebrae_db::TaskSummary;

#[cfg(test)]
use {vertebrae_core::DefaultTaskService, vertebrae_db::Level};

/// Show highest-level actionable items
#[derive(Debug, Args)]
pub struct ReadyCommand {}

/// Result of the ready command execution
#[derive(Debug)]
pub struct ReadyResult {
    /// Tasks that are ready to start (backlog status, unblocked, work not started on children)
    pub backlog_ready: Vec<TaskSummary>,
}

impl std::fmt::Display for ReadyResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.backlog_ready.is_empty() {
            return write!(f, "No actionable items found.");
        }

        writeln!(f, "Ready to start (backlog):")?;
        for task in &self.backlog_ready {
            writeln!(f, "  {}  {}  {}", task.id, task.level, task.title)?;
        }

        Ok(())
    }
}

impl ReadyCommand {
    /// Execute the ready command.
    ///
    /// Finds and returns actionable entry points:
    /// - Backlog items: ready to start work (unblocked, no work started on children)
    ///
    /// For items with hierarchies, only shows the highest-level entry point.
    /// An item is excluded if any of its children have work started
    /// (status in: in_progress, pending_review, done).
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if database operations fail.
    pub async fn execute(&self, service: &dyn TaskService) -> Result<ReadyResult, ServiceError> {
        let db = service.database();

        // Get ready items for backlog status (ready to start work)
        let backlog_ready = db.list_ready_items("backlog").await?;

        Ok(ReadyResult { backlog_ready })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_db::{Database, Task};

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> DefaultTaskService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultTaskService::new(db)
    }

    /// Helper to create a task in the database
    /// Status is derived from current_step_id - uses the default workflow steps
    async fn create_task(
        service: &DefaultTaskService,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
    ) {
        let db = service.database();
        let level = match level {
            "epic" => Level::Epic,
            "ticket" => Level::Ticket,
            "task" => Level::Task,
            _ => Level::Task,
        };

        // All tasks use the default workflow. Status is derived from current_step_id.
        let workflow_id = Some(surrealdb::sql::Thing::from(("workflow", "default")));

        // Set up workflow step - "backlog" is index 0, others have specific step IDs
        let (current_step, current_step_id) = match status {
            "backlog" => (Some(0), None),
            "in_progress" => (
                Some(1),
                Some(surrealdb::sql::Thing::from(("step", "default_in_progress"))),
            ),
            "pending_review" => (
                Some(2),
                Some(surrealdb::sql::Thing::from((
                    "step",
                    "default_pending_review",
                ))),
            ),
            "done" => (
                Some(3),
                Some(surrealdb::sql::Thing::from(("step", "default_done"))),
            ),
            "rejected" => (
                Some(4),
                Some(surrealdb::sql::Thing::from(("step", "default_rejected"))),
            ),
            _ => (Some(0), None),
        };

        let task = Task {
            id: None,
            title: title.to_string(),
            description: None,
            level,
            priority: None,
            tags: vec![],
            sections: vec![],
            code_refs: vec![],
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
            needs_human_review: None,
            revision_feedback: None,
            rejection_reason: None,
            workflow_id,
            current_step,
            current_step_id,
        };

        db.tasks().create(id, &task).await.unwrap();
    }

    /// Helper to create a child_of relationship (child -> parent)
    async fn create_child_of(service: &DefaultTaskService, child_id: &str, parent_id: &str) {
        let db = service.database();
        db.relationships()
            .create_child_of(child_id, parent_id)
            .await
            .unwrap();
    }

    /// Helper to create a depends_on relationship (dependent -> dependency)
    async fn create_depends_on(
        service: &DefaultTaskService,
        dependent_id: &str,
        dependency_id: &str,
    ) {
        let db = service.database();
        db.relationships()
            .create_depends_on(dependent_id, dependency_id)
            .await
            .unwrap();
    }

    #[test]
    fn test_ready_command_debug() {
        let cmd = ReadyCommand {};
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("ReadyCommand"));
    }

    #[test]
    fn test_ready_result_display_empty() {
        let result = ReadyResult {
            backlog_ready: vec![],
        };
        assert_eq!(result.to_string(), "No actionable items found.");
    }

    #[test]
    fn test_ready_result_display_backlog_only() {
        let result = ReadyResult {
            backlog_ready: vec![TaskSummary {
                id: "def456".to_string(),
                title: "Backlog Task".to_string(),
                level: Level::Epic,
                status: "backlog".to_string(),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                created_at: chrono::Utc::now(),
                workflow_name: None,
                step_name: None,
            }],
        };

        let output = result.to_string();
        assert!(output.contains("Ready to start (backlog):"));
        assert!(output.contains("def456"));
        assert!(output.contains("Backlog Task"));
        assert!(!output.contains("Ready to work"));
    }

    #[test]
    fn test_ready_result_display_both_sections() {
        let now = chrono::Utc::now();
        let result = ReadyResult {
            backlog_ready: vec![TaskSummary {
                id: "abc123".to_string(),
                title: "Todo Task".to_string(),
                level: Level::Task,
                status: "in_progress".to_string(),
                priority: None,
                tags: vec![],
                needs_human_review: None,
                created_at: now,
                workflow_name: None,
                step_name: None,
            }],
        };

        let output = result.to_string();
        assert!(output.contains("Ready to start (backlog):"));
        assert!(output.contains("abc123"));
        assert!(output.contains("Todo Task"));
    }

    #[tokio::test]
    async fn test_ready_empty_database() {
        let service = setup_test_service().await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_single_backlog_task() {
        let service = setup_test_service().await;

        create_task(&service, "task1", "Backlog Task", "task", "backlog").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        assert!(result.backlog_ready.len() == 1);
        assert_eq!(result.backlog_ready[0].id, "task1");
    }

    #[tokio::test]
    async fn test_ready_excludes_in_progress() {
        let service = setup_test_service().await;

        create_task(&service, "task1", "In Progress Task", "task", "in_progress").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_excludes_done() {
        let service = setup_test_service().await;

        create_task(&service, "task1", "Done Task", "task", "done").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_shows_parent_not_child_when_no_work_started() {
        let service = setup_test_service().await;

        // Create epic with backlog child - should show epic only
        create_task(&service, "epic1", "Epic", "epic", "backlog").await;
        create_task(&service, "ticket1", "Ticket", "ticket", "backlog").await;
        create_child_of(&service, "ticket1", "epic1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        // Should show only epic1, not ticket1
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "epic1");
    }

    #[tokio::test]
    async fn test_ready_excludes_parent_when_child_work_started() {
        let service = setup_test_service().await;

        // Create epic in backlog with in_progress child - epic should not show
        create_task(&service, "epic1", "Epic", "epic", "backlog").await;
        create_task(&service, "ticket1", "Ticket", "ticket", "in_progress").await;
        create_child_of(&service, "ticket1", "epic1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        // Epic should be excluded because work has started on a child
        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_excludes_blocked_tasks() {
        let service = setup_test_service().await;

        // Create blocker (backlog) and blocked task (backlog)
        create_task(&service, "blocker", "Blocker", "task", "backlog").await;
        create_task(&service, "blocked", "Blocked", "task", "backlog").await;
        create_depends_on(&service, "blocked", "blocker").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        // Should show only blocker (blocked is blocked by an incomplete task)
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "blocker");
    }

    #[tokio::test]
    async fn test_ready_includes_unblocked_tasks() {
        let service = setup_test_service().await;

        // Create blocker (done) and blocked task (backlog)
        create_task(&service, "blocker", "Blocker", "task", "done").await;
        create_task(&service, "blocked", "Blocked", "task", "backlog").await;
        create_depends_on(&service, "blocked", "blocker").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        // Should show blocked task (blocker is done)
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "blocked");
    }

    #[tokio::test]
    async fn test_ready_prioritizes_epic_over_ticket_over_task() {
        let service = setup_test_service().await;

        // Create independent tasks at all levels - all backlog
        create_task(&service, "task1", "Task", "task", "backlog").await;
        create_task(&service, "ticket1", "Ticket", "ticket", "backlog").await;
        create_task(&service, "epic1", "Epic", "epic", "backlog").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        // Should show all three since they're independent
        assert_eq!(result.backlog_ready.len(), 3);

        // Verify all are present
        let ids: Vec<&str> = result.backlog_ready.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"epic1"));
        assert!(ids.contains(&"ticket1"));
        assert!(ids.contains(&"task1"));
    }

    #[tokio::test]
    async fn test_ready_deep_hierarchy() {
        let service = setup_test_service().await;

        // Create epic -> ticket -> task hierarchy, all backlog
        create_task(&service, "epic1", "Epic", "epic", "backlog").await;
        create_task(&service, "ticket1", "Ticket", "ticket", "backlog").await;
        create_task(&service, "task1", "Task", "task", "backlog").await;
        create_child_of(&service, "ticket1", "epic1").await;
        create_child_of(&service, "task1", "ticket1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        // Should show only epic1 (highest level entry point)
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "epic1");
    }

    #[tokio::test]
    async fn test_ready_work_started_deep_in_hierarchy() {
        let service = setup_test_service().await;

        // Create epic -> ticket -> task hierarchy
        // task is in_progress, so epic should be excluded
        create_task(&service, "epic1", "Epic", "epic", "backlog").await;
        create_task(&service, "ticket1", "Ticket", "ticket", "backlog").await;
        create_task(&service, "task1", "Task", "task", "in_progress").await;
        create_child_of(&service, "ticket1", "epic1").await;
        create_child_of(&service, "task1", "ticket1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        // Should show nothing (work started deep in hierarchy)
        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_child_shows_when_parent_has_work_elsewhere() {
        let service = setup_test_service().await;

        // Create epic with two tickets:
        // - ticket1: in_progress (work started)
        // - ticket2: backlog (ready to start)
        // ticket2 should show (it's an entry point, not under the in_progress one)
        create_task(&service, "epic1", "Epic", "epic", "backlog").await;
        create_task(&service, "ticket1", "Ticket 1", "ticket", "in_progress").await;
        create_task(&service, "ticket2", "Ticket 2", "ticket", "backlog").await;
        create_child_of(&service, "ticket1", "epic1").await;
        create_child_of(&service, "ticket2", "epic1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&service).await.unwrap();

        // Epic has work started (ticket1 is in_progress), so it shouldn't show
        // But ticket2 should show (it's the entry point for its subtree)
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "ticket2");
    }
}
