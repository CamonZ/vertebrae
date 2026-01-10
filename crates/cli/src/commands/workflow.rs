//! Workflow commands for managing workflow definitions
//!
//! Implements the `vtb workflow` subcommand group for creating and managing workflows.

use crate::id::IdGenerator;
use clap::{Args, Subcommand};
use vertebrae_db::{Database, DbError, Workflow, WorkflowStep, WorkflowUpdate};

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
}

impl WorkflowCommand {
    /// Execute the workflow subcommand.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if the command execution fails.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        match self {
            WorkflowCommand::Add(cmd) => cmd.execute(db).await,
            WorkflowCommand::List(cmd) => cmd.execute(db).await,
            WorkflowCommand::Show(cmd) => cmd.execute(db).await,
            WorkflowCommand::Update(cmd) => cmd.execute(db).await,
            WorkflowCommand::Delete(cmd) => cmd.execute(db).await,
            WorkflowCommand::Assign(cmd) => cmd.execute(db).await,
            WorkflowCommand::Unassign(cmd) => cmd.execute(db).await,
            WorkflowCommand::Advance(cmd) => cmd.execute(db).await,
            WorkflowCommand::Retreat(cmd) => cmd.execute(db).await,
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

    /// Workflow steps in 'name:agent_template' format (can be specified multiple times)
    #[arg(short, long = "step", value_parser = parse_step)]
    pub steps: Vec<ParsedStep>,
}

/// A parsed workflow step from the command line
#[derive(Debug, Clone)]
pub struct ParsedStep {
    /// Name of the step
    pub name: String,
    /// Agent template for the step
    pub agent_template: String,
}

/// Parse a step string in 'name:agent_template' format
fn parse_step(s: &str) -> Result<ParsedStep, String> {
    let parts: Vec<&str> = s.splitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!(
            "invalid step format '{}'. Expected 'name:agent_template' format (e.g., 'review:code-reviewer')",
            s
        ));
    }

    let name = parts[0].trim();
    let agent_template = parts[1].trim();

    if name.is_empty() {
        return Err("step name cannot be empty".to_string());
    }

    if agent_template.is_empty() {
        return Err("agent template cannot be empty".to_string());
    }

    Ok(ParsedStep {
        name: name.to_string(),
        agent_template: agent_template.to_string(),
    })
}

impl WorkflowAddCommand {
    /// Execute the add workflow command.
    ///
    /// Creates a new workflow with the specified options and stores it in the database.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if:
    /// - The name is empty
    /// - No steps are provided
    /// - Database operations fail
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Validate name is not empty
        if self.name.trim().is_empty() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from("name"),
                reason: "workflow name required".to_string(),
            });
        }

        // Validate at least one step is provided
        if self.steps.is_empty() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from("steps"),
                reason: "at least one step is required (use --step 'name:agent_template')"
                    .to_string(),
            });
        }

        // Generate unique ID with collision detection
        let id = self.generate_unique_id(db).await?;

        // Create the workflow
        let mut workflow = Workflow::new(self.name.clone());

        if let Some(description) = &self.description {
            workflow = workflow.with_description(description.clone());
        }

        // Add steps with order based on command line position
        for (order, parsed_step) in self.steps.iter().enumerate() {
            let step = WorkflowStep::new(
                parsed_step.name.clone(),
                parsed_step.agent_template.clone(),
                order as u32,
            );
            workflow = workflow.with_step(step);
        }

        // Store the workflow in the database
        db.workflows().create(&id, &workflow).await?;

        Ok(format!("Created workflow: {}", id))
    }

    /// Check if a workflow with the given ID exists.
    async fn workflow_exists(&self, db: &Database, id: &str) -> Result<bool, DbError> {
        db.workflows().exists(id).await
    }

    /// Generate a unique ID that doesn't collide with existing workflows.
    async fn generate_unique_id(&self, db: &Database) -> Result<String, DbError> {
        let mut generator = IdGenerator::new(&self.name);

        while let Some(id) = generator.next_id() {
            if !self.workflow_exists(db, &id).await? {
                return Ok(id);
            }
        }

        Err(DbError::InvalidPath {
            path: std::path::PathBuf::from("id"),
            reason: "failed to generate unique ID after maximum retries".to_string(),
        })
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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if database operations fail.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        let workflows = db.workflows().list().await?;

        if workflows.is_empty() {
            return Ok("No workflows found".to_string());
        }

        let summaries: Vec<WorkflowSummary> = workflows
            .into_iter()
            .map(|w| {
                let id =
                    w.id.as_ref()
                        .map(|t| t.id.to_raw())
                        .unwrap_or_else(|| "unknown".to_string());
                WorkflowSummary {
                    id,
                    name: w.name,
                    description: w.description,
                    step_count: w.steps.len(),
                }
            })
            .collect();

        let output = summaries
            .iter()
            .map(|s| s.to_string())
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
                let skills_str = if step.skills.is_empty() {
                    String::new()
                } else {
                    format!(" [skills: {}]", step.skills.join(", "))
                };
                writeln!(
                    f,
                    "{}. {} (agent: {}){}",
                    step.order + 1,
                    step.name,
                    step.agent_template,
                    skills_str
                )?;
            }
        }
        writeln!(f)?;

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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the workflow doesn't exist.
    /// Returns `DbError` if database operations fail.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        let workflow = db.workflows().get(&id).await?;

        match workflow {
            Some(w) => {
                let detail = WorkflowDetail {
                    id: w
                        .id
                        .as_ref()
                        .map(|t| t.id.to_raw())
                        .unwrap_or_else(|| id.clone()),
                    name: w.name,
                    description: w.description,
                    steps: w.steps,
                    metadata: w.metadata,
                    created_at: w.created_at.map(|dt| dt.to_rfc3339()),
                    updated_at: w.updated_at.map(|dt| dt.to_rfc3339()),
                };
                Ok(detail.to_string())
            }
            None => Err(DbError::NotFound {
                entity: "workflow".to_string(),
                id: self.id.clone(),
            }),
        }
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
}

