//! Unified services container for Vertebrae
//!
//! This module provides a single entry point for accessing all service layer components.
//! The `VertebraeServices` struct bundles all service traits (TaskService, WorkflowService,
//! ExecutionService, StepService) into a unified container for convenient access in both CLI and GUI.
//!
//! # Sacrum Backend Support
//!
//! When the `sacrum` feature is enabled, additional factory methods are available to create
//! VertebraeServices from a Sacrum HTTP client. Note that these methods require importing
//! from `vertebrae_sacrum_client` and should be used in contexts where both dependencies
//! are available (such as CLI and GUI binaries).

use std::sync::Arc;
use vertebrae_db::Database;

use crate::execution_service::{DefaultExecutionService, ExecutionService};
use crate::service::{DefaultTaskService, MutationCallback, TaskService};
use crate::step_service::{DefaultStepService, StepService};
use crate::workflow_service::{DefaultWorkflowService, WorkflowMutationCallback, WorkflowService};

/// Unified services container bundling all service layer components
///
/// This struct provides a single entry point for CLI and GUI to access all services
/// without needing to create and manage individual service instances separately.
///
/// # Example
///
/// ```rust,ignore
/// use vertebrae_core::VertebraeServices;
/// use vertebrae_db::Database;
///
/// async fn example() -> Result<(), Box<dyn std::error::Error>> {
///     let db = Database::connect(&std::path::PathBuf::from(".vtb/data")).await?;
///     db.init().await?;
///
///     let services = VertebraeServices::new(db);
///
///     // Access individual services
///     let tasks = services.tasks();
///     let workflows = services.workflows();
///     let executions = services.executions();
///     let steps = services.steps();
///
///     Ok(())
/// }
/// ```
pub struct VertebraeServices {
    /// Task service implementation
    tasks: Arc<dyn TaskService>,
    /// Workflow service implementation
    workflows: Arc<dyn WorkflowService>,
    /// Execution service implementation
    executions: Arc<dyn ExecutionService>,
    /// Step service implementation
    steps: Arc<dyn StepService>,
}

impl VertebraeServices {
    /// Create a new VertebraeServices container with all service implementations
    ///
    /// Instantiates DefaultTaskService, DefaultWorkflowService, DefaultExecutionService,
    /// and DefaultStepService using the provided database. No mutation callbacks are installed.
    ///
    /// # Arguments
    ///
    /// * `db` - The database connection to use for all services
    ///
    /// # Returns
    ///
    /// A new VertebraeServices container with all services initialized
    pub fn new(db: Database) -> Self {
        Self {
            tasks: Arc::new(DefaultTaskService::new(db.clone())),
            workflows: Arc::new(DefaultWorkflowService::new(db.clone())),
            executions: Arc::new(DefaultExecutionService::new(db.clone())),
            steps: Arc::new(DefaultStepService::new(db)),
        }
    }

    /// Create a new VertebraeServices container with task service callback
    ///
    /// Instantiates services with an optional callback for task mutations.
    /// This is useful for cache invalidation and notifications when tasks are modified.
    ///
    /// # Arguments
    ///
    /// * `db` - The database connection to use for all services
    /// * `task_callback` - Optional callback for task mutations (cache invalidation, notifications, etc.)
    ///
    /// # Returns
    ///
    /// A new VertebraeServices container with services initialized
    pub fn with_task_callback(db: Database, task_callback: MutationCallback) -> Self {
        Self {
            tasks: Arc::new(DefaultTaskService::with_callback(db.clone(), task_callback)),
            workflows: Arc::new(DefaultWorkflowService::new(db.clone())),
            executions: Arc::new(DefaultExecutionService::new(db.clone())),
            steps: Arc::new(DefaultStepService::new(db)),
        }
    }

    /// Create a new VertebraeServices container with workflow service callback
    ///
    /// Instantiates services with an optional callback for workflow mutations.
    /// This is useful for cache invalidation and notifications when workflows are modified.
    ///
    /// # Arguments
    ///
    /// * `db` - The database connection to use for all services
    /// * `workflow_callback` - Optional callback for workflow mutations
    ///
    /// # Returns
    ///
    /// A new VertebraeServices container with services initialized
    pub fn with_workflow_callback(
        db: Database,
        workflow_callback: WorkflowMutationCallback,
    ) -> Self {
        Self {
            tasks: Arc::new(DefaultTaskService::new(db.clone())),
            workflows: Arc::new(DefaultWorkflowService::with_callback(
                db.clone(),
                workflow_callback,
            )),
            executions: Arc::new(DefaultExecutionService::new(db.clone())),
            steps: Arc::new(DefaultStepService::new(db)),
        }
    }

    /// Create a new VertebraeServices container with both task and workflow callbacks
    ///
    /// Instantiates services with optional callbacks for both task and workflow mutations.
    ///
    /// # Arguments
    ///
    /// * `db` - The database connection to use for all services
    /// * `task_callback` - Optional callback for task mutations
    /// * `workflow_callback` - Optional callback for workflow mutations
    ///
    /// # Returns
    ///
    /// A new VertebraeServices container with services initialized
    pub fn with_callbacks(
        db: Database,
        task_callback: MutationCallback,
        workflow_callback: WorkflowMutationCallback,
    ) -> Self {
        Self {
            tasks: Arc::new(DefaultTaskService::with_callback(db.clone(), task_callback)),
            workflows: Arc::new(DefaultWorkflowService::with_callback(
                db.clone(),
                workflow_callback,
            )),
            executions: Arc::new(DefaultExecutionService::new(db.clone())),
            steps: Arc::new(DefaultStepService::new(db)),
        }
    }

