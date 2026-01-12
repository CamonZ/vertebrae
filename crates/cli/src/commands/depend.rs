//! Depend command for creating task dependencies
//!
//! Implements the `vtb depend` command to create dependency relationships between tasks
//! with cycle detection to ensure the dependency graph remains acyclic.
//!
//! Uses the TaskService layer to create dependencies, which ensures that MutationCallback
//! fires properly for GUI cache invalidation.

use clap::Args;
use vertebrae_core::TaskService;
use vertebrae_db::DbError;

/// Create a dependency relationship between tasks
#[derive(Debug, Args)]
pub struct DependCommand {
    /// Task ID that will depend on another task (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Task ID that this task depends on (the blocker)
    #[arg(long = "on", required = true)]
    pub blocker_id: String,
}

/// Result of the depend command execution
#[derive(Debug)]
pub struct DependResult {
    /// The task ID that now depends on the blocker
    pub task_id: String,
    /// The blocker task ID
    pub blocker_id: String,
    /// Whether the dependency already existed (idempotent)
    pub already_existed: bool,
}

impl std::fmt::Display for DependResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.already_existed {
            write!(
                f,
                "Dependency already exists: {} -> {}",
                self.task_id, self.blocker_id
            )
        } else {
            write!(
                f,
                "Created dependency: {} depends on {}",
                self.task_id, self.blocker_id
            )
        }
    }
}

impl DependCommand {
    /// Execute the depend command.
    ///
    /// Creates a dependency relationship where the task identified by `id`
    /// depends on (is blocked by) the task identified by `blocker_id`.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - Either task does not exist
    /// - Self-dependency is attempted (task depends on itself)
    /// - Creating the dependency would form a cycle
    /// - Service operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<DependResult, DbError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let task_id = self.id.to_lowercase();
        let blocker_id = self.blocker_id.to_lowercase();