impl WorkflowUpdateCommand {
    /// Execute the update workflow command.
    ///
    /// Updates the workflow with the specified ID using the provided options.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the workflow doesn't exist.
    /// Returns `DbError` if database operations fail.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Build the update
        let mut updates = WorkflowUpdate::new();

        if let Some(name) = &self.name {
            if name.trim().is_empty() {
                return Err(DbError::InvalidPath {
                    path: std::path::PathBuf::from("name"),
                    reason: "workflow name cannot be empty".to_string(),
                });
            }
            updates = updates.with_name(name.clone());
        }

        if let Some(description) = &self.description {
            updates = updates.with_description(description.clone());
        } else if self.clear_description {
            updates = updates.clear_description();
        }

        // Check if any updates were provided
        if !updates.has_updates() {
            return Err(DbError::InvalidPath {
                path: std::path::PathBuf::from("updates"),
                reason: "no updates specified (use --name, --description, or --clear-description)"
                    .to_string(),
            });
        }

        // Apply the updates
        db.workflows().update(&id, &updates).await?;

        Ok(format!("Updated workflow: {}", id))
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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the workflow doesn't exist.
    /// Returns `DbError::ConstraintViolation` if tasks are assigned to the workflow.
    /// Returns `DbError` if database operations fail.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Check if workflow exists first
        let exists = db.workflows().exists(&id).await?;
        if !exists {
            return Err(DbError::NotFound {
                entity: "workflow".to_string(),
                id: self.id.clone(),
            });
        }

        // TODO: When task-workflow binding is implemented, check if any tasks
        // are assigned to this workflow and return an error if so.
        // For now, we allow deletion since no tasks can be bound to workflows yet.

        // Delete the workflow
        db.workflows().delete(&id).await?;

        Ok(format!("Deleted workflow: {}", id))
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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the task or workflow doesn't exist.
    /// Returns `DbError` if database operations fail.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize IDs to lowercase for case-insensitive lookup
        let task_id = self.task_id.to_lowercase();
        let workflow_id = self.workflow_id.to_lowercase();

        // Check if task exists
        let task_exists = db.tasks().exists(&task_id).await?;
        if !task_exists {
            return Err(DbError::NotFound {
                entity: "task".to_string(),
                id: self.task_id.clone(),
            });
        }

        // Check if workflow exists and get its info
        let workflow = db.workflows().get(&workflow_id).await?;
        let workflow = match workflow {
            Some(w) => w,
            None => {
                return Err(DbError::NotFound {
                    entity: "workflow".to_string(),
                    id: self.workflow_id.clone(),
                });
            }
        };

