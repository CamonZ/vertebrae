//! Workflow commands for managing workflow definitions
//!
//! Implements the `vtb workflow` subcommand group for creating and managing workflows.

use crate::notification::create_workflow_http_notification_callback;
use clap::{Args, Subcommand};
use vertebrae_core::{
    CreateWorkflowOptions, DefaultWorkflowService, ServiceError, TaskService,
    UpdateWorkflowOptions, WorkflowService, WorkflowStepInput,
};
use vertebrae_db::{AgentConfig, WorkflowStep};

/// Workflow management commands
#[derive(Debug, Subcommand)]
pub enum WorkflowCommand {
    /// Create a new workflow
    Add(WorkflowAddCommand),
    /// List all workflows
    List(WorkflowListCommand),
    /// Show details of a specific workflow
    Show(WorkflowShowCommand),
    /// Update a workflow's properties
    Update(WorkflowUpdateCommand),
    /// Delete a workflow
    Delete(WorkflowDeleteCommand),
    /// Assign a task to a workflow
    Assign(WorkflowAssignCommand),
    /// Remove workflow assignment from a task
    Unassign(WorkflowUnassignCommand),
    /// Advance a task to the next workflow step
    Advance(WorkflowAdvanceCommand),
    /// Retreat a task to the previous workflow step
    Retreat(WorkflowRetreatCommand),
    /// Reject a task in its workflow (triggers on_reject_workflow if configured)
    Reject(WorkflowRejectCommand),
}

impl WorkflowCommand {
    /// Execute the workflow subcommand.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        #[allow(deprecated)]
        let db = service.database().clone();
        // Create the workflow service with HTTP notification callback for GUI sync
        let callback = create_workflow_http_notification_callback();
        let workflow_service = DefaultWorkflowService::with_callback(db, callback);
        match self {
            WorkflowCommand::Add(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::List(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::Show(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::Update(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::Delete(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::Assign(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::Unassign(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::Advance(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::Retreat(cmd) => cmd.execute(&workflow_service).await,
            WorkflowCommand::Reject(cmd) => cmd.execute(&workflow_service).await,
        }
    }
}

/// Create a new workflow
#[derive(Debug, Args)]
pub struct WorkflowAddCommand {
    /// Name of the workflow
    #[arg(required = true)]
    pub name: String,

    /// Optional description of the workflow
    #[arg(short, long)]
    pub description: Option<String>,

    /// Workflow steps in 'name:model' format (can be specified multiple times)
    #[arg(short, long = "step", value_parser = parse_step)]
    pub steps: Vec<ParsedStep>,

    /// Workflow ID to chain to when the last step completes
    #[arg(long)]
    pub on_done: Option<String>,

    /// Workflow ID to chain to when the task is rejected
    #[arg(long)]
    pub on_reject: Option<String>,
}

/// A parsed workflow step from the command line
#[derive(Debug, Clone)]
pub struct ParsedStep {
    /// Name of the step
    pub name: String,
    /// Agent configuration for the step
    pub agent_config: AgentConfig,
}

/// Parse a step string in 'name:model' format
fn parse_step(s: &str) -> Result<ParsedStep, String> {
    let parts: Vec<&str> = s.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!(
            "invalid step format '{}'. Expected 'name:model' format (e.g., 'review:sonnet')",
            s
        ));
    }

    let name = parts[0].trim();
    let model = parts[1].trim();

    if name.is_empty() {
        return Err("step name cannot be empty".to_string());
    }

    if model.is_empty() {
        return Err("model cannot be empty".to_string());
    }

    Ok(ParsedStep {
        name: name.to_string(),
        agent_config: AgentConfig::new().with_model(model),
    })
}

impl WorkflowAddCommand {
    /// Execute the add workflow command.
    ///
    /// Creates a new workflow with the specified options and stores it in the database.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The name is empty
    /// - No steps are provided
    /// - Service operations fail
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Build the workflow steps
        let steps: Vec<WorkflowStepInput> = self
            .steps
            .iter()
            .map(|s| {
                WorkflowStepInput::new(
                    &s.name,
                    s.agent_config
                        .model
                        .clone()
                        .unwrap_or_else(|| "default".to_string()),
                )
            })
            .collect();

        // Build the create options
        let mut options = CreateWorkflowOptions::new(&self.name, steps);

        if let Some(description) = &self.description {
            options = options.with_description(description);
        }

        if let Some(on_done) = &self.on_done {
            options = options.with_on_done_workflow(on_done);
        }

        if let Some(on_reject) = &self.on_reject {
            options = options.with_on_reject_workflow(on_reject);
        }

        // Create the workflow
        let id = service.create_workflow(options).await?;

        Ok(format!("Created workflow: {}", id))
    }
}

/// A summary of a workflow for display in the list
#[derive(Debug, Clone)]
pub struct WorkflowSummary {
    /// The workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Number of steps in the workflow
    pub step_count: usize,
}

impl std::fmt::Display for WorkflowSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let desc = self
            .description
            .as_ref()
            .map(|d| format!(" - {}", d))
            .unwrap_or_default();
        write!(
            f,
            "{} - {} ({} steps){}",
            self.id, self.name, self.step_count, desc
        )
    }
}

/// List all workflows
#[derive(Debug, Args)]
pub struct WorkflowListCommand {}

impl WorkflowListCommand {
    /// Execute the list workflows command.
    ///
    /// Fetches all workflows from the database and returns a formatted list.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        let summaries = service.list_workflows().await?;

        if summaries.is_empty() {
            return Ok("No workflows found".to_string());
        }

        let output = summaries
            .iter()
            .map(|s| {
                format!(
                    "{} - {} ({} steps){}",
                    s.id,
                    s.name,
                    s.step_count,
                    s.description
                        .as_ref()
                        .map(|d| format!(" - {}", d))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        Ok(output)
    }
}

/// Detailed view of a workflow with all steps
#[derive(Debug)]
pub struct WorkflowDetail {
    /// The workflow ID
    pub id: String,
    /// Workflow name
    pub name: String,
    /// Optional description
    pub description: Option<String>,
    /// Ordered list of workflow steps
    pub steps: Vec<WorkflowStep>,
    /// Additional metadata as key-value pairs
    pub metadata: std::collections::HashMap<String, String>,
    /// Workflow to chain to when done
    pub on_done_workflow: Option<String>,
    /// Workflow to chain to when rejected
    pub on_reject_workflow: Option<String>,
    /// Creation timestamp
    pub created_at: Option<String>,
    /// Last update timestamp
    pub updated_at: Option<String>,
}

impl std::fmt::Display for WorkflowDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Header with workflow ID and name
        writeln!(f, "Workflow: {} - {}", self.id, self.name)?;
        writeln!(f, "{}", "=".repeat(60))?;
        writeln!(f)?;

        // Description (if present)
        if let Some(ref description) = self.description {
            writeln!(f, "Description")?;
            writeln!(f, "{}", "-".repeat(40))?;
            writeln!(f, "{}", description)?;
            writeln!(f)?;
        }

        // Steps section
        writeln!(f, "Steps ({} total)", self.steps.len())?;
        writeln!(f, "{}", "-".repeat(40))?;

        if self.steps.is_empty() {
            writeln!(f, "(no steps defined)")?;
        } else {
            // Sort steps by order
            let mut sorted_steps = self.steps.clone();
            sorted_steps.sort_by_key(|s| s.order);

            for step in &sorted_steps {
                let model_display = step.agent_config.model.as_deref().unwrap_or("default");
                writeln!(
                    f,
                    "{}. {} (model: {})",
                    step.order + 1,
                    step.name,
                    model_display
                )?;
            }
        }
        writeln!(f)?;

        // Pipeline Chaining section (if any)
        if self.on_done_workflow.is_some() || self.on_reject_workflow.is_some() {
            writeln!(f, "Pipeline Chaining")?;
            writeln!(f, "{}", "-".repeat(40))?;
            if let Some(ref on_done) = self.on_done_workflow {
                writeln!(f, "  On Done:   -> {}", on_done)?;
            }
            if let Some(ref on_reject) = self.on_reject_workflow {
                writeln!(f, "  On Reject: -> {}", on_reject)?;
            }
            writeln!(f)?;
        }

        // Metadata section (if any)
        if !self.metadata.is_empty() {
            writeln!(f, "Metadata")?;
            writeln!(f, "{}", "-".repeat(40))?;
            for (key, value) in &self.metadata {
                writeln!(f, "  {}: {}", key, value)?;
            }
            writeln!(f)?;
        }

        // Timestamps
        if self.created_at.is_some() || self.updated_at.is_some() {
            writeln!(f, "Timestamps")?;
            writeln!(f, "{}", "-".repeat(40))?;
            if let Some(ref created) = self.created_at {
                writeln!(f, "Created:  {}", format_timestamp(Some(created)))?;
            }
            if let Some(ref updated) = self.updated_at {
                writeln!(f, "Updated:  {}", format_timestamp(Some(updated)))?;
            }
        }

        Ok(())
    }
}

/// Format a timestamp for readable display
fn format_timestamp(ts: Option<&String>) -> String {
    match ts {
        Some(s) => {
            // Try to parse and format nicely, otherwise return as-is
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                dt.format("%Y-%m-%d %H:%M").to_string()
            } else {
                // Try parsing SurrealDB format
                s.replace('T', " ").replace('Z', "")
            }
        }
        None => String::new(),
    }
}

/// Show details of a specific workflow
#[derive(Debug, Args)]
pub struct WorkflowShowCommand {
    /// Workflow ID to show (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

impl WorkflowShowCommand {
    /// Execute the show workflow command.
    ///
    /// Fetches the workflow with the given ID and returns detailed information.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the workflow doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        let workflow = service.get_workflow(&self.id).await?;