        // Check for self-dependency
        if task_id == blocker_id {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: "Task cannot depend on itself".to_string(),
            });
        }

        // Validate both tasks exist using service layer
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

        if !service
            .task_exists(&blocker_id)
            .await
            .map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.blocker_id),
                reason: e.to_string(),
            })?
        {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.blocker_id),
                reason: format!("Task '{}' not found", self.blocker_id),
            });
        }

        // Check if dependency already exists (idempotent) using service layer
        let with_relations = service
            .get_task_with_relations(&task_id)
            .await
            .map_err(|e| DbError::InvalidPath {
                path: std::path::PathBuf::from(&self.id),
                reason: e.to_string(),
            })?;

        if with_relations.depends_on_ids.contains(&blocker_id) {
            // Dependency already exists - idempotent behavior
            return Ok(DependResult {
                task_id,
                blocker_id,
                already_existed: true,
            });
        }

        // Add the dependency using the service layer (handles cycle detection and mutation callback)
        service
            .add_dependency(&task_id, &blocker_id)
            .await
            .map_err(|e| match e {
                vertebrae_core::error::ServiceError::CyclicDependency => DbError::InvalidPath {
                    path: std::path::PathBuf::from(&self.id),
                    reason: "Cycle detected: dependency would create a cycle".to_string(),
                },
                other => DbError::InvalidPath {
                    path: std::path::PathBuf::from(&self.id),
                    reason: other.to_string(),
                },
            })?;

        Ok(DependResult {
            task_id,
            blocker_id,
            already_existed: false,
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
    async fn test_create_dependency() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
            .await
            .unwrap();

        let cmd = DependCommand {
            id: task_b.clone(),
            blocker_id: task_a.clone(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Depend failed: {:?}", result.err());

        let depend_result = result.unwrap();
        assert_eq!(depend_result.task_id, task_b);
        assert_eq!(depend_result.blocker_id, task_a);
        assert!(!depend_result.already_existed);

        // Verify the dependency was created
        let with_relations = service.get_task_with_relations(&task_b).await.unwrap();
        assert!(with_relations.depends_on_ids.contains(&task_a));
    }

    #[tokio::test]
    async fn test_dependency_idempotent() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
            .await
            .unwrap();

        let cmd = DependCommand {
            id: task_b.clone(),
            blocker_id: task_a.clone(),
        };

        // Create dependency first time
        let result1 = cmd.execute(&service).await;
        assert!(result1.is_ok());
        assert!(!result1.unwrap().already_existed);

        // Create dependency second time - should be idempotent
        let result2 = cmd.execute(&service).await;
        assert!(result2.is_ok());
        assert!(result2.unwrap().already_existed);
    }

    #[tokio::test]
    async fn test_self_dependency_fails() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();

        let cmd = DependCommand {
            id: task_a.clone(),
            blocker_id: task_a.clone(),
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("cannot depend on itself"),
                    "Expected 'cannot depend on itself' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_direct_cycle_detection() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();
        let task_b = service
            .create_task(CreateTaskOptions::new("Task B"))
            .await
            .unwrap();

        // Create A depends on B
        let cmd1 = DependCommand {
            id: task_a.clone(),
            blocker_id: task_b.clone(),
        };
        cmd1.execute(&service).await.unwrap();

        // Try to create B depends on A - should fail (cycle)
        let cmd2 = DependCommand {
            id: task_b.clone(),
            blocker_id: task_a.clone(),
        };

        let result = cmd2.execute(&service).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("Cycle detected"),
                    "Expected 'Cycle detected' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_transitive_cycle_detection() {
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

        // Create A depends on B
        let cmd1 = DependCommand {
            id: task_a.clone(),
            blocker_id: task_b.clone(),
        };
        cmd1.execute(&service).await.unwrap();

        // Create B depends on C
        let cmd2 = DependCommand {
            id: task_b.clone(),
            blocker_id: task_c.clone(),
        };
        cmd2.execute(&service).await.unwrap();

        // Try to create C depends on A - should fail (transitive cycle)
        let cmd3 = DependCommand {
            id: task_c.clone(),
            blocker_id: task_a.clone(),
        };

        let result = cmd3.execute(&service).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("Cycle detected"),
                    "Expected 'Cycle detected' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_task_not_found() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();

        let cmd = DependCommand {
            id: task_a.clone(),
            blocker_id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("not found"),
                    "Expected 'not found' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("nonexistent"),
                    "Expected task ID 'nonexistent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_dependent_task_not_found() {
        let service = setup_test_service().await;

        let task_a = service
            .create_task(CreateTaskOptions::new("Task A"))
            .await
            .unwrap();

        let cmd = DependCommand {
            id: "nonexistent".to_string(),
            blocker_id: task_a.clone(),
        };

        let result = cmd.execute(&service).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("not found"),
                    "Expected 'not found' in error, got: {}",
                    reason
                );
                assert!(
                    reason.contains("nonexistent"),
                    "Expected task ID 'nonexistent' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
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

        let cmd = DependCommand {
            id: task_b.to_uppercase(),
            blocker_id: task_a.to_uppercase(),
        };

        let result = cmd.execute(&service).await;
        assert!(result.is_ok(), "Case-insensitive lookup should work");

        // Verify the dependency was created
        let with_relations = service.get_task_with_relations(&task_b).await.unwrap();
        assert!(with_relations.depends_on_ids.contains(&task_a));
    }

    #[tokio::test]
    async fn test_multiple_dependencies_allowed() {
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

        // C depends on A
        let cmd1 = DependCommand {
            id: task_c.clone(),
            blocker_id: task_a.clone(),
        };
        cmd1.execute(&service).await.unwrap();

        // C also depends on B
        let cmd2 = DependCommand {
            id: task_c.clone(),
            blocker_id: task_b.clone(),
        };
        let result = cmd2.execute(&service).await;
        assert!(result.is_ok());

        // Verify both dependencies exist
        let with_relations = service.get_task_with_relations(&task_c).await.unwrap();
        assert!(with_relations.depends_on_ids.contains(&task_a));
        assert!(with_relations.depends_on_ids.contains(&task_b));
    }

    #[tokio::test]
    async fn test_diamond_dependency_allowed() {
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
        let task_d = service
            .create_task(CreateTaskOptions::new("Task D"))
            .await
            .unwrap();

        // B depends on A
        DependCommand {
            id: task_b.clone(),
            blocker_id: task_a.clone(),
        }
        .execute(&service)
        .await
        .unwrap();

        // C depends on A
        DependCommand {
            id: task_c.clone(),
            blocker_id: task_a.clone(),
        }
        .execute(&service)
        .await
        .unwrap();

        // D depends on B
        DependCommand {
            id: task_d.clone(),
            blocker_id: task_b.clone(),
        }
        .execute(&service)
        .await
        .unwrap();

        // D depends on C (diamond complete, no cycle)
        let result = DependCommand {
            id: task_d.clone(),
            blocker_id: task_c.clone(),
        }
        .execute(&service)
        .await;

        assert!(result.is_ok(), "Diamond dependency should be allowed");

        // Verify all 4 edges exist
        let b_relations = service.get_task_with_relations(&task_b).await.unwrap();
        assert!(
            b_relations.depends_on_ids.contains(&task_a),
            "B -> A edge should exist"
        );

        let c_relations = service.get_task_with_relations(&task_c).await.unwrap();
        assert!(
            c_relations.depends_on_ids.contains(&task_a),
            "C -> A edge should exist"
        );

        let d_relations = service.get_task_with_relations(&task_d).await.unwrap();
        assert!(
            d_relations.depends_on_ids.contains(&task_b),
            "D -> B edge should exist"
        );
        assert!(
            d_relations.depends_on_ids.contains(&task_c),
            "D -> C edge should exist"
        );
    }

    #[tokio::test]
    async fn test_long_chain_no_cycle() {
        let service = setup_test_service().await;

        // Create tasks: A, B, C, D, E
        let mut tasks = vec![];
        for name in ['A', 'B', 'C', 'D', 'E'] {
            let id = service
                .create_task(CreateTaskOptions::new(format!("Task {}", name)))
                .await
                .unwrap();
            tasks.push(id);
        }

        let (task_a, task_b, task_c, task_d, task_e) = (
            tasks[0].clone(),
            tasks[1].clone(),
            tasks[2].clone(),
            tasks[3].clone(),
            tasks[4].clone(),
        );

        // Create chain of dependencies: B -> A, C -> B, D -> C, E -> D
        let dependencies = vec![
            (task_b.clone(), task_a.clone()),
            (task_c.clone(), task_b.clone()),
            (task_d.clone(), task_c.clone()),
            (task_e.clone(), task_d.clone()),
        ];

        for (from, to) in dependencies {
            let result = DependCommand {
                id: from.clone(),
                blocker_id: to.clone(),
            }
            .execute(&service)
            .await;
            assert!(
                result.is_ok(),
                "Chain dependency {} -> {} should work",
                from,
                to
            );
        }

        // Try to create cycle at the end: A depends on E
        let result = DependCommand {
            id: task_a.clone(),
            blocker_id: task_e.clone(),
        }
        .execute(&service)
        .await;

        assert!(result.is_err(), "Should detect cycle in long chain");
        assert!(result.unwrap_err().to_string().contains("Cycle detected"));

        // Verify all chain edges exist
        let b_relations = service.get_task_with_relations(&task_b).await.unwrap();
        assert!(
            b_relations.depends_on_ids.contains(&task_a),
            "B -> A edge should exist"
        );

        let c_relations = service.get_task_with_relations(&task_c).await.unwrap();
        assert!(
            c_relations.depends_on_ids.contains(&task_b),
            "C -> B edge should exist"
        );

        let d_relations = service.get_task_with_relations(&task_d).await.unwrap();
        assert!(
            d_relations.depends_on_ids.contains(&task_c),
            "D -> C edge should exist"
        );

        let e_relations = service.get_task_with_relations(&task_e).await.unwrap();
        assert!(
            e_relations.depends_on_ids.contains(&task_d),
            "E -> D edge should exist"
        );

        // Verify the cycle edge was NOT created
        let a_relations = service.get_task_with_relations(&task_a).await.unwrap();
        assert!(
            !a_relations.depends_on_ids.contains(&task_e),
            "A -> E edge should NOT exist (would create cycle)"
        );
    }

    #[test]
    fn test_depend_result_display_new() {
        let result = DependResult {
            task_id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
            already_existed: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Created dependency"));
        assert!(output.contains("taskb"));
        assert!(output.contains("taska"));
    }

    #[test]
    fn test_depend_result_display_existing() {
        let result = DependResult {
            task_id: "taskb".to_string(),
            blocker_id: "taska".to_string(),
            already_existed: true,
        };

        let output = format!("{}", result);
        assert!(output.contains("already exists"));
    }

    #[test]
    fn test_depend_command_debug() {
        let cmd = DependCommand {
            id: "test123".to_string(),
            blocker_id: "blocker456".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("DependCommand")
                && debug_str.contains("id: \"test123\"")
                && debug_str.contains("blocker_id: \"blocker456\""),
            "Debug output should contain DependCommand and both id field values"
        );
    }
}
