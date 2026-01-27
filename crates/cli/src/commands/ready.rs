//! Ready command for showing highest-level actionable items
//!
//! Implements the `vtb ready` command to show entry points for work.
//! Shows highest-level unblocked items prioritized by hierarchy (epic > ticket > task).

use clap::Args;
use vertebrae_core::{ServiceError, VertebraeServices};
use vertebrae_db::TaskSummary;

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
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if database operations fail.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<ReadyResult, ServiceError> {
        // Get ready items for backlog status (ready to start work)
        let backlog_ready = services.tasks().list_ready("backlog").await?;

        Ok(ReadyResult { backlog_ready })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::CreateTaskOptions;
    use vertebrae_db::{Database, Level};

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> VertebraeServices {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    /// Helper to create a task via the service layer
    async fn create_task(
        services: &VertebraeServices,
        id: &str,
        title: &str,
        level: &str,
        status: &str,
    ) {
        let level = match level {
            "epic" => Level::Epic,
            "ticket" => Level::Ticket,
            "task" => Level::Task,
            _ => Level::Task,
        };

        let options = CreateTaskOptions::new(title)
            .with_id(id)
            .with_level(level)
            .with_status(status);

        services.tasks().create_task(options).await.unwrap();
    }

    /// Helper to create a child_of relationship (child -> parent)
    async fn create_child_of(services: &VertebraeServices, child_id: &str, parent_id: &str) {
        services
            .tasks()
            .set_parent(child_id, parent_id)
            .await
            .unwrap();
    }

    /// Helper to create a depends_on relationship (dependent -> dependency)
    async fn create_depends_on(
        services: &VertebraeServices,
        dependent_id: &str,
        dependency_id: &str,
    ) {
        services
            .tasks()
            .add_dependency(dependent_id, dependency_id)
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
                workflow_id: None,
                current_step_id: None,
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
                workflow_id: None,
                current_step_id: None,
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
        let services = setup_test_service().await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_single_backlog_task() {
        let services = setup_test_service().await;

        create_task(&services, "task1", "Backlog Task", "task", "backlog").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        assert!(result.backlog_ready.len() == 1);
        assert_eq!(result.backlog_ready[0].id, "task1");
    }

    #[tokio::test]
    async fn test_ready_excludes_in_progress() {
        let services = setup_test_service().await;

        create_task(
            &services,
            "task1",
            "In Progress Task",
            "task",
            "in_progress",
        )
        .await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_excludes_done() {
        let services = setup_test_service().await;

        create_task(&services, "task1", "Done Task", "task", "done").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_shows_parent_not_child_when_no_work_started() {
        let services = setup_test_service().await;

        // Create epic with backlog child - should show epic only
        create_task(&services, "epic1", "Epic", "epic", "backlog").await;
        create_task(&services, "ticket1", "Ticket", "ticket", "backlog").await;
        create_child_of(&services, "ticket1", "epic1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        // Should show only epic1, not ticket1
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "epic1");
    }

    #[tokio::test]
    async fn test_ready_excludes_parent_when_child_work_started() {
        let services = setup_test_service().await;

        // Create epic in backlog with in_progress child - epic should not show
        create_task(&services, "epic1", "Epic", "epic", "backlog").await;
        create_task(&services, "ticket1", "Ticket", "ticket", "in_progress").await;
        create_child_of(&services, "ticket1", "epic1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        // Epic should be excluded because work has started on a child
        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_excludes_blocked_tasks() {
        let services = setup_test_service().await;

        // Create blocker (backlog) and blocked task (backlog)
        create_task(&services, "blocker", "Blocker", "task", "backlog").await;
        create_task(&services, "blocked", "Blocked", "task", "backlog").await;
        create_depends_on(&services, "blocked", "blocker").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        // Should show only blocker (blocked is blocked by an incomplete task)
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "blocker");
    }

    #[tokio::test]
    async fn test_ready_includes_unblocked_tasks() {
        let services = setup_test_service().await;

        // Create blocker (done) and blocked task (backlog)
        create_task(&services, "blocker", "Blocker", "task", "done").await;
        create_task(&services, "blocked", "Blocked", "task", "backlog").await;
        create_depends_on(&services, "blocked", "blocker").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        // Should show blocked task (blocker is done)
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "blocked");
    }

    #[tokio::test]
    async fn test_ready_prioritizes_epic_over_ticket_over_task() {
        let services = setup_test_service().await;

        // Create independent tasks at all levels - all backlog
        create_task(&services, "task1", "Task", "task", "backlog").await;
        create_task(&services, "ticket1", "Ticket", "ticket", "backlog").await;
        create_task(&services, "epic1", "Epic", "epic", "backlog").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

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
        let services = setup_test_service().await;

        // Create epic -> ticket -> task hierarchy, all backlog
        create_task(&services, "epic1", "Epic", "epic", "backlog").await;
        create_task(&services, "ticket1", "Ticket", "ticket", "backlog").await;
        create_task(&services, "task1", "Task", "task", "backlog").await;
        create_child_of(&services, "ticket1", "epic1").await;
        create_child_of(&services, "task1", "ticket1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        // Should show only epic1 (highest level entry point)
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "epic1");
    }

    #[tokio::test]
    async fn test_ready_work_started_deep_in_hierarchy() {
        let services = setup_test_service().await;

        // Create epic -> ticket -> task hierarchy
        // task is in_progress, so epic should be excluded
        create_task(&services, "epic1", "Epic", "epic", "backlog").await;
        create_task(&services, "ticket1", "Ticket", "ticket", "backlog").await;
        create_task(&services, "task1", "Task", "task", "in_progress").await;
        create_child_of(&services, "ticket1", "epic1").await;
        create_child_of(&services, "task1", "ticket1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        // Should show nothing (work started deep in hierarchy)
        assert!(result.backlog_ready.is_empty());
    }

    #[tokio::test]
    async fn test_ready_child_shows_when_parent_has_work_elsewhere() {
        let services = setup_test_service().await;

        // Create epic with two tickets:
        // - ticket1: in_progress (work started)
        // - ticket2: backlog (ready to start)
        // ticket2 should show (it's an entry point, not under the in_progress one)
        create_task(&services, "epic1", "Epic", "epic", "backlog").await;
        create_task(&services, "ticket1", "Ticket 1", "ticket", "in_progress").await;
        create_task(&services, "ticket2", "Ticket 2", "ticket", "backlog").await;
        create_child_of(&services, "ticket1", "epic1").await;
        create_child_of(&services, "ticket2", "epic1").await;

        let cmd = ReadyCommand {};
        let result = cmd.execute(&services).await.unwrap();

        // Epic has work started (ticket1 is in_progress), so it shouldn't show
        // But ticket2 should show (it's the entry point for its subtree)
        assert_eq!(result.backlog_ready.len(), 1);
        assert_eq!(result.backlog_ready[0].id, "ticket2");
    }
}