    /// Get a reference to the task service
    pub fn tasks(&self) -> &dyn TaskService {
        self.tasks.as_ref()
    }

    /// Get a reference to the workflow service
    pub fn workflows(&self) -> &dyn WorkflowService {
        self.workflows.as_ref()
    }

    /// Get a reference to the execution service
    pub fn executions(&self) -> &dyn ExecutionService {
        self.executions.as_ref()
    }

    /// Get a reference to the step service
    pub fn steps(&self) -> &dyn StepService {
        self.steps.as_ref()
    }

    /// Get an Arc clone to the task service
    pub fn tasks_arc(&self) -> Arc<dyn TaskService> {
        Arc::clone(&self.tasks)
    }

    /// Get an Arc clone to the workflow service
    pub fn workflows_arc(&self) -> Arc<dyn WorkflowService> {
        Arc::clone(&self.workflows)
    }

    /// Get an Arc clone to the execution service
    pub fn executions_arc(&self) -> Arc<dyn ExecutionService> {
        Arc::clone(&self.executions)
    }

    /// Get an Arc clone to the step service
    pub fn steps_arc(&self) -> Arc<dyn StepService> {
        Arc::clone(&self.steps)
    }

    /// Create a VertebraeServices from individual service trait objects.
    ///
    /// This is a low-level constructor useful for creating VertebraeServices
    /// from custom service implementations, such as those from Sacrum or other backends.
    ///
    /// # Arguments
    ///
    /// * `tasks` - Arc-wrapped task service implementation
    /// * `workflows` - Arc-wrapped workflow service implementation
    /// * `executions` - Arc-wrapped execution service implementation
    /// * `steps` - Arc-wrapped step service implementation
    ///
    /// # Returns
    ///
    /// A new VertebraeServices container with the provided services
    pub fn from_services(
        tasks: Arc<dyn TaskService>,
        workflows: Arc<dyn WorkflowService>,
        executions: Arc<dyn ExecutionService>,
        steps: Arc<dyn StepService>,
    ) -> Self {
        Self {
            tasks,
            workflows,
            executions,
            steps,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_db::Database;

    #[tokio::test]
    async fn test_vertebrae_services_new() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let services = VertebraeServices::new(db);

        // Verify services are accessible
        let _ = services.tasks();
        let _ = services.workflows();
        let _ = services.executions();
        let _ = services.steps();
    }

    #[tokio::test]
    async fn test_vertebrae_services_arc_accessors() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let services = VertebraeServices::new(db);

        // Verify Arc accessors return valid trait objects
        let tasks_arc = services.tasks_arc();
        let workflows_arc = services.workflows_arc();
        let executions_arc = services.executions_arc();
        let steps_arc = services.steps_arc();

        // Verify they're the same instances
        assert!(Arc::ptr_eq(&services.tasks_arc(), &tasks_arc));
        assert!(Arc::ptr_eq(&services.workflows_arc(), &workflows_arc));
        assert!(Arc::ptr_eq(&services.executions_arc(), &executions_arc));
        assert!(Arc::ptr_eq(&services.steps_arc(), &steps_arc));
    }

    #[tokio::test]
    async fn test_vertebrae_services_with_task_callback() {
        use crate::MutationCallback;

        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let callback: MutationCallback = Arc::new(|_event| {
            // No-op callback for testing
        });

        let services = VertebraeServices::with_task_callback(db, callback);

        // Verify services are accessible
        let _ = services.tasks();
        let _ = services.workflows();
        let _ = services.executions();
    }

    #[tokio::test]
    async fn test_vertebrae_services_arc_cloning() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let services = VertebraeServices::new(db);

        // Get Arc clones
        let tasks1 = services.tasks_arc();
        let tasks2 = services.tasks_arc();

        // Verify they point to the same instance
        assert!(Arc::ptr_eq(&tasks1, &tasks2));
    }

    #[tokio::test]
    async fn test_vertebrae_services_from_services() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        // Create services the traditional way
        let task_service = Arc::new(DefaultTaskService::new(db.clone()));
        let workflow_service = Arc::new(DefaultWorkflowService::new(db.clone()));
        let execution_service = Arc::new(DefaultExecutionService::new(db.clone()));
        let step_service = Arc::new(DefaultStepService::new(db));

        // Create VertebraeServices from components
        let services = VertebraeServices::from_services(
            task_service.clone(),
            workflow_service.clone(),
            execution_service.clone(),
            step_service.clone(),
        );

        // Verify services are accessible and correct
        assert!(Arc::ptr_eq(
            &services.tasks_arc(),
            &(task_service as Arc<dyn TaskService>)
        ));
        assert!(Arc::ptr_eq(
            &services.workflows_arc(),
            &(workflow_service as Arc<dyn WorkflowService>)
        ));
        assert!(Arc::ptr_eq(
            &services.executions_arc(),
            &(execution_service as Arc<dyn ExecutionService>)
        ));
        assert!(Arc::ptr_eq(
            &services.steps_arc(),
            &(step_service as Arc<dyn StepService>)
        ));
    }
}