        let workflow_id = workflow
            .id
            .as_ref()
            .map(|t| t.id.to_raw())
            .unwrap_or_else(|| self.id.clone());

        // Get steps: prefer first-class Steps, fall back to embedded steps
        #[allow(deprecated)]
        let steps = if workflow.steps.is_empty() {
            if let Some(ref workflow_thing) = workflow.id {
                let first_class_steps = service
                    .database()
                    .steps()
                    .list_by_workflow(workflow_thing)
                    .await?;
                // Convert first-class Steps to embedded WorkflowStep format
                first_class_steps
                    .into_iter()
                    .map(|s| WorkflowStep::new(s.name, s.agent_config, s.order as u32))
                    .collect()
            } else {
                workflow.steps
            }
        } else {
            workflow.steps
        };

        let detail = WorkflowDetail {
            id: workflow_id,
            name: workflow.name,
            description: workflow.description,
            steps,
            metadata: workflow.metadata,
            on_done_workflow: workflow.on_done_workflow,
            on_reject_workflow: workflow.on_reject_workflow,
            created_at: workflow.created_at.map(|dt| dt.to_rfc3339()),
            updated_at: workflow.updated_at.map(|dt| dt.to_rfc3339()),
        };
        Ok(detail.to_string())
    }
}

/// Update a workflow's properties
#[derive(Debug, Args)]
pub struct WorkflowUpdateCommand {
    /// Workflow ID to update (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// New name for the workflow
    #[arg(short, long)]
    pub name: Option<String>,

    /// New description for the workflow
    #[arg(short, long)]
    pub description: Option<String>,

    /// Clear the workflow description
    #[arg(long, conflicts_with = "description")]
    pub clear_description: bool,

    /// Workflow ID to chain to when the last step completes
    #[arg(long)]
    pub on_done: Option<String>,

    /// Clear the on-done workflow
    #[arg(long, conflicts_with = "on_done")]
    pub clear_on_done: bool,

    /// Workflow ID to chain to when the task is rejected
    #[arg(long)]
    pub on_reject: Option<String>,

    /// Clear the on-reject workflow
    #[arg(long, conflicts_with = "on_reject")]
    pub clear_on_reject: bool,
}

impl WorkflowUpdateCommand {
    /// Execute the update workflow command.
    ///
    /// Updates the workflow with the specified ID using the provided options.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the workflow doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Build the update options
        let mut options = UpdateWorkflowOptions::new();

        if let Some(name) = &self.name {
            options = options.with_name(name);
        }

        if let Some(description) = &self.description {
            options = options.with_description(description);
        } else if self.clear_description {
            options = options.clear_description();
        }

        if let Some(on_done) = &self.on_done {
            options = options.with_on_done_workflow(on_done);
        } else if self.clear_on_done {
            options = options.clear_on_done_workflow();
        }

        if let Some(on_reject) = &self.on_reject {
            options = options.with_on_reject_workflow(on_reject);
        } else if self.clear_on_reject {
            options = options.clear_on_reject_workflow();
        }

        // Check if any updates were provided
        if !options.has_updates() {
            return Err(ServiceError::validation_failed(
                "no updates specified (use --name, --description, --on-done, --on-reject, or --clear-* options)",
            ));
        }

        // Apply the updates
        service.update_workflow(&self.id, options).await?;

        Ok(format!("Updated workflow: {}", self.id))
    }
}

/// Delete a workflow
#[derive(Debug, Args)]
pub struct WorkflowDeleteCommand {
    /// Workflow ID to delete (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

impl WorkflowDeleteCommand {
    /// Execute the delete workflow command.
    ///
    /// Deletes the workflow with the specified ID.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the workflow doesn't exist.
    /// Returns `ServiceError::ConstraintViolation` if tasks are assigned to the workflow.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Delete the workflow
        service.delete_workflow(&self.id).await?;

        Ok(format!("Deleted workflow: {}", self.id))
    }
}

/// Assign a task to a workflow
#[derive(Debug, Args)]
pub struct WorkflowAssignCommand {
    /// Task ID to assign (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,

    /// Workflow ID to assign to (case-insensitive)
    #[arg(required = true)]
    pub workflow_id: String,
}

impl WorkflowAssignCommand {
    /// Execute the assign workflow command.
    ///
    /// Assigns a task to a workflow, setting the current step to the first step (0).
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task or workflow doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Assign the task to the workflow
        let result = service
            .assign_workflow(&self.task_id, &self.workflow_id)
            .await?;

        Ok(format!(
            "Assigned task {} to workflow {} at step 1: {}",
            result.task_id, result.workflow_id, result.first_step_name
        ))
    }
}

/// Remove workflow assignment from a task
#[derive(Debug, Args)]
pub struct WorkflowUnassignCommand {
    /// Task ID to unassign (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,
}

impl WorkflowUnassignCommand {
    /// Execute the unassign workflow command.
    ///
    /// Removes workflow assignment from a task, clearing workflow_id and current_step.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Unassign the workflow
        service.unassign_workflow(&self.task_id).await?;

        Ok(format!("Unassigned workflow from task {}", self.task_id))
    }
}

/// Advance a task to the next workflow step
#[derive(Debug, Args)]
pub struct WorkflowAdvanceCommand {
    /// Task ID to advance (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,
}

impl WorkflowAdvanceCommand {
    /// Execute the advance workflow command.
    ///
    /// Moves the task to the next step in its assigned workflow.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task doesn't exist.
    /// Returns `ServiceError::Validation` if the task is not assigned to a workflow
    /// or is already at the last step.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Advance the task to the next step
        let result = service.advance_step(&self.task_id).await?;

