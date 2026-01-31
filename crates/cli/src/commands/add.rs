//! Add command for creating new tasks
//!
//! Implements the `vtb add` command to create new tasks with all supported options.

use clap::Args;
use vertebrae_core::{CreateTaskOptions, ServiceError, VertebraeServices};
use vertebrae_core::{Level, Priority};

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
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
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
        let id = services.tasks().create_task(options).await?;

        // Assign to custom workflow if specified
        if let Some(workflow_id) = &self.workflow {
            services
                .workflows()
                .assign_workflow(&id, workflow_id)
                .await?;
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

    // ==================== Async execute tests ====================

    async fn setup_services() -> VertebraeServices {
        let db = vertebrae_core::Database::connect_mem().await.unwrap();
        db.init().await.unwrap();
        VertebraeServices::new(db)
    }

    #[tokio::test]
    async fn test_execute_add_minimal() {
        let services = setup_services().await;
        let cmd = AddCommand {
            title: "My task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
        let id = result.unwrap();
        assert!(!id.is_empty());

        // Verify task was created
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.title, "My task");
        assert_eq!(task.level, Level::Task); // default
    }

    #[tokio::test]
    async fn test_execute_add_with_all_options() {
        let services = setup_services().await;
        let cmd = AddCommand {
            title: "Epic task".to_string(),
            level: Some(Level::Epic),
            description: Some("Detailed description".to_string()),
            priority: Some(Priority::High),
            tags: vec!["backend".to_string(), "api".to_string()],
            parent: None,
            depends_on: vec![],
            needs_review: true,
            workflow: None,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
        let id = result.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.title, "Epic task");
        assert_eq!(task.level, Level::Epic);
        assert_eq!(task.description, Some("Detailed description".to_string()));
        assert_eq!(task.priority, Some(Priority::High));
        assert!(task.tags.contains(&"backend".to_string()));
        assert!(task.tags.contains(&"api".to_string()));
    }

    #[tokio::test]
    async fn test_execute_add_empty_title_fails() {
        let services = setup_services().await;
        let cmd = AddCommand {
            title: "   ".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
        let err = format!("{}", result.unwrap_err());
        assert!(err.contains("title") || err.contains("Title"));
    }

    #[tokio::test]
    async fn test_execute_add_with_parent() {
        let services = setup_services().await;

        // Create parent task first
        let parent_cmd = AddCommand {
            title: "Parent epic".to_string(),
            level: Some(Level::Epic),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let parent_id = parent_cmd.execute(&services).await.unwrap();

        // Create child task
        let child_cmd = AddCommand {
            title: "Child task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: Some(parent_id.clone()),
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let child_id = child_cmd.execute(&services).await.unwrap();
        assert!(!child_id.is_empty());
    }

    #[tokio::test]
    async fn test_execute_add_with_nonexistent_parent_fails() {
        let services = setup_services().await;
        let cmd = AddCommand {
            title: "Orphan task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: Some("nonexistent".to_string()),
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_execute_add_with_dependency() {
        let services = setup_services().await;

        // Create the blocker task first
        let blocker_cmd = AddCommand {
            title: "Blocker task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let blocker_id = blocker_cmd.execute(&services).await.unwrap();

        // Create dependent task
        let cmd = AddCommand {
            title: "Dependent task".to_string(),
            level: None,
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![blocker_id],
            needs_review: false,
            workflow: None,
        };
        let result = cmd.execute(&services).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_execute_add_ticket_level() {
        let services = setup_services().await;
        let cmd = AddCommand {
            title: "Ticket".to_string(),
            level: Some(Level::Ticket),
            description: None,
            priority: None,
            tags: vec![],
            parent: None,
            depends_on: vec![],
            needs_review: false,
            workflow: None,
        };
        let id = cmd.execute(&services).await.unwrap();
        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.level, Level::Ticket);
    }
}

// Integration tests are in tests/ directory and use TestContext
// These unit tests only verify the parsing functions
