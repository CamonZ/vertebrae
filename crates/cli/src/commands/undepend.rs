//! Undepend command for removing task dependencies
//!
//! Implements the `vtb undepend` command to remove dependency relationships between tasks.
//! Uses the TaskService layer to ensure MutationCallback fires properly for GUI cache invalidation.

use clap::Args;
use vertebrae_core::TaskService;
use vertebrae_db::DbError;

/// Remove a dependency relationship between tasks
#[derive(Debug, Args)]
pub struct UndependCommand {
    /// Task ID that depends on another task (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Task ID of the blocker to remove (case-insensitive)
    #[arg(long = "on", required = true)]
    pub blocker_id: String,
}

/// Result of the undepend command execution
#[derive(Debug)]
pub struct UndependResult {
    /// The task ID that no longer depends on the blocker
    pub task_id: String,
    /// The blocker task ID that was removed
    pub blocker_id: String,
    /// Whether the dependency existed before removal
    pub existed: bool,
}

impl std::fmt::Display for UndependResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.existed {
            write!(
                f,
                "Removed dependency: {} no longer depends on {}",
                self.task_id, self.blocker_id
            )
        } else {
            write!(
                f,
                "Warning: No dependency from {} to {} exists",
                self.task_id, self.blocker_id
            )
        }
    }
}

impl UndependCommand {
    /// Execute the undepend command.
    ///
    /// Removes a dependency relationship where the task identified by `id`
    /// depends on (is blocked by) the task identified by `blocker_id`.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The source task does not exist
    /// - Service operations fail
    ///
    /// Note: Non-existent dependency is handled gracefully with a warning.
    pub async fn execute(&self, service: &dyn TaskService) -> Result<UndependResult, DbError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let task_id = self.id.to_lowercase();
        let blocker_id = self.blocker_id.to_lowercase();

