//! Step service for managing first-class workflow steps
//!
//! Provides high-level operations for step management, abstracting the
//! repository layer for use by CLI and GUI.

use crate::error::{ServiceError, ServiceResult};
use crate::models::{Step, StepUpdate};
use async_trait::async_trait;
use vertebrae_db::{Database, StepRepository, Thing};

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

/// Default implementation of StepService backed by Database
pub struct DefaultStepService {
    database: Database,
}

impl DefaultStepService {
    /// Create a new DefaultStepService with the given database
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    /// Get a reference to the underlying database
    pub fn database(&self) -> &Database {
        &self.database
    }

    /// Get the step repository
    fn steps(&self) -> StepRepository<'_> {
        self.database.steps()
    }
}

#[async_trait]
impl StepService for DefaultStepService {
    async fn create_step(&self, step: &Step) -> ServiceResult<Step> {
        let db_step = step.to_db();
        let created = self.steps().create(&db_step).await?;
        Ok(created.into())
    }

    async fn create_step_with_id(&self, id: &str, step: &Step) -> ServiceResult<Step> {
        let db_step = step.to_db();
        let created = self.steps().create_with_id(id, &db_step).await?;
        Ok(created.into())
    }

    async fn get_step(&self, id: &str) -> ServiceResult<Option<Step>> {
        let result = self.steps().get(id).await?;
        Ok(result.map(|db_step| db_step.into()))
    }

    async fn step_exists(&self, id: &str) -> ServiceResult<bool> {
        self.steps().exists(id).await.map_err(ServiceError::from)
    }

    async fn get_step_by_id(&self, id: &str) -> ServiceResult<Option<Step>> {
        let result = self.steps().get(id).await?;
        Ok(result.map(|db_step| db_step.into()))
    }

    async fn list_steps_for_workflow(&self, workflow_id: &str) -> ServiceResult<Vec<Step>> {
        let thing = Thing::from(("workflow", workflow_id));
        let results = self.steps().list_by_workflow(&thing).await?;
        Ok(results.into_iter().map(|db_step| db_step.into()).collect())
    }

    async fn update_step(&self, id: &str, updates: &StepUpdate) -> ServiceResult<()> {
        let db_update = updates.to_db();
        self.steps()
            .update(id, &db_update)
            .await
            .map_err(ServiceError::from)
    }

    async fn delete_step(&self, id: &str) -> ServiceResult<()> {
        self.steps().delete(id).await.map_err(ServiceError::from)
    }

    async fn get_initial_step(&self, workflow_id: &str) -> ServiceResult<Option<Step>> {
        let thing = Thing::from(("workflow", workflow_id));
        let result = self.steps().get_initial_step(&thing).await?;
        Ok(result.map(|db_step| db_step.into()))
    }

    async fn get_transitions(&self, step_id: &str) -> ServiceResult<Vec<Step>> {
        let thing = Thing::from(("step", step_id));
        let results = self.steps().get_transitions(&thing).await?;
        Ok(results.into_iter().map(|db_step| db_step.into()).collect())
    }

    async fn get_final_steps(&self, workflow_id: &str) -> ServiceResult<Vec<Step>> {
        let thing = Thing::from(("workflow", workflow_id));
        let results = self.steps().get_final_steps(&thing).await?;
        Ok(results.into_iter().map(|db_step| db_step.into()).collect())
    }