        // Get the execution ID for display (truncated to 6 chars)
        let exec_id = result
            .execution_id
            .as_deref()
            .unwrap_or("unknown")
            .chars()
            .take(6)
            .collect::<String>();

        // Build output message based on whether workflow chaining occurred
        let message = if let Some(chained_to) = &result.chained_to_workflow {
            format!(
                "Completed workflow {} and chained task {} to workflow {} at step 1: {} (execution: {})",
                result.workflow_id,
                result.task_id,
                chained_to,
                "Step 1", // The service returns the new step info
                exec_id
            )
        } else {
            format!(
                "Advanced task {} to step {}/{}: {} (execution: {})",
                result.task_id,
                result.to_step + 1,
                result.total_steps,
                result.step_name,
                exec_id
            )
        };

        Ok(message)
    }
}

/// Retreat a task to the previous workflow step
#[derive(Debug, Args)]
pub struct WorkflowRetreatCommand {
    /// Task ID to retreat (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,
}

impl WorkflowRetreatCommand {
    /// Execute the retreat workflow command.
    ///
    /// Moves the task to the previous step in its assigned workflow.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task doesn't exist.
    /// Returns `ServiceError::Validation` if the task is not assigned to a workflow
    /// or is already at the first step.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Retreat the task to the previous step
        let result = service.retreat_step(&self.task_id).await?;

        // Get the execution ID for display (truncated to 6 chars)
        let exec_id = result
            .execution_id
            .as_deref()
            .unwrap_or("unknown")
            .chars()
            .take(6)
            .collect::<String>();

        Ok(format!(
            "Retreated task {} to step {}/{}: {} (execution: {})",
            result.task_id,
            result.to_step + 1,
            result.total_steps,
            result.step_name,
            exec_id
        ))
    }
}

/// Reject a task in its workflow, triggering on_reject_workflow chaining if configured
#[derive(Debug, Args)]
pub struct WorkflowRejectCommand {
    /// Task ID to reject (case-insensitive)
    #[arg(required = true)]
    pub task_id: String,
}

impl WorkflowRejectCommand {
    /// Execute the reject workflow command.
    ///
    /// Rejects the task in its current workflow. If the workflow has an on_reject_workflow
    /// configured, the task will be assigned to that workflow. Otherwise, the task's
    /// workflow assignment is cleared.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the workflow service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the task doesn't exist.
    /// Returns `ServiceError::Validation` if the task is not assigned to a workflow.
    pub async fn execute(&self, service: &dyn WorkflowService) -> Result<String, ServiceError> {
        // Reject the task in its workflow
        let result = service.reject_task(&self.task_id).await?;

        // Build output message based on whether workflow chaining occurred
        let message = if let Some(chained_to) = &result.chained_to_workflow {
            let first_step = result.first_step_name.as_deref().unwrap_or("Step 1");
            let exec_id = result.execution_id.as_deref().unwrap_or("unknown");
            format!(
                "Rejected task {} from workflow {} and chained to workflow {} at step 1: {} (execution: {})",
                result.task_id,
                result.from_workflow_id,
                chained_to,
                first_step,
                &exec_id[..6.min(exec_id.len())]
            )
        } else {
            format!(
                "Rejected task {} from workflow {} (no on_reject_workflow configured, workflow unassigned)",
                result.task_id, result.from_workflow_id
            )
        };

        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vertebrae_core::{Database, ServiceError};

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Database {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        db
    }

    /// Helper to create a workflow service from a database
    fn create_service(db: &Database) -> DefaultWorkflowService {
        DefaultWorkflowService::new(db.clone())
    }

    // Step parsing tests
    #[test]
    fn test_parse_step_valid() {
        let result = parse_step("review:sonnet");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_config.model, Some("sonnet".to_string()));
    }

