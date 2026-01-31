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

use crate::execution_service::ExecutionService;
use crate::service::TaskService;
use crate::step_service::StepService;
use crate::workflow_service::WorkflowService;

/// Unified services container bundling all service layer components
///
/// This struct provides a single entry point for CLI and GUI to access all services
/// without needing to create and manage individual service instances separately.
///
/// # Example
///
/// ```rust,ignore
/// use vertebrae_core::VertebraeServices;
///
/// // Create from individual service implementations
/// let services = VertebraeServices::from_services(
///     task_service,
///     workflow_service,
///     execution_service,
///     step_service,
/// );
///
/// // Access individual services
/// let tasks = services.tasks();
/// let workflows = services.workflows();
/// let executions = services.executions();
/// let steps = services.steps();
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
    /// Create a VertebraeServices from individual service trait objects.
    ///
    /// This is the primary constructor for creating VertebraeServices
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
}