    async fn list_all_steps(&self) -> ServiceResult<Vec<Step>> {
        let results = self.steps().list().await?;
        Ok(results.into_iter().map(|db_step| db_step.into()).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_test_service() -> DefaultStepService {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        DefaultStepService::new(db)
    }

    /// Create a workflow (without embedded steps - using first-class Step entities)
    fn test_workflow(name: &str) -> vertebrae_db::Workflow {
        vertebrae_db::Workflow::new(name)
    }

    #[tokio::test]
    async fn test_create_and_get_step() {
        let service = setup_test_service().await;

        // Create a workflow first
        service
            .database()
            .workflows()
            .create("test_wf", &test_workflow("Test Workflow"))
            .await
            .unwrap();

        let step = Step::new("Review", "test_wf").with_order(0);

        let created = service.create_step_with_id("review", &step).await.unwrap();
        assert_eq!(created.name, "Review");

        let fetched = service.get_step("review").await.unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().name, "Review");
    }

    #[tokio::test]
    async fn test_list_steps_for_workflow() {
        let service = setup_test_service().await;

        // Create workflow
        service
            .database()
            .workflows()
            .create("list_wf", &test_workflow("List Workflow"))
            .await
            .unwrap();

        // Create multiple steps
        let step1 = Step::new("Step 1", "list_wf").with_order(0);
        let step2 = Step::new("Step 2", "list_wf").with_order(1);
        let step3 = Step::new("Step 3", "list_wf").with_order(2);

        service.create_step(&step1).await.unwrap();
        service.create_step(&step2).await.unwrap();
        service.create_step(&step3).await.unwrap();

        let steps = service.list_steps_for_workflow("list_wf").await.unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].name, "Step 1");
        assert_eq!(steps[1].name, "Step 2");
        assert_eq!(steps[2].name, "Step 3");
    }

    #[tokio::test]
    async fn test_update_step() {
        let service = setup_test_service().await;

        // Create workflow and step
        service
            .database()
            .workflows()
            .create("update_wf", &test_workflow("Update Workflow"))
            .await
            .unwrap();

        let step = Step::new("Original", "update_wf").with_order(0);
        service
            .create_step_with_id("update_step", &step)
            .await
            .unwrap();

        // Update step
        let updates = StepUpdate::new().with_name("Updated").with_is_final(true);
        service.update_step("update_step", &updates).await.unwrap();

        let updated = service.get_step("update_step").await.unwrap().unwrap();
        assert_eq!(updated.name, "Updated");
        assert!(updated.is_final);
    }

    #[tokio::test]
    async fn test_delete_step() {
        let service = setup_test_service().await;

        // Create workflow and step
        service
            .database()
            .workflows()
            .create("delete_wf", &test_workflow("Delete Workflow"))
            .await
            .unwrap();

        let step = Step::new("To Delete", "delete_wf").with_order(0);
        service
            .create_step_with_id("delete_me", &step)
            .await
            .unwrap();

        assert!(service.get_step("delete_me").await.unwrap().is_some());
        service.delete_step("delete_me").await.unwrap();
        assert!(service.get_step("delete_me").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_get_initial_step() {
        let service = setup_test_service().await;

        // Create workflow
        service
            .database()
            .workflows()
            .create("initial_wf", &test_workflow("Initial Workflow"))
            .await
            .unwrap();

        // Create steps with different orders
        let step0 = Step::new("Initial", "initial_wf").with_order(0);
        let step1 = Step::new("Second", "initial_wf").with_order(1);

        service.create_step(&step0).await.unwrap();
        service.create_step(&step1).await.unwrap();

        let initial = service.get_initial_step("initial_wf").await.unwrap();
        assert!(initial.is_some());
        assert_eq!(initial.unwrap().name, "Initial");
    }

    #[tokio::test]
    async fn test_get_final_steps() {
        let service = setup_test_service().await;

        // Create workflow
        service
            .database()
            .workflows()
            .create("final_wf", &test_workflow("Final Workflow"))
            .await
            .unwrap();

        // Create steps with different is_final values
        let step1 = Step::new("Not Final", "final_wf").with_order(0);
        let step2 = Step::new("Final 1", "final_wf")
            .with_order(1)
            .with_is_final(true);
        let step3 = Step::new("Final 2", "final_wf")
            .with_order(2)
            .with_is_final(true);

        service.create_step(&step1).await.unwrap();
        service.create_step(&step2).await.unwrap();
        service.create_step(&step3).await.unwrap();

        let final_steps = service.get_final_steps("final_wf").await.unwrap();
        assert_eq!(final_steps.len(), 2);
        assert!(final_steps.iter().all(|s| s.is_final));
    }
}