        // Get the workflow Thing ID for assignment
        let workflow_thing = workflow.id.clone().ok_or_else(|| DbError::InvalidPath {
            path: std::path::PathBuf::from(&workflow_id),
            reason: "workflow has no ID".to_string(),
        })?;

        // Assign the task to the workflow
        db.tasks()
            .assign_workflow(&task_id, &workflow_thing)
            .await?;

        // Get the first step name for display
        let first_step_name = workflow
            .ordered_steps()
            .first()
            .map(|s| s.name.clone())
            .unwrap_or_else(|| "Step 1".to_string());

        Ok(format!(
            "Assigned task {} to workflow {} at step 1: {}",
            task_id, workflow_id, first_step_name
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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the task doesn't exist.
    /// Returns `DbError` if database operations fail.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let task_id = self.task_id.to_lowercase();

        // Check if task exists
        let task_exists = db.tasks().exists(&task_id).await?;
        if !task_exists {
            return Err(DbError::NotFound {
                entity: "task".to_string(),
                id: self.task_id.clone(),
            });
        }

        // Unassign the workflow
        db.tasks().unassign_workflow(&task_id).await?;

        Ok(format!("Unassigned workflow from task {}", task_id))
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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the task doesn't exist.
    /// Returns `DbError::Validation` if the task is not assigned to a workflow
    /// or is already at the last step.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let task_id = self.task_id.to_lowercase();

        // Get the task to check workflow assignment
        let task = db.tasks().get(&task_id).await?;
        let task = match task {
            Some(t) => t,
            None => {
                return Err(DbError::NotFound {
                    entity: "task".to_string(),
                    id: self.task_id.clone(),
                });
            }
        };

        // Check if task is assigned to a workflow
        let workflow_id = match &task.workflow_id {
            Some(wf_id) => wf_id,
            None => {
                return Err(DbError::ValidationError {
                    message: format!("Task {} is not assigned to any workflow", task_id),
                });
            }
        };

        let current_step = task.current_step.unwrap_or(0);

        // Get the workflow to check step boundaries
        let workflow = db.workflows().get(&workflow_id.id.to_raw()).await?;
        let workflow = match workflow {
            Some(w) => w,
            None => {
                return Err(DbError::ValidationError {
                    message: format!(
                        "Task {} is assigned to non-existent workflow {}",
                        task_id,
                        workflow_id.id.to_raw()
                    ),
                });
            }
        };

        let total_steps = workflow.ordered_steps().len();

        // Check if already at last step
        if current_step + 1 >= total_steps {
            let current_step_name = workflow
                .ordered_steps()
                .get(current_step)
                .map(|s| s.name.clone())
                .unwrap_or_else(|| format!("Step {}", current_step + 1));
            return Err(DbError::ValidationError {
                message: format!(
                    "Task {} is already at the last step: {} ({}/{})",
                    task_id,
                    current_step_name,
                    current_step + 1,
                    total_steps
                ),
            });
        }

        // Advance to next step
        let new_step = current_step + 1;
        db.tasks().update_current_step(&task_id, new_step).await?;

        // Get step names for display
        let new_step_name = workflow
            .ordered_steps()
            .get(new_step)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| format!("Step {}", new_step + 1));

        Ok(format!(
            "Advanced task {} to step {}/{}: {}",
            task_id,
            new_step + 1,
            total_steps,
            new_step_name
        ))
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
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError::NotFound` if the task doesn't exist.
    /// Returns `DbError::Validation` if the task is not assigned to a workflow
    /// or is already at the first step.
    pub async fn execute(&self, db: &Database) -> Result<String, DbError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let task_id = self.task_id.to_lowercase();

        // Get the task to check workflow assignment
        let task = db.tasks().get(&task_id).await?;
        let task = match task {
            Some(t) => t,
            None => {
                return Err(DbError::NotFound {
                    entity: "task".to_string(),
                    id: self.task_id.clone(),
                });
            }
        };

        // Check if task is assigned to a workflow
        let workflow_id = match &task.workflow_id {
            Some(wf_id) => wf_id,
            None => {
                return Err(DbError::ValidationError {
                    message: format!("Task {} is not assigned to any workflow", task_id),
                });
            }
        };

        let current_step = task.current_step.unwrap_or(0);

        // Check if already at first step
        if current_step == 0 {
            // Get the workflow for step name
            let workflow = db.workflows().get(&workflow_id.id.to_raw()).await?;
            let step_name = workflow
                .and_then(|w| w.ordered_steps().first().map(|s| s.name.clone()))
                .unwrap_or_else(|| "Step 1".to_string());
            return Err(DbError::ValidationError {
                message: format!(
                    "Task {} is already at the first step: {}",
                    task_id, step_name
                ),
            });
        }

        // Get the workflow for step info
        let workflow = db.workflows().get(&workflow_id.id.to_raw()).await?;
        let total_steps = workflow
            .as_ref()
            .map(|w| w.ordered_steps().len())
            .unwrap_or(0);

        // Retreat to previous step
        let new_step = current_step - 1;
        db.tasks().update_current_step(&task_id, new_step).await?;

        // Get step name for display
        let new_step_name = workflow
            .and_then(|w| w.ordered_steps().get(new_step).map(|s| s.name.clone()))
            .unwrap_or_else(|| format!("Step {}", new_step + 1));

        Ok(format!(
            "Retreated task {} to step {}/{}: {}",
            task_id,
            new_step + 1,
            total_steps,
            new_step_name
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Database {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        db
    }

    // Step parsing tests
    #[test]
    fn test_parse_step_valid() {
        let result = parse_step("review:code-reviewer");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_template, "code-reviewer");
    }

    #[test]
    fn test_parse_step_with_spaces() {
        let result = parse_step(" review : code-reviewer ");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_template, "code-reviewer");
    }

    #[test]
    fn test_parse_step_with_multiple_colons() {
        // Should only split on the first colon
        let result = parse_step("review:code:reviewer:template");
        assert!(result.is_ok());
        let step = result.unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_template, "code:reviewer:template");
    }

    #[test]
    fn test_parse_step_missing_colon() {
        let result = parse_step("review-code-reviewer");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("invalid step format"));
        assert!(err.contains("name:agent_template"));
    }

    #[test]
    fn test_parse_step_empty_name() {
        let result = parse_step(":code-reviewer");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("name cannot be empty"));
    }

    #[test]
    fn test_parse_step_empty_agent_template() {
        let result = parse_step("review:");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("agent template cannot be empty"));
    }

    #[test]
    fn test_parse_step_whitespace_only_name() {
        let result = parse_step("   :code-reviewer");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("name cannot be empty"));
    }

    #[test]
    fn test_parse_step_whitespace_only_agent_template() {
        let result = parse_step("review:   ");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("agent template cannot be empty"));
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
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.expect("Add should succeed");
        assert!(
            result.starts_with("Created workflow: "),
            "Result should start with 'Created workflow: '"
        );
        let id = extract_workflow_id(&result);
        assert_eq!(id.len(), 6);

        // Verify workflow was persisted
        let workflow = db.workflows().get(&id).await.unwrap();
        assert!(workflow.is_some());
        let workflow = workflow.unwrap();
        assert_eq!(workflow.name, "My Workflow");
        assert!(workflow.description.is_none());
        assert_eq!(workflow.steps.len(), 1);
        assert_eq!(workflow.steps[0].name, "step1");
        assert_eq!(workflow.steps[0].agent_template, "agent1");
        assert_eq!(workflow.steps[0].order, 0);
    }

    #[tokio::test]
    async fn test_add_workflow_with_description() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Described Workflow".to_string(),
            description: Some("A workflow with a description".to_string()),
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.expect("Add should succeed");
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
                    agent_template: "code-reviewer".to_string(),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_template: "tester".to_string(),
                },
                ParsedStep {
                    name: "deploy".to_string(),
                    agent_template: "deployer".to_string(),
                },
            ],
        };

        let result = cmd.execute(&db).await.expect("Add should succeed");
        let id = extract_workflow_id(&result);

        let workflow = db.workflows().get(&id).await.unwrap().unwrap();
        assert_eq!(workflow.steps.len(), 3);

        // Verify steps are ordered correctly
        assert_eq!(workflow.steps[0].name, "review");
        assert_eq!(workflow.steps[0].order, 0);
        assert_eq!(workflow.steps[1].name, "test");
        assert_eq!(workflow.steps[1].order, 1);
        assert_eq!(workflow.steps[2].name, "deploy");
        assert_eq!(workflow.steps[2].order, 2);
    }

    #[tokio::test]
    async fn test_add_workflow_empty_name_fails() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("name required"),
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
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("name required"),
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
        };

        let result = cmd.execute(&db).await;
        match result {
            Err(DbError::InvalidPath { reason, .. }) => {
                assert!(
                    reason.contains("at least one step is required"),
                    "Expected 'at least one step is required' in error, got: {}",
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
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&result);
        assert_eq!(id.len(), 6);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
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
                    agent_template: "agent1".to_string(),
                }],
            };

            let result = cmd.execute(&db).await.unwrap();
            let id = extract_workflow_id(&result);
            assert!(ids.insert(id), "Duplicate ID generated");
        }
    }

    #[tokio::test]
    async fn test_workflow_exists_returns_false_for_nonexistent() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Test".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let exists = cmd.workflow_exists(&db, "xxxxxx").await.unwrap();
        assert!(!exists);
    }

    #[tokio::test]
    async fn test_workflow_exists_returns_true_for_existing() {
        let db = setup_test_db().await;

        let cmd = WorkflowAddCommand {
            name: "Existing workflow".to_string(),
            description: None,
            steps: vec![ParsedStep {
                name: "step1".to_string(),
                agent_template: "agent1".to_string(),
            }],
        };

        let result = cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&result);

        let exists = cmd.workflow_exists(&db, &id).await.unwrap();
        assert!(exists);
    }

    // ========================================
    // WorkflowListCommand tests
    // ========================================

    #[tokio::test]
    async fn test_list_workflows_empty() {
        let db = setup_test_db().await;

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&db).await.unwrap();

        assert_eq!(result, "No workflows found");
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
                agent_template: "agent1".to_string(),
            }],
        };
        let result1 = add_cmd1.execute(&db).await.unwrap();
        let id1 = extract_workflow_id(&result1);

        // Create workflow with 3 steps
        let add_cmd2 = WorkflowAddCommand {
            name: "Workflow B".to_string(),
            description: Some("A workflow with description".to_string()),
            steps: vec![
                ParsedStep {
                    name: "review".to_string(),
                    agent_template: "reviewer".to_string(),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_template: "tester".to_string(),
                },
                ParsedStep {
                    name: "deploy".to_string(),
                    agent_template: "deployer".to_string(),
                },
            ],
        };
        let result2 = add_cmd2.execute(&db).await.unwrap();
        let id2 = extract_workflow_id(&result2);

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&db).await.unwrap();

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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let cmd = WorkflowListCommand {};
        let result = cmd.execute(&db).await.unwrap();

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
                    agent_template: "code-reviewer".to_string(),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_template: "tester".to_string(),
                },
                ParsedStep {
                    name: "deploy".to_string(),
                    agent_template: "deployer".to_string(),
                },
            ],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let show_cmd = WorkflowShowCommand { id: id.clone() };
        let result = show_cmd.execute(&db).await.unwrap();

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
            result.contains("1. review (agent: code-reviewer)"),
            "Should show step 1"
        );
        assert!(
            result.contains("2. test (agent: tester)"),
            "Should show step 2"
        );
        assert!(
            result.contains("3. deploy (agent: deployer)"),
            "Should show step 3"
        );
    }

    #[tokio::test]
    async fn test_show_workflow_not_found() {
        let db = setup_test_db().await;

        let cmd = WorkflowShowCommand {
            id: "nonexistent".to_string(),
        };

        let result = cmd.execute(&db).await;
        assert!(result.is_err(), "Should return error for nonexistent ID");

        match result {
            Err(DbError::NotFound { entity, id }) => {
                assert_eq!(entity, "workflow", "Entity should be 'workflow'");
                assert_eq!(id, "nonexistent", "ID should be 'nonexistent'");
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Try with uppercase ID
        let show_cmd = WorkflowShowCommand {
            id: id.to_uppercase(),
        };
        let result = show_cmd.execute(&db).await;

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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        let show_cmd = WorkflowShowCommand { id: id.clone() };
        let result = show_cmd.execute(&db).await.unwrap();

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
                WorkflowStep::new("step1", "agent1", 0),
                WorkflowStep::new("step2", "agent2", 1),
            ],
            metadata: std::collections::HashMap::new(),
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);

        assert!(output.contains("Workflow: abc123 - Full Workflow"));
        assert!(output.contains("Description"));
        assert!(output.contains("A complete workflow"));
        assert!(output.contains("Steps (2 total)"));
        assert!(output.contains("1. step1 (agent: agent1)"));
        assert!(output.contains("2. step2 (agent: agent2)"));
    }

    #[test]
    fn test_workflow_detail_display_with_skills() {
        let detail = WorkflowDetail {
            id: "abc123".to_string(),
            name: "Skill Workflow".to_string(),
            description: None,
            steps: vec![
                WorkflowStep::new("step1", "agent1", 0)
                    .with_skill("skill1")
                    .with_skill("skill2"),
            ],
            metadata: std::collections::HashMap::new(),
            created_at: None,
            updated_at: None,
        };

        let output = format!("{}", detail);

        assert!(output.contains("[skills: skill1, skill2]"));
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
            steps: vec![WorkflowStep::new("step1", "agent1", 0)],
            metadata,
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Update the name
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: Some("New Name".to_string()),
            description: None,
            clear_description: false,
        };
        let result = update_cmd.execute(&db).await.unwrap();
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Update the description
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: None,
            description: Some("New description".to_string()),
            clear_description: false,
        };
        let result = update_cmd.execute(&db).await.unwrap();
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Clear the description
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: None,
            description: None,
            clear_description: true,
        };
        let result = update_cmd.execute(&db).await.unwrap();
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
        };

        let result = update_cmd.execute(&db).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::NotFound { entity, id } => {
                assert_eq!(entity, "workflow");
                assert_eq!(id, "nonexistent");
            }
            e => panic!("Expected NotFound error, got {:?}", e),
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Try to update with no changes
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: None,
            description: None,
            clear_description: false,
        };

        let result = update_cmd.execute(&db).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::InvalidPath { reason, .. } => {
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Try to update with empty name
        let update_cmd = WorkflowUpdateCommand {
            id: id.clone(),
            name: Some("   ".to_string()),
            description: None,
            clear_description: false,
        };

        let result = update_cmd.execute(&db).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::InvalidPath { reason, .. } => {
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Update using uppercase ID
        let update_cmd = WorkflowUpdateCommand {
            id: id.to_uppercase(),
            name: Some("Updated Name".to_string()),
            description: None,
            clear_description: false,
        };

        let result = update_cmd.execute(&db).await;
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Verify it exists
        assert!(db.workflows().exists(&id).await.unwrap());

        // Delete it
        let delete_cmd = WorkflowDeleteCommand { id: id.clone() };
        let result = delete_cmd.execute(&db).await.unwrap();
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

        let result = delete_cmd.execute(&db).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::NotFound { entity, id } => {
                assert_eq!(entity, "workflow");
                assert_eq!(id, "nonexistent");
            }
            e => panic!("Expected NotFound error, got {:?}", e),
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let id = extract_workflow_id(&add_result);

        // Delete using uppercase ID
        let delete_cmd = WorkflowDeleteCommand {
            id: id.to_uppercase(),
        };

        let result = delete_cmd.execute(&db).await;
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
                    agent_template: "reviewer".to_string(),
                },
                ParsedStep {
                    name: "test".to_string(),
                    agent_template: "tester".to_string(),
                },
            ],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task
        create_test_task(&db, "abc123", "Test Task").await;

        // Assign the task to the workflow
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        let result = assign_cmd.execute(&db).await.unwrap();

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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Try to assign a non-existent task
        let assign_cmd = WorkflowAssignCommand {
            task_id: "nonexistent".to_string(),
            workflow_id: workflow_id.clone(),
        };
        let result = assign_cmd.execute(&db).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::NotFound { entity, id } => {
                assert_eq!(entity, "task");
                assert_eq!(id, "nonexistent");
            }
            e => panic!("Expected NotFound error, got {:?}", e),
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
        let result = assign_cmd.execute(&db).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::NotFound { entity, id } => {
                assert_eq!(entity, "workflow");
                assert_eq!(id, "nonexistent");
            }
            e => panic!("Expected NotFound error, got {:?}", e),
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task
        create_test_task(&db, "def456", "Test Task").await;

        // Assign using uppercase IDs
        let assign_cmd = WorkflowAssignCommand {
            task_id: "DEF456".to_string(),
            workflow_id: workflow_id.to_uppercase(),
        };
        let result = assign_cmd.execute(&db).await;
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
                agent_template: "agent1".to_string(),
            }],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&db).await.unwrap();

        // Verify task is assigned
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert!(task.workflow_id.is_some(), "Task should have workflow_id");

        // Unassign the workflow
        let unassign_cmd = WorkflowUnassignCommand {
            task_id: "abc123".to_string(),
        };
        let result = unassign_cmd.execute(&db).await.unwrap();
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
        let result = unassign_cmd.execute(&db).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::NotFound { entity, id } => {
                assert_eq!(entity, "task");
                assert_eq!(id, "nonexistent");
            }
            e => panic!("Expected NotFound error, got {:?}", e),
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
        let result = unassign_cmd.execute(&db).await;
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
                    agent_template: "agent1".to_string(),
                },
                ParsedStep {
                    name: "step2".to_string(),
                    agent_template: "agent2".to_string(),
                },
                ParsedStep {
                    name: "step3".to_string(),
                    agent_template: "agent3".to_string(),
                },
            ],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&db).await.unwrap();

        // Verify task is at step 0
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(0));

        // Advance to step 1
        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "abc123".to_string(),
        };
        let result = advance_cmd.execute(&db).await.unwrap();
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
                    agent_template: "agent1".to_string(),
                },
                ParsedStep {
                    name: "last".to_string(),
                    agent_template: "agent2".to_string(),
                },
            ],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&db).await.unwrap();

        // Advance to last step
        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "abc123".to_string(),
        };
        advance_cmd.execute(&db).await.unwrap();

        // Try to advance again - should fail
        let result = advance_cmd.execute(&db).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
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
        let result = advance_cmd.execute(&db).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert!(
                    message.contains("not assigned to any workflow"),
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
        let result = advance_cmd.execute(&db).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::NotFound { entity, id } => {
                assert_eq!(entity, "task");
                assert_eq!(id, "nonexistent");
            }
            e => panic!("Expected NotFound error, got {:?}", e),
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
                    agent_template: "agent1".to_string(),
                },
                ParsedStep {
                    name: "step2".to_string(),
                    agent_template: "agent2".to_string(),
                },
                ParsedStep {
                    name: "step3".to_string(),
                    agent_template: "agent3".to_string(),
                },
            ],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&db).await.unwrap();

        // Advance to step 2
        let advance_cmd = WorkflowAdvanceCommand {
            task_id: "abc123".to_string(),
        };
        advance_cmd.execute(&db).await.unwrap();
        advance_cmd.execute(&db).await.unwrap();

        // Verify task is at step 2
        let task = db.tasks().get("abc123").await.unwrap().unwrap();
        assert_eq!(task.current_step, Some(2));

        // Retreat to step 1
        let retreat_cmd = WorkflowRetreatCommand {
            task_id: "abc123".to_string(),
        };
        let result = retreat_cmd.execute(&db).await.unwrap();
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
                    agent_template: "agent1".to_string(),
                },
                ParsedStep {
                    name: "second".to_string(),
                    agent_template: "agent2".to_string(),
                },
            ],
        };
        let add_result = add_cmd.execute(&db).await.unwrap();
        let workflow_id = extract_workflow_id(&add_result);

        // Create a task and assign it (starts at step 0)
        create_test_task(&db, "abc123", "Test Task").await;
        let assign_cmd = WorkflowAssignCommand {
            task_id: "abc123".to_string(),
            workflow_id: workflow_id.clone(),
        };
        assign_cmd.execute(&db).await.unwrap();

        // Try to retreat - should fail
        let retreat_cmd = WorkflowRetreatCommand {
            task_id: "abc123".to_string(),
        };
        let result = retreat_cmd.execute(&db).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
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
        let result = retreat_cmd.execute(&db).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::ValidationError { message } => {
                assert!(
                    message.contains("not assigned to any workflow"),
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
        let result = retreat_cmd.execute(&db).await;

        assert!(result.is_err());
        match result.unwrap_err() {
            DbError::NotFound { entity, id } => {
                assert_eq!(entity, "task");
                assert_eq!(id, "nonexistent");
            }
            e => panic!("Expected NotFound error, got {:?}", e),
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
}
