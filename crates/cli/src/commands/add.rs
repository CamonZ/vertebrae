//! Add command for creating new tasks
//!
//! Implements the `vtb add` command to create new tasks with all supported options.

use clap::Args;
use vertebrae_core::{
    CreateTaskOptions, DefaultWorkflowService, ServiceError, TaskService, WorkflowService,
};
use vertebrae_db::{Level, Priority};

/// Create a new task
#[derive(Debug, Args)]
pub struct AddCommand {
    /// Title of the task
    #[arg(required = true)]
    pub title: String,

    /// Task level (epic, ticket, task)
    #[arg(short, long, value_parser = parse_level)]
    pub level: Option<Level>,

    /// Detailed description
    #[arg(short, long)]
    pub description: Option<String>,

    /// Priority (low, medium, high, critical)
    #[arg(short, long, value_parser = parse_priority)]
    pub priority: Option<Priority>,

    /// Tags (can be specified multiple times)
    #[arg(short, long = "tag")]
    pub tags: Vec<String>,

    /// Parent task ID (creates child_of relationship)
    #[arg(long)]
    pub parent: Option<String>,

    /// Dependency task ID (can be specified multiple times)
    #[arg(long = "depends-on")]
    pub depends_on: Vec<String>,

    /// Mark task as needing human review before completion
    #[arg(long = "needs-review")]
    pub needs_review: bool,

    /// Workflow ID to assign task to (defaults to 'default')
    #[arg(long)]
    pub workflow: Option<String>,
}

/// Parse a level string into a Level enum
fn parse_level(s: &str) -> Result<Level, String> {
    match s.to_lowercase().as_str() {
        "epic" => Ok(Level::Epic),
        "ticket" => Ok(Level::Ticket),
        "task" => Ok(Level::Task),
        _ => Err(format!(
            "invalid level '{}'. Valid values: epic, ticket, task",
            s
        )),
    }
}

/// Parse a priority string into a Priority enum
fn parse_priority(s: &str) -> Result<Priority, String> {
    match s.to_lowercase().as_str() {
        "low" => Ok(Priority::Low),
        "medium" => Ok(Priority::Medium),
        "high" => Ok(Priority::High),
        "critical" => Ok(Priority::Critical),
        _ => Err(format!(
            "invalid priority '{}'. Valid values: low, medium, high, critical",
            s
        )),
    }
}

impl AddCommand {
    /// Execute the add command.
    ///
    /// Creates a new task with the specified options and stores it in the database.
    /// Automatically assigns the task to a workflow (defaults to "default") to enable
    /// execution history tracking when transitioning through workflow steps.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The title is empty
    /// - Parent task doesn't exist
    /// - Dependency tasks don't exist
    /// - Specified workflow doesn't exist
    /// - Service operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        // Validate title is not empty
        if self.title.trim().is_empty() {
            return Err(ServiceError::ValidationFailed {
                message: "title required".to_string(),
            });
        }

        // Build create task options using service layer API
        let mut options = CreateTaskOptions::new(&self.title);

        // Set level (defaults to Task)
        if let Some(level) = &self.level {
            options = options.with_level(level.clone());
        }

        // Set description
        if let Some(description) = &self.description {
            options = options.with_description(description);
        }

        // Set priority
        if let Some(priority) = &self.priority {
            options = options.with_priority(priority.clone());
        }

        // Add tags
        for tag in &self.tags {
            options = options.with_tag(tag);
        }

        // Set parent
        if let Some(parent_id) = &self.parent {
            options = options.with_parent(parent_id);
        }

        // Add dependencies
        for dep_id in &self.depends_on {
            options = options.with_dependency(dep_id);
        }

        // Set needs review
        if self.needs_review {
            options = options.with_needs_review(true);
        }

        // Create the task using the service layer
        // This will automatically fire MutationCallback events
        let id = service.create_task(options).await?;

        // Assign to custom workflow if specified
        if let Some(workflow_id) = &self.workflow {
            #[allow(deprecated)]
            let db = service.database().clone();
            let workflow_service = DefaultWorkflowService::new(db);

            // Validate workflow exists and assign
            workflow_service.assign_workflow(&id, workflow_id).await?;
        }

        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_level_valid() {
        assert_eq!(parse_level("epic").unwrap(), Level::Epic);
        assert_eq!(parse_level("ticket").unwrap(), Level::Ticket);
        assert_eq!(parse_level("task").unwrap(), Level::Task);
    }

    #[test]
    fn test_parse_level_case_insensitive() {
        assert_eq!(parse_level("EPIC").unwrap(), Level::Epic);
        assert_eq!(parse_level("Epic").unwrap(), Level::Epic);
        assert_eq!(parse_level("TICKET").unwrap(), Level::Ticket);
    }

    #[test]
    fn test_parse_level_invalid() {
        let result = parse_level("invalid");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid level"));
    }

    #[test]
    fn test_parse_priority_valid() {
        assert_eq!(parse_priority("low").unwrap(), Priority::Low);
        assert_eq!(parse_priority("medium").unwrap(), Priority::Medium);
        assert_eq!(parse_priority("high").unwrap(), Priority::High);
        assert_eq!(parse_priority("critical").unwrap(), Priority::Critical);
    }

    #[test]
    fn test_parse_priority_case_insensitive() {
        assert_eq!(parse_priority("LOW").unwrap(), Priority::Low);
        assert_eq!(parse_priority("High").unwrap(), Priority::High);
        assert_eq!(parse_priority("CRITICAL").unwrap(), Priority::Critical);
    }

    #[test]
    fn test_parse_priority_invalid() {
        let result = parse_priority("wrong");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid priority"));
    }
}

// Integration tests are in tests/ directory and use TestContext
// These unit tests only verify the parsing functions
