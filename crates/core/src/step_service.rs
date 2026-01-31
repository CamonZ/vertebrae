//! Step service for managing first-class workflow steps
//!
//! Provides high-level operations for step management, abstracting the
//! repository layer for use by CLI and GUI.

use crate::error::ServiceResult;
use crate::models::{Step, StepUpdate};
use async_trait::async_trait;

/// Trait defining step management operations
#[async_trait]
pub trait StepService: Send + Sync {
    /// Create a new step for a workflow
    async fn create_step(&self, step: &Step) -> ServiceResult<Step>;

    /// Create a step with a specific ID
    async fn create_step_with_id(&self, id: &str, step: &Step) -> ServiceResult<Step>;

    /// Get a step by ID
    async fn get_step(&self, id: &str) -> ServiceResult<Option<Step>>;

    /// Check if a step exists by ID
    async fn step_exists(&self, id: &str) -> ServiceResult<bool>;

    /// Get a step by ID
    async fn get_step_by_id(&self, id: &str) -> ServiceResult<Option<Step>>;

    /// List all steps for a workflow
    async fn list_steps_for_workflow(&self, workflow_id: &str) -> ServiceResult<Vec<Step>>;

    /// Update a step
    async fn update_step(&self, id: &str, updates: &StepUpdate) -> ServiceResult<()>;

    /// Delete a step
    async fn delete_step(&self, id: &str) -> ServiceResult<()>;

    /// Get the initial step for a workflow
    async fn get_initial_step(&self, workflow_id: &str) -> ServiceResult<Option<Step>>;

    /// Get possible transitions from a step
    async fn get_transitions(&self, step_id: &str) -> ServiceResult<Vec<Step>>;

    /// Get the final (terminal) steps for a workflow
    ///
    /// Final steps are those with is_final = true.
    async fn get_final_steps(&self, workflow_id: &str) -> ServiceResult<Vec<Step>>;

    /// List all steps across all workflows
    ///
    /// # Returns
    ///
    /// A vector of all steps.
    async fn list_all_steps(&self) -> ServiceResult<Vec<Step>>;
}