    #[test]
    fn test_parse_step_with_spaces() {
        let result = parse_step(" review : sonnet ");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_config.model, Some("sonnet".to_string()));
    }

    #[test]
    fn test_parse_step_with_multiple_colons() {
        // Should only split on the first colon
        let result = parse_step("review:model:with:colons");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(
            step.agent_config.model,
            Some("model:with:colons".to_string())
        );
    }

    #[test]
    fn test_parse_step_missing_colon() {
        let result = parse_step("review-sonnet");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid step format"));
        assert!(err.contains("name:model"));
    }

    #[test]
    fn test_parse_step_empty_name() {
        let result = parse_step(":sonnet");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("name cannot be empty"));
    }

    #[test]
    fn test_parse_step_empty_model() {
        let result = parse_step("review:");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("model cannot be empty"));
    }

    #[test]
    fn test_parse_step_whitespace_only_name() {
        let result = parse_step("   :sonnet");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("name cannot be empty"));
    }

    #[test]
    fn test_parse_step_whitespace_only_model() {
        let result = parse_step("review:   ");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("model cannot be empty"));
    }

    /// Extract the workflow ID from "Created workflow: {id}" message
    fn extract_workflow_id(msg: &str) -> String {
        msg.strip_prefix("Created workflow: ")
            .unwrap_or(msg)
            .to_string()
    }

    // WorkflowAddCommand tests
    #[tokio::test]
    async fn test_add_workflow_simple() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "My Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };

        let result = cmd
            .execute(&create_service(&db))
            .await
            .expect("Add should succeed");
        assert!(
            result.starts_with("Created workflow: "),
            "Result should start with 'Created workflow: '"
        );
        let id = extract_workflow_id(&result);
        assert_eq!(id.len(), 7); // 'x' prefix + 6 hex chars

        // Verify workflow was persisted
        let workflow = db.workflows().get(&id).await.unwrap();
        assert!(workflow.is_some());
        let workflow = workflow.unwrap();
        assert_eq!(workflow.name, "My Workflow");
        assert!(workflow.description.is_none());

        // Verify first-class Steps were created (not embedded steps)
        let workflow_thing = workflow.id.as_ref().unwrap();
        let steps = db.steps().list_by_workflow(workflow_thing).await.unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].name, "step1");
        assert_eq!(steps[0].agent_config.model, Some("agent1".to_string()));
        assert_eq!(steps[0].order, 0);
    }

    #[tokio::test]
    async fn test_add_workflow_with_description() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Described Workflow".to_string(),
            description: Some("A workflow with a description".to_string()),
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };

        let result = cmd
            .execute(&create_service(&db))
            .await
            .expect("Add should succeed");
        let id = extract_workflow_id(&result);

        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.name, "Described Workflow");
        assert_eq!(
            workflow.description,
            Some("A workflow with a description".to_string())
        );
    }

    #[tokio::test]
    async fn test_add_workflow_with_multiple_steps() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Multi-step Workflow".to_string(),
            description: None,
            steps: vec![
                ParsedStep {
                    name: "review".to_string(),
                    agent_config: AgentConfig::new().with_model("code-reviewer"),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_config: AgentConfig::new().with_model("tester"),
                },
                ParsedStep {
                    name: "deploy".to_string(),
                    agent_config: AgentConfig::new().with_model("deployer"),
                },
            ],
            on_done: None,
            on_reject: None,
        };

        let result = cmd
            .execute(&create_service(&db))
            .await
            .expect("Add should succeed");
        let id = extract_workflow_id(&result);

        let workflow = db.workflows().get(&id).await.unwrap().unwrap();

        // Verify first-class Steps were created (not embedded steps)
        let workflow_thing = workflow.id.as_ref().unwrap();
        let steps = db.steps().list_by_workflow(workflow_thing).await.unwrap();
        assert_eq!(steps.len(), 3);

        // Verify steps are ordered correctly
        assert_eq!(steps[0].name, "review");
        assert_eq!(steps[0].order, 0);
        assert_eq!(steps[1].name, "test");
        assert_eq!(steps[1].order, 1);
        assert_eq!(steps[2].name, "deploy");
        assert_eq!(steps[2].order, 2);
    }

    #[tokio::test]
    async fn test_add_workflow_empty_name_fails() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };

        let result = cmd.execute(&create_service(&db)).await;
        match result {
            Err(ServiceError::ValidationFailed { message: reason }) => {
                assert!(
                    reason.contains("name cannot be empty"),
                    "Expected 'name required' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_add_workflow_whitespace_name_fails() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "   ".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };

        let result = cmd.execute(&create_service(&db)).await;
        match result {
            Err(ServiceError::ValidationFailed { message: reason }) => {
                assert!(
                    reason.contains("name cannot be empty"),
                    "Expected 'name required' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_add_workflow_no_steps_fails() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "No Steps Workflow".to_string(),
            description: None,
            steps: vec![],
            on_done: None,
            on_reject: None,
        };

        let result = cmd.execute(&create_service(&db)).await;
        match result {
            Err(ServiceError::ValidationFailed { message: reason }) => {
                assert!(
                    reason.contains("at least one step"),
                    "Expected 'at least one step' in error, got: {}",
                    reason
                );
            }
            Err(other) => panic!("Expected InvalidPath error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_add_workflow_returns_6_char_id() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "ID test workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };

        let result = cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&result);
        assert_eq!(id.len(), 7); // 'x' prefix + 6 hex chars
        assert!(id.starts_with('x'));
        assert!(id[1..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[tokio::test]
    async fn test_unique_ids_for_multiple_workflows() {
        let db = setup_test_db().await;

        let mut ids = std::collections::HashSet::new();

        for i in 0..10 {
            let cmd = WorkflowAddCommand {
                name: format!("Workflow {}", i),
                description: None,
                steps: vec![ParsedStep {
                    name: "step1".to_string(),
                    agent_config: AgentConfig::new().with_model("agent1"),
                }],
                on_done: None,
                on_reject: None,
            };

            let result = cmd.execute(&create_service(&db)).await.unwrap();
            let id = extract_workflow_id(&result);
            assert!(ids.insert(id), "Duplicate ID generated");
        }
    }

    #[tokio::test]
    async fn test_workflow_exists_returns_false_for_nonexistent() {
        let db = setup_test_db().await;
        let service = create_service(&db);

        let exists = service.workflow_exists("xxxxxx").await.unwrap();
        assert!(!exists);
    }

    #[tokio::test]
    async fn test_workflow_exists_returns_true_for_existing() {
        let db = setup_test_db().await;
        let service = create_service(&db);

        let cmd = WorkflowAddCommand {
            name: "Existing workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };

        let result = cmd.execute(&service).await.unwrap();
        let id = extract_workflow_id(&result);

        let exists = service.workflow_exists(&id).await.unwrap();
        assert!(exists);
    }

    // ========================================
    // WorkflowListCommand tests
    // ========================================

    #[tokio::test]
    async fn test_list_workflows_shows_default_workflow() {
        let db = setup_test_db().await;

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&create_service(&db)).await.unwrap();

        // Default workflow is created on db.init()
        assert!(
            result.contains("default - Default Workflow"),
            "Expected default workflow in output: {}",
            result
        );
        assert!(
            result.contains("5 steps"),
            "Expected 5 steps in default workflow: {}",
            result
        );
    }

    #[tokio::test]
    async fn test_list_workflows_shows_all_with_step_counts() {
        let db = setup_test_db().await;

        // Create workflow with 1 step
        let add_cmd1 = WorkflowAddCommand {
            name: "Workflow A".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let result1 = add_cmd1.execute(&create_service(&db)).await.unwrap();
        let id1 = extract_workflow_id(&result1);

        // Create workflow with 3 steps
        let add_cmd2 = WorkflowAddCommand {
            name: "Workflow B".to_string(),
            description: Some("A workflow with description".to_string()),
            steps: vec![
                ParsedStep {
                    name: "review".to_string(),
                    agent_config: AgentConfig::new().with_model("reviewer"),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_config: AgentConfig::new().with_model("tester"),
                },
                ParsedStep {
                    name: "deploy".to_string(),
                    agent_config: AgentConfig::new().with_model("deployer"),
                },
            ],
            on_done: None,
            on_reject: None,
        };
        let result2 = add_cmd2.execute(&create_service(&db)).await.unwrap();
        let id2 = extract_workflow_id(&result2);

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&create_service(&db)).await.unwrap();

        // Should contain both workflows with step counts
        assert!(
            result.contains(&id1),
            "Should contain first workflow ID: {}",
            id1
        );
        assert!(result.contains("Workflow A"), "Should contain Workflow A");
        assert!(result.contains("(1 steps)"), "Should show 1 step count");

        assert!(
            result.contains(&id2),
            "Should contain second workflow ID: {}",
            id2
        );
        assert!(result.contains("Workflow B"), "Should contain Workflow B");
        assert!(result.contains("(3 steps)"), "Should show 3 step count");
        assert!(
            result.contains("A workflow with description"),
            "Should include description"
        );
    }

    #[tokio::test]
    async fn test_list_workflows_output_format() {
        let db = setup_test_db().await;

        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: Some("Test description".to_string()),
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&create_service(&db)).await.unwrap();

        // Verify the output format: "id - name (N steps) - description"
        assert!(
            result.contains(&format!(
                "{} - Test Workflow (1 steps) - Test description",
                id
            )),
            "Output format should be 'id - name (N steps) - description', got: {}",
            result
        );
    }

    // ========================================
    // WorkflowShowCommand tests
    // ========================================

    #[tokio::test]
    async fn test_show_workflow_displays_steps_in_order() {
        let db = setup_test_db().await;

        let add_cmd = WorkflowAddCommand {
            name: "Multi-step Workflow".to_string(),
            description: Some("Workflow description".to_string()),
            steps: vec![
                ParsedStep {
                    name: "review".to_string(),
                    agent_config: AgentConfig::new().with_model("code-reviewer"),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_config: AgentConfig::new().with_model("tester"),
                },
                ParsedStep {
                    name: "deploy".to_string(),
                    agent_config: AgentConfig::new().with_model("deployer"),
                },
            ],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let show_cmd = WorkflowShowCommand { id: id.clone() };
        let result = show_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify header
        assert!(
            result.contains(&format!("Workflow: {} - Multi-step Workflow", id)),
            "Should show header with ID and name"
        );

        // Verify description
        assert!(
            result.contains("Description"),
            "Should have Description section"
        );
        assert!(
            result.contains("Workflow description"),
            "Should show description content"
        );

        // Verify steps are shown in order
        assert!(result.contains("Steps (3 total)"), "Should show step count");
        assert!(
            result.contains("1. review (model: code-reviewer)"),
            "Should show step 1"
        );
        assert!(
            result.contains("2. test (model: tester)"),
            "Should show step 2"
        );
        assert!(
            result.contains("3. deploy (model: deployer)"),
            "Should show step 3"
        );
    }

    #[tokio::test]
    async fn test_show_workflow_not_found() {
        let db = setup_test_db().await;

        let cmd = WorkflowShowCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&create_service(&db)).await;
        assert!(result.is_err(), "Should return error for nonexistent ID");

        match result {
            Err(ServiceError::WorkflowNotFound { workflow_id }) => {
                assert_eq!(workflow_id, "nonexistent", "ID should be 'nonexistent'");
            }
            Err(other) => panic!("Expected NotFound error, got {:?}", other),
            Ok(_) => panic!("Expected error, got success"),
        }
    }

    #[tokio::test]
    async fn test_show_workflow_case_insensitive() {
        let db = setup_test_db().await;

        let add_cmd = WorkflowAddCommand {
            name: "Case Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Try with uppercase ID
        let show_cmd = WorkflowShowCommand {
            id: id.to_uppercase(),
        };
        let result = show_cmd.execute(&create_service(&db)).await;

        assert!(
            result.is_ok(),
            "Should find workflow with case-insensitive ID"
        );
        assert!(
            result.unwrap().contains("Case Test Workflow"),
            "Should show workflow name"
        );
    }

    #[tokio::test]
    async fn test_show_workflow_without_description() {
        let db = setup_test_db().await;

        let add_cmd = WorkflowAddCommand {
            name: "No Desc Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let show_cmd = WorkflowShowCommand { id: id.clone() };
        let result = show_cmd.execute(&create_service(&db)).await.unwrap();

        // Should not have a Description section
        assert!(
            !result.contains("Description\n---"),
            "Should not show Description section when none exists"
        );
        assert!(
            result.contains("Steps (1 total)"),
            "Should still show Steps section"
        );
    }

    // ========================================
    // Display tests
    // ========================================

    #[test]
    fn test_workflow_summary_display() {
        let summary = WorkflowSummary {
            id: "abc123".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("A test workflow".to_string()),
            step_count: 3,
        };

        let output = format!("{}", summary);
        assert_eq!(output, "abc123 - Test Workflow (3 steps) - A test workflow");
    }

    #[test]
    fn test_workflow_summary_display_no_description() {
        let summary = WorkflowSummary {
            id: "def456".to_string(),
            name: "Simple Workflow".to_string(),
            description: None,
            step_count: 1,
        };

        let output = format!("{}", summary);
        assert_eq!(output, "def456 - Simple Workflow (1 steps)");
    }

    #[test]
    fn test_workflow_detail_display() {
        let detail = WorkflowDetail {
            id: "abc123".to_string(),
            name: "Full Workflow".to_string(),
            description: Some("A complete workflow".to_string()),
            steps: vec![
                WorkflowStep::new("step1", AgentConfig::new().with_model("agent1"), 0),
                WorkflowStep::new("step2", AgentConfig::new().with_model("agent2"), 1),
            ],
            metadata: std::collections::HashMap::new(),
            on_done_workflow: None,
            on_reject_workflow: None,
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);

        assert!(output.contains("Workflow: abc123 - Full Workflow"));
        assert!(output.contains("Description"));
        assert!(output.contains("A complete workflow"));
        assert!(output.contains("Steps (2 total)"));
        assert!(output.contains("1. step1 (model: agent1)"));
        assert!(output.contains("2. step2 (model: agent2)"));
    }

    #[test]
    fn test_workflow_detail_display_with_metadata() {
        let mut metadata = std::collections::HashMap::new();
        metadata.insert("version".to_string(), "1.0".to_string());
        metadata.insert("team".to_string(), "platform".to_string());

        let detail = WorkflowDetail {
            id: "abc123".to_string(),
            name: "Metadata Workflow".to_string(),
            description: None,
            steps: vec![WorkflowStep::new(
                "step1",
                AgentConfig::new().with_model("agent1"),
                0,
            )],
            metadata,
            on_done_workflow: None,
            on_reject_workflow: None,
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);

        assert!(output.contains("Metadata"));
        // HashMap order is not guaranteed, so check for both keys
        assert!(output.contains("version: 1.0"));
        assert!(output.contains("team: platform"));
    }

    #[test]
    fn test_format_timestamp() {
        // RFC3339 format
        assert_eq!(
            format_timestamp(Some(&"2024-01-15T10:30:00+00:00".to_string())),
            "2024-01-15 10:30"
        );

        // SurrealDB format fallback
        let result = format_timestamp(Some(&"2024-01-15T10:30:00Z".to_string()));
        assert!(result.contains("2024-01-15"));

        // None
        assert_eq!(format_timestamp(None), "");
    }

    #[test]
    fn test_workflow_list_command_debug() {
        let cmd = WorkflowListCommand {};
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowListCommand"),
            "Debug output should contain WorkflowListCommand"
        );
    }

    #[test]
    fn test_workflow_show_command_debug() {
        let cmd = WorkflowShowCommand {
            id: "test123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowShowCommand") && debug_str.contains("test123"),
            "Debug output should contain WorkflowShowCommand and id"
        );
    }

    #[test]
    fn test_workflow_summary_clone() {
        let summary = WorkflowSummary {
            id: "abc123".to_string(),
            name: "Test".to_string(),
            description: Some("desc".to_string()),
            step_count: 2,
        };

        let cloned = summary.clone();
        assert_eq!(summary.id, cloned.id);
        assert_eq!(summary.name, cloned.name);
        assert_eq!(summary.description, cloned.description);
        assert_eq!(summary.step_count, cloned.step_count);
    }

    #[test]
    fn test_workflow_summary_debug() {
        let summary = WorkflowSummary {
            id: "abc123".to_string(),
            name: "Test Workflow".to_string(),
            description: Some("A description".to_string()),
            step_count: 3,
        };

        let debug_str = format!("{:?}", summary);
        assert!(
            debug_str.contains("WorkflowSummary")
                && debug_str.contains("abc123")
                && debug_str.contains("Test Workflow")
                && debug_str.contains("step_count: 3"),
            "Debug output should contain all fields"
        );
    }

    #[test]
    fn test_workflow_detail_debug() {
        let detail = WorkflowDetail {
            id: "abc123".to_string(),
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![],
            metadata: std::collections::HashMap::new(),
            on_done_workflow: None,
            on_reject_workflow: None,
            created_at: None,
            updated_at: None,
        };

        let debug_str = format!("{:?}", detail);
        assert!(
            debug_str.contains("WorkflowDetail")
                && debug_str.contains("abc123")
                && debug_str.contains("Test Workflow"),
            "Debug output should contain WorkflowDetail and fields"
        );
    }

    // ========================================
    // WorkflowUpdateCommand tests
    // ========================================

    #[tokio::test]
    async fn test_update_workflow_name() {
        let db = setup_test_db().await;

        // Create a workflow first
        let add_cmd = WorkflowAddCommand {
            name: "Original Name".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Update the name
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: Some("New Name".to_string()),
            description: None,
            clear_description: false,
            on_done: None,
            clear_on_done: false,
            on_reject: None,
            clear_on_reject: false,
        };
        let result = update_cmd.execute(&create_service(&db)).await.unwrap();
        assert_eq!(result, format!("Updated workflow: {}", id));

        // Verify the update
        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.name, "New Name");
    }

    #[tokio::test]
    async fn test_update_workflow_description() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Update the description
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: None,
            description: Some("New description".to_string()),
            clear_description: false,
            on_done: None,
            clear_on_done: false,
            on_reject: None,
            clear_on_reject: false,
        };
        let result = update_cmd.execute(&create_service(&db)).await.unwrap();
        assert_eq!(result, format!("Updated workflow: {}", id));

        // Verify the update
        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.description, Some("New description".to_string()));
    }

    #[tokio::test]
    async fn test_update_workflow_clear_description() {
        let db = setup_test_db().await;

        // Create a workflow with description
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: Some("Original description".to_string()),
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Clear the description
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: None,
            description: None,
            clear_description: true,
            on_done: None,
            clear_on_done: false,
            on_reject: None,
            clear_on_reject: false,
        };
        let result = update_cmd.execute(&create_service(&db)).await.unwrap();
        assert_eq!(result, format!("Updated workflow: {}", id));

        // Verify the update
        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert!(workflow.description.is_none());
    }

    #[tokio::test]
    async fn test_update_workflow_not_found() {
        let db = setup_test_db().await;

        let update_cmd = WorkflowUpdateCommand {
            id: "nonexistent".to_string(),
            name: Some("New Name".to_string()),
            description: None,
            clear_description: false,
            on_done: None,
            clear_on_done: false,
            on_reject: None,
            clear_on_reject: false,
        };

        let result = update_cmd.execute(&create_service(&db)).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::WorkflowNotFound { workflow_id } => {
                assert_eq!(workflow_id, "nonexistent");
            }
            e => panic!("Expected WorkflowNotFound error, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_update_workflow_no_updates_fails() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Try to update with no changes
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: None,
            description: None,
            clear_description: false,
            on_done: None,
            clear_on_done: false,
            on_reject: None,
            clear_on_reject: false,
        };

        let result = update_cmd.execute(&create_service(&db)).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::ValidationFailed { message: reason } => {
                assert!(
                    reason.contains("no updates specified"),
                    "Expected 'no updates specified' in error, got: {}",
                    reason
                );
            }
            e => panic!("Expected InvalidPath error, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_update_workflow_empty_name_fails() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Try to update with empty name
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: Some("   ".to_string()),
            description: None,
            clear_description: false,
            on_done: None,
            clear_on_done: false,
            on_reject: None,
            clear_on_reject: false,
        };

        let result = update_cmd.execute(&create_service(&db)).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::ValidationFailed { message: reason } => {
                assert!(
                    reason.contains("name cannot be empty"),
                    "Expected 'name cannot be empty' in error, got: {}",
                    reason
                );
            }
            e => panic!("Expected InvalidPath error, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_update_workflow_case_insensitive() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Update using uppercase ID
        let update_cmd = WorkflowUpdateCommand {
            id: id.to_uppercase(),
            name: Some("Updated Name".to_string()),
            description: None,
            clear_description: false,
            on_done: None,
            clear_on_done: false,
            on_reject: None,
            clear_on_reject: false,
        };

        let result = update_cmd.execute(&create_service(&db)).await;
        assert!(result.is_ok(), "Should update with case-insensitive ID");

        // Verify the update
        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.name, "Updated Name");
    }

    #[test]
    fn test_workflow_update_command_debug() {
        let cmd = WorkflowUpdateCommand {
            id: "test123".to_string(),
            name: Some("New Name".to_string()),
            description: None,
            clear_description: false,
            on_done: None,
            clear_on_done: false,
            on_reject: None,
            clear_on_reject: false,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowUpdateCommand")
                && debug_str.contains("test123")
                && debug_str.contains("New Name"),
            "Debug output should contain WorkflowUpdateCommand and fields"
        );
    }

    // ========================================
    // WorkflowDeleteCommand tests
    // ========================================

    #[tokio::test]
    async fn test_delete_workflow_success() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "To Be Deleted".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Verify it exists
        assert!(db.workflows().exists(&id).await.unwrap());

        // Delete it
        let delete_cmd = WorkflowDeleteCommand { id: id.clone() };
        let result = delete_cmd.execute(&create_service(&db)).await.unwrap();
        assert_eq!(result, format!("Deleted workflow: {}", id));

        // Verify it's gone
        assert!(!db.workflows().exists(&id).await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_workflow_not_found() {
        let db = setup_test_db().await;

        let delete_cmd = WorkflowDeleteCommand {
            id: "nonexistent".to_string(),
        };

        let result = delete_cmd.execute(&create_service(&db)).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::WorkflowNotFound { workflow_id } => {
                assert_eq!(workflow_id, "nonexistent");
            }
            e => panic!("Expected WorkflowNotFound error, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_delete_workflow_case_insensitive() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Case Test".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Delete using uppercase ID
        let delete_cmd = WorkflowDeleteCommand {
            id: id.to_uppercase(),
        };

        let result = delete_cmd.execute(&create_service(&db)).await;
        assert!(result.is_ok(), "Should delete with case-insensitive ID");

        // Verify it's gone
        assert!(!db.workflows().exists(&id).await.unwrap());
    }

    #[test]
    fn test_workflow_delete_command_debug() {
        let cmd = WorkflowDeleteCommand {
            id: "test123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowDeleteCommand") && debug_str.contains("test123"),
            "Debug output should contain WorkflowDeleteCommand and id"
        );
    }

    // ========================================
    // WorkflowAssignCommand tests
    // ========================================

    /// Helper to create a test task
    async fn create_test_task(db: &Database, id: &str, title: &str) {
        use vertebrae_db::{Level, Task};
        let task = Task::new(title, Level::Task);
        db.tasks().create(id, &task).await.unwrap();
    }

    #[tokio::test]
    async fn test_assign_workflow_success() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![
                ParsedStep {
                    name: "review".to_string(),
                    agent_config: AgentConfig::new().with_model("reviewer"),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_config: AgentConfig::new().with_model("tester"),
                },
            ],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task
        create_test_task(&db, "abc123", "Test Task").await;

        // Assign the task to the workflow
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        let result = assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify the output message
        assert!(
            result.contains("Assigned task abc123 to workflow"),
            "Should show assignment message: {}",
            result
        );
        assert!(
            result.contains("review"),
            "Should show first step name: {}",
            result
        );

        // Verify the task was updated with workflow assignment
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert!(task.workflow_id.is_some(), "Task should have workflow_id");
        assert_eq!(task.current_step, Some(0), "Task should be at step 0");
    }

    #[tokio::test]
    async fn test_assign_workflow_task_not_found() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Try to assign a non-existent task
        let assign_cmd = WorkflowAssignCommand {
            task_id: "nonexistent".to_string(),
            workflow_id: workflow_id.clone(),
        };
        let result = assign_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::TaskNotFound { task_id } => {
                assert_eq!(task_id, "nonexistent");
            }
            e => panic!("Expected TaskNotFound error, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_assign_workflow_workflow_not_found() {
        let db = setup_test_db().await;

        // Create a task
        create_test_task(&db, "abc123", "Test Task").await;

        // Try to assign to a non-existent workflow
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: "nonexistent".to_string(),
        };
        let result = assign_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::WorkflowNotFound { workflow_id } => {
                assert_eq!(workflow_id, "nonexistent");
            }
            e => panic!("Expected WorkflowNotFound error, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_assign_workflow_case_insensitive() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task
        create_test_task(&db, "def456", "Test Task").await;

        // Assign using uppercase IDs
        let assign_cmd = WorkflowAssignCommand {
            task_id: "DEF456".to_string(),
            workflow_id: workflow_id.to_uppercase(),
        };
        let result = assign_cmd.execute(&create_service(&db)).await;
        assert!(result.is_ok(), "Should assign with case-insensitive IDs");
    }

    #[test]
    fn test_workflow_assign_command_debug() {
        let cmd = WorkflowAssignCommand {
            task_id: "task123".to_string(),
            workflow_id: "workflow456".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowAssignCommand")
                && debug_str.contains("task123")
                && debug_str.contains("workflow456"),
            "Debug output should contain WorkflowAssignCommand and fields"
        );
    }

    // ========================================
    // WorkflowUnassignCommand tests
    // ========================================

    #[tokio::test]
    async fn test_unassign_workflow_success() {
        let db = setup_test_db().await;

        // Create a workflow
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_config: AgentConfig::new().with_model("agent1"),
            }],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify task is assigned
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert!(task.workflow_id.is_some(), "Task should have workflow_id");

        // Unassign the workflow
        let unassign_cmd = WorkflowUnassignCommand {
            task_id: "abc123".to_string(),
        };
        let result = unassign_cmd.execute(&create_service(&db)).await.unwrap();
        assert_eq!(result, "Unassigned workflow from task abc123");

        // Verify task no longer has workflow assignment
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert!(
            task.workflow_id.is_none(),
            "Task should not have workflow_id after unassign"
        );
        assert!(
            task.current_step.is_none(),
            "Task should not have current_step after unassign"
        );
    }

    #[tokio::test]
    async fn test_unassign_workflow_task_not_found() {
        let db = setup_test_db().await;

        let unassign_cmd = WorkflowUnassignCommand {
            task_id: "nonexistent".to_string(),
        };
        let result = unassign_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::TaskNotFound { task_id } => {
                assert_eq!(task_id, "nonexistent");
            }
            e => panic!("Expected TaskNotFound error, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_unassign_workflow_case_insensitive() {
        let db = setup_test_db().await;

        // Create a task
        create_test_task(&db, "abc123", "Test Task").await;

        // Unassign using uppercase ID (even though not assigned, it should work)
        let unassign_cmd = WorkflowUnassignCommand {
            task_id: "ABC123".to_string(),
        };
        let result = unassign_cmd.execute(&create_service(&db)).await;
        assert!(result.is_ok(), "Should unassign with case-insensitive ID");
    }

    #[test]
    fn test_workflow_unassign_command_debug() {
        let cmd = WorkflowUnassignCommand {
            task_id: "task123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowUnassignCommand") && debug_str.contains("task123"),
            "Debug output should contain WorkflowUnassignCommand and task_id"
        );
    }

    // ========================================
    // WorkflowAdvanceCommand tests
    // ========================================

    #[tokio::test]
    async fn test_advance_workflow_success() {
        let db = setup_test_db().await;

        // Create a workflow with 3 steps
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![
                ParsedStep {
                    name: "step1".to_string(),
                    agent_config: AgentConfig::new().with_model("agent1"),
                },
                ParsedStep {
                    name: "step2".to_string(),
                    agent_config: AgentConfig::new().with_model("agent2"),
                },
                ParsedStep {
                    name: "step3".to_string(),
                    agent_config: AgentConfig::new().with_model("agent3"),
                },
            ],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify task is at step 0
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(0));

        // Advance to step 1
        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "abc123".to_string(),
        };
        let result = advance_cmd.execute(&create_service(&db)).await.unwrap();
        assert!(result.contains("2/3"), "Should show step 2 of 3");
        assert!(result.contains("step2"), "Should show step2 name");

        // Verify task is at step 1
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(1));
    }

    #[tokio::test]
    async fn test_advance_workflow_at_last_step() {
        let db = setup_test_db().await;

        // Create a workflow with 2 steps
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![
                ParsedStep {
                    name: "first".to_string(),
                    agent_config: AgentConfig::new().with_model("agent1"),
                },
                ParsedStep {
                    name: "last".to_string(),
                    agent_config: AgentConfig::new().with_model("agent2"),
                },
            ],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Advance to last step
        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "abc123".to_string(),
        };
        advance_cmd.execute(&create_service(&db)).await.unwrap();

        // Try to advance again - should fail
        let result = advance_cmd.execute(&create_service(&db)).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::ValidationFailed { message } => {
                assert!(
                    message.contains("already at the last step"),
                    "Error should mention last step: {}",
                    message
                );
            }
            e => panic!("Expected ValidationError, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_advance_workflow_not_assigned() {
        let db = setup_test_db().await;

        // Create a task without workflow assignment
        create_test_task(&db, "abc123", "Test Task").await;

        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "abc123".to_string(),
        };
        let result = advance_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::ValidationFailed { message } => {
                assert!(
                    message.contains("does not have a workflow assigned"),
                    "Error should mention not assigned: {}",
                    message
                );
            }
            e => panic!("Expected ValidationError, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_advance_workflow_task_not_found() {
        let db = setup_test_db().await;

        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "nonexistent".to_string(),
        };
        let result = advance_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::TaskNotFound { task_id } => {
                assert_eq!(task_id, "nonexistent");
            }
            e => panic!("Expected TaskNotFound error, got {:?}", e),
        }
    }

    #[test]
    fn test_workflow_advance_command_debug() {
        let cmd = WorkflowAdvanceCommand {
            task_id: "task123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowAdvanceCommand") && debug_str.contains("task123"),
            "Debug output should contain WorkflowAdvanceCommand and task_id"
        );
    }

    // ========================================
    // WorkflowRetreatCommand tests
    // ========================================

    #[tokio::test]
    async fn test_retreat_workflow_success() {
        let db = setup_test_db().await;

        // Create a workflow with 3 steps
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![
                ParsedStep {
                    name: "step1".to_string(),
                    agent_config: AgentConfig::new().with_model("agent1"),
                },
                ParsedStep {
                    name: "step2".to_string(),
                    agent_config: AgentConfig::new().with_model("agent2"),
                },
                ParsedStep {
                    name: "step3".to_string(),
                    agent_config: AgentConfig::new().with_model("agent3"),
                },
            ],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Advance to step 2
        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "abc123".to_string(),
        };
        advance_cmd.execute(&create_service(&db)).await.unwrap();
        advance_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify task is at step 2
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(2));

        // Retreat to step 1
        let retreat_cmd = WorkflowRetreatCommand {
            task_id: "abc123".to_string(),
        };
        let result = retreat_cmd.execute(&create_service(&db)).await.unwrap();
        assert!(result.contains("2/3"), "Should show step 2 of 3");
        assert!(result.contains("step2"), "Should show step2 name");

        // Verify task is at step 1
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(1));
    }

    #[tokio::test]
    async fn test_retreat_workflow_at_first_step() {
        let db = setup_test_db().await;

        // Create a workflow with 2 steps
        let add_cmd = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![
                ParsedStep {
                    name: "first".to_string(),
                    agent_config: AgentConfig::new().with_model("agent1"),
                },
                ParsedStep {
                    name: "second".to_string(),
                    agent_config: AgentConfig::new().with_model("agent2"),
                },
            ],
            on_done: None,
            on_reject: None,
        };
        let add_result = add_cmd.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it (starts at step 0)
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Try to retreat - should fail
        let retreat_cmd = WorkflowRetreatCommand {
            task_id: "abc123".to_string(),
        };
        let result = retreat_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::ValidationFailed { message } => {
                assert!(
                    message.contains("already at the first step"),
                    "Error should mention first step: {}",
                    message
                );
            }
            e => panic!("Expected ValidationError, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_retreat_workflow_not_assigned() {
        let db = setup_test_db().await;

        // Create a task without workflow assignment
        create_test_task(&db, "abc123", "Test Task").await;

        let retreat_cmd = WorkflowRetreatCommand {
            task_id: "abc123".to_string(),
        };
        let result = retreat_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::ValidationFailed { message } => {
                assert!(
                    message.contains("does not have a workflow assigned"),
                    "Error should mention not assigned: {}",
                    message
                );
            }
            e => panic!("Expected ValidationError, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_retreat_workflow_task_not_found() {
        let db = setup_test_db().await;

        let retreat_cmd = WorkflowRetreatCommand {
            task_id: "nonexistent".to_string(),
        };
        let result = retreat_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::TaskNotFound { task_id } => {
                assert_eq!(task_id, "nonexistent");
            }
            e => panic!("Expected TaskNotFound error, got {:?}", e),
        }
    }

    #[test]
    fn test_workflow_retreat_command_debug() {
        let cmd = WorkflowRetreatCommand {
            task_id: "task123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowRetreatCommand") && debug_str.contains("task123"),
            "Debug output should contain WorkflowRetreatCommand and task_id"
        );
    }

    // ========================================
    // Pipeline Chaining tests
    // ========================================

    #[tokio::test]
    async fn test_advance_workflow_chains_on_done() {
        let db = setup_test_db().await;

        // Create a second workflow to chain to
        let second_workflow = WorkflowAddCommand {
            name: "Review Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "review".to_string(),
                agent_config: AgentConfig::new().with_model("reviewer"),
            }],
            on_done: None,
            on_reject: None,
        };
        let second_result = second_workflow.execute(&create_service(&db)).await.unwrap();
        let second_workflow_id = extract_workflow_id(&second_result);

        // Create a first workflow with on_done chaining to second
        let first_workflow = WorkflowAddCommand {
            name: "Process Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "process".to_string(),
                agent_config: AgentConfig::new().with_model("processor"),
            }],
            on_done: Some(second_workflow_id.clone()),
            on_reject: None,
        };
        let first_result = first_workflow.execute(&create_service(&db)).await.unwrap();
        let first_workflow_id = extract_workflow_id(&first_result);

        // Create a task and assign it to the first workflow
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: first_workflow_id.clone(),
        };
        assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Advance - should chain to the second workflow
        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "abc123".to_string(),
        };
        let result = advance_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify the chaining message
        assert!(
            result.contains("Completed workflow") && result.contains("chained"),
            "Result should mention completed and chained: {}",
            result
        );
        assert!(
            result.contains(&second_workflow_id),
            "Result should mention the new workflow ID: {}",
            result
        );

        // Verify task is now assigned to the second workflow at step 0
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        let task_workflow_id = task.workflow_id.as_ref().unwrap().id.to_raw();
        // SurrealDB treats numeric-looking IDs as numbers, stripping leading zeros
        // so we compare by checking if one contains the other (after trimming zeros)
        assert!(
            second_workflow_id.contains(&task_workflow_id)
                || task_workflow_id.contains(&second_workflow_id),
            "Workflow IDs should match: {} vs {}",
            task_workflow_id,
            second_workflow_id
        );
        assert_eq!(task.current_step, Some(0));
    }

    #[tokio::test]
    async fn test_reject_workflow_chains_on_reject() {
        let db = setup_test_db().await;

        // Create a recovery workflow
        let recovery_workflow = WorkflowAddCommand {
            name: "Recovery Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "recovery".to_string(),
                agent_config: AgentConfig::new().with_model("recovery-agent"),
            }],
            on_done: None,
            on_reject: None,
        };
        let recovery_result = recovery_workflow
            .execute(&create_service(&db))
            .await
            .unwrap();
        let recovery_workflow_id = extract_workflow_id(&recovery_result);

        // Create a main workflow with on_reject chaining
        let main_workflow = WorkflowAddCommand {
            name: "Main Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "main".to_string(),
                agent_config: AgentConfig::new().with_model("main-agent"),
            }],
            on_done: None,
            on_reject: Some(recovery_workflow_id.clone()),
        };
        let main_result = main_workflow.execute(&create_service(&db)).await.unwrap();
        let main_workflow_id = extract_workflow_id(&main_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: main_workflow_id.clone(),
        };
        assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Reject - should chain to recovery workflow
        let reject_cmd = WorkflowRejectCommand {
            task_id: "abc123".to_string(),
        };
        let result = reject_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify the chaining message
        assert!(
            result.contains("Rejected") && result.contains("chained"),
            "Result should mention rejected and chained: {}",
            result
        );
        assert!(
            result.contains(&recovery_workflow_id),
            "Result should mention the recovery workflow ID: {}",
            result
        );

        // Verify task is now assigned to the recovery workflow at step 0
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        let task_workflow_id = task.workflow_id.as_ref().unwrap().id.to_raw();
        // SurrealDB treats numeric-looking IDs as numbers, stripping leading zeros
        assert!(
            recovery_workflow_id.contains(&task_workflow_id)
                || task_workflow_id.contains(&recovery_workflow_id),
            "Workflow IDs should match: {} vs {}",
            task_workflow_id,
            recovery_workflow_id
        );
        assert_eq!(task.current_step, Some(0));
    }

    #[tokio::test]
    async fn test_reject_without_on_reject_unassigns_workflow() {
        let db = setup_test_db().await;

        // Create a workflow without on_reject
        let workflow = WorkflowAddCommand {
            name: "Test Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "test".to_string(),
                agent_config: AgentConfig::new().with_model("test-agent"),
            }],
            on_done: None,
            on_reject: None,
        };
        let result = workflow.execute(&create_service(&db)).await.unwrap();
        let workflow_id = extract_workflow_id(&result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&create_service(&db)).await.unwrap();

        // Reject - should unassign the workflow
        let reject_cmd = WorkflowRejectCommand {
            task_id: "abc123".to_string(),
        };
        let result = reject_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify the unassignment message
        assert!(
            result.contains("Rejected") && result.contains("workflow unassigned"),
            "Result should mention rejected and workflow unassigned: {}",
            result
        );

        // Verify task has no workflow assigned
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert!(task.workflow_id.is_none());
        assert!(task.current_step.is_none());
    }

    #[tokio::test]
    async fn test_reject_task_not_assigned() {
        let db = setup_test_db().await;

        // Create a task without workflow assignment
        create_test_task(&db, "abc123", "Test Task").await;

        let reject_cmd = WorkflowRejectCommand {
            task_id: "abc123".to_string(),
        };
        let result = reject_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::ValidationFailed { message } => {
                assert!(
                    message.contains("does not have a workflow assigned"),
                    "Error should mention not assigned: {}",
                    message
                );
            }
            e => panic!("Expected ValidationError, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_reject_task_not_found() {
        let db = setup_test_db().await;

        let reject_cmd = WorkflowRejectCommand {
            task_id: "nonexistent".to_string(),
        };
        let result = reject_cmd.execute(&create_service(&db)).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServiceError::TaskNotFound { task_id } => {
                assert_eq!(task_id, "nonexistent");
            }
            e => panic!("Expected TaskNotFound error, got {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_workflow_show_displays_chaining_info() {
        let db = setup_test_db().await;

        // Create two workflows
        let done_workflow = WorkflowAddCommand {
            name: "Done Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "done".to_string(),
                agent_config: AgentConfig::new().with_model("done-agent"),
            }],
            on_done: None,
            on_reject: None,
        };
        let done_result = done_workflow.execute(&create_service(&db)).await.unwrap();
        let done_id = extract_workflow_id(&done_result);

        let reject_workflow = WorkflowAddCommand {
            name: "Reject Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "reject".to_string(),
                agent_config: AgentConfig::new().with_model("reject-agent"),
            }],
            on_done: None,
            on_reject: None,
        };
        let reject_result = reject_workflow.execute(&create_service(&db)).await.unwrap();
        let reject_id = extract_workflow_id(&reject_result);

        // Create a main workflow with both chaining options
        let main_workflow = WorkflowAddCommand {
            name: "Main Workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "main".to_string(),
                agent_config: AgentConfig::new().with_model("main-agent"),
            }],
            on_done: Some(done_id.clone()),
            on_reject: Some(reject_id.clone()),
        };
        let main_result = main_workflow.execute(&create_service(&db)).await.unwrap();
        let main_id = extract_workflow_id(&main_result);

        // Show the workflow
        let show_cmd = WorkflowShowCommand { id: main_id };
        let result = show_cmd.execute(&create_service(&db)).await.unwrap();

        // Verify chaining info is displayed
        assert!(
            result.contains("Pipeline Chaining"),
            "Should have Pipeline Chaining section: {}",
            result
        );
        assert!(
            result.contains("On Done:") && result.contains(&done_id),
            "Should show on_done workflow: {}",
            result
        );
        assert!(
            result.contains("On Reject:") && result.contains(&reject_id),
            "Should show on_reject workflow: {}",
            result
        );
    }

    #[test]
    fn test_workflow_reject_command_debug() {
        let cmd = WorkflowRejectCommand {
            task_id: "task123".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(
            debug_str.contains("WorkflowRejectCommand") && debug_str.contains("task123"),
            "Debug output should contain WorkflowRejectCommand and task_id"
        );
    }
}