        // Validate source task exists using service layer
        if !service
            .task_exists(&task_id)
            .await
            .map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: e.to_string(),
            })?
        {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: format!("Task '{}' not found", self.id),
            });
        }

        // Check if dependency exists using service layer
        let with_relations = service
            .get_task_with_relations(&task_id)
            .await
            .map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: e.to_string(),
            })?;

        let existed = with_relations.depends_on_ids.contains(&blocker_id);

        if existed {
            // Remove the dependency using the service layer (fires mutation callback)
            service
                .remove_dependency(&task_id, &blocker_id)
                .await
                .map_err(|e| DbError::InvalidPath {
                    path: std::path::PathBuf::from(&self.id),
                    reason: e.to_string(),
                })?;
        }

        Ok(UndependResult {
            task_id,
            blocker_id,
            existed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::{CreateTaskOptions, DefaultTaskService};
    use vertebrae_db::Database;

    /// Helper to create an in-memory test service
    async fn setup_test_service() -> DefaultTaskService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultTaskService::new(db)
    }

    #[tokio::test]
    async fn test_remove_dependency() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
            .await
            .unwrap();

        // Create dependency first
        service.add_dependency(&task_b, &task_a).await.unwrap();

        // Verify dependency exists
        let with_relations = service.get_task_with_relations(&task_b).await.unwrap();
        assert!(with_relations.depends_on_ids.contains(&task_a));

        // Remove dependency
        let undepend_cmd = UndependCommand {
            id: task_b.clone(),
            blocker_id: task_a.clone(),
        };

        let result = undepend_cmd.execute(&service).await;
        assert!(result.is_ok(), "Undepend failed: {:?}", result.err());

        let undepend_result = result.unwrap();
        assert_eq!(undepend_result.task_id, task_b);
        assert_eq!(undepend_result.blocker_id, task_a);
        assert!(undepend_result.existed);

        // Verify dependency was removed
        let with_relations = service.get_task_with_relations(&task_b).await.unwrap();
        assert!(!with_relations.depends_on_ids.contains(&task_a));
    }

    #[tokio::test]
    async fn test_remove_nonexistent_dependency_warns() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
            .await
            .unwrap();

        // Try to remove non-existent dependency
        let undepend_cmd = UndependCommand {
            id: task_b.clone(),
            blocker_id: task_a.clone(),
        };

        let result = undepend_cmd.execute(&service).await;
        assert!(
            result.is_ok(),
            "Should not fail for non-existent dependency"
        );

        let undepend_result = result.unwrap();
        assert_eq!(undepend_result.task_id, task_b);
        assert_eq!(undepend_result.blocker_id, task_a);
        assert!(!undepend_result.existed);

        // Verify display message shows warning
        let display = format!("{}", undepend_result);
        assert!(display.contains("Warning: No dependency"));
    }

    #[tokio::test]
    async fn test_remove_dependency_idempotent() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
            .await
            .unwrap();

        // Create dependency
        service.add_dependency(&task_b, &task_a).await.unwrap();

        let undepend_cmd = UndependCommand {
            id: task_b.clone(),
            blocker_id: task_a.clone(),
        };

        // Remove dependency first time
        let result1 = undepend_cmd.execute(&service).await;
        assert!(result1.is_ok());
        let undepend_result1 = result1.unwrap();
        assert_eq!(undepend_result1.task_id, task_b);
        assert_eq!(undepend_result1.blocker_id, task_a);
        assert!(undepend_result1.existed);

        // Remove dependency second time - should be idempotent (warn but not fail)
        let result2 = undepend_cmd.execute(&service).await;
        assert!(result2.is_ok());
        let undepend_result2 = result2.unwrap();
        assert_eq!(undepend_result2.task_id, task_b);
        assert_eq!(undepend_result2.blocker_id, task_a);
        assert!(!undepend_result2.existed);
    }

    #[tokio::test]
    async fn test_source_task_must_exist() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();

        let undepend_cmd = UndependCommand {
            id: "nonexistent".to_string(),
            blocker_id: task_a.clone(),
        };

        let result = undepend_cmd.execute(&service).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("not found"),
                    "Expected 'not found' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_target_task_nonexistence_ok() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();

        // Target task doesn't exist - this is OK for edge cleanup
        let undepend_cmd = UndependCommand {
            id: task_a.clone(),
            blocker_id: "nonexistent".to_string(),
        };

        let result = undepend_cmd.execute(&service).await;
        assert!(result.is_ok(), "Should not fail when target doesn't exist");
        let undepend_result = result.unwrap();
        assert_eq!(undepend_result.task_id, task_a);
        assert_eq!(undepend_result.blocker_id, "nonexistent");
        assert!(!undepend_result.existed);
    }

    #[tokio::test]
    async fn test_case_insensitive_ids() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
            .await
            .unwrap();

        // Create dependency with lowercase
        service.add_dependency(&task_b, &task_a).await.unwrap();

        // Remove with uppercase
        let undepend_cmd = UndependCommand {
            id: task_b.to_uppercase(),
            blocker_id: task_a.to_uppercase(),
        };

        let result = undepend_cmd.execute(&service).await;
        assert!(result.is_ok(), "Case-insensitive removal should work");
        assert!(result.unwrap().existed);

        // Verify dependency was removed
        let with_relations = service.get_task_with_relations(&task_b).await.unwrap();
        assert!(!with_relations.depends_on_ids.contains(&task_a));
    }

    #[tokio::test]
    async fn test_remove_only_specified_dependency() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
            .await
            .unwrap();
        let task_c = service
            .create_task(CreateTaskOptions::new("Task C"))
            .await
            .unwrap();

        // C depends on both A and B
        service.add_dependency(&task_c, &task_a).await.unwrap();
        service.add_dependency(&task_c, &task_b).await.unwrap();

        // Remove only C -> A dependency
        let undepend_cmd = UndependCommand {
            id: task_c.clone(),
            blocker_id: task_a.clone(),
        };
        undepend_cmd.execute(&service).await.unwrap();

        // Verify only C -> A was removed, C -> B still exists
        let with_relations = service.get_task_with_relations(&task_c).await.unwrap();
        assert!(!with_relations.depends_on_ids.contains(&task_a));
        assert!(with_relations.depends_on_ids.contains(&task_b));
    }

    #[test]
    fn test_undepend_result_display_removed() {
        let result = UndependResult {
            task_id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
            existed: true,
        };

        let output = format!("{}", result);
        assert_eq!(
            output,
            "Removed dependency: taskb no longer depends on taska"
        );
    }

    #[test]
    fn test_undepend_result_display_warning() {
        let result = UndependResult {
            task_id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
            existed: false,
        };

        let output = format!("{}", result);
        assert_eq!(output, "Warning: No dependency from taskb to taska exists");
    }

    #[test]
    fn test_undepend_command_debug() {
        let cmd = UndependCommand {
            id: "test123".to_string(),
            blocker_id: "blocker456".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("UndependCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("blocker_id: \"blocker456\""),
            "Debug output should contain UndependCommand and both id field values"
        );
    }
}
