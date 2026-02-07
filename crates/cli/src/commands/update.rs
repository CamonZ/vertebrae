//! Update command for modifying existing tasks
//!
//! Implements the `vtb update` command to modify task fields including
//! title, description, priority, tags, parent relationship, and sections.

use clap::Args;
use vertebrae_core::{Priority, SectionType};
use vertebrae_core::{ServiceError, UpdateTaskOptions, VertebraeServices};

/// Update an existing task
#[derive(Debug, Args)]
pub struct UpdateCommand {
    /// Task ID to update (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("task ID"))]
    pub id: String,

    /// New title for the task
    #[arg(long)]
    pub title: Option<String>,

    /// New description for the task (use empty string "" to clear)
    #[arg(short, long)]
    pub description: Option<String>,

    /// New priority (low, medium, high, critical)
    #[arg(short, long, value_parser = parse_priority)]
    pub priority: Option<Priority>,

    /// Tag to add (can be specified multiple times)
    #[arg(long = "add-tag")]
    pub add_tags: Vec<String>,

    /// Tag to remove (can be specified multiple times)
    #[arg(long = "remove-tag")]
    pub remove_tags: Vec<String>,

    /// Parent task ID (use empty string "" to remove parent)
    #[arg(long, value_parser = crate::commands::parse_uuid_or_empty("parent ID"))]
    pub parent: Option<String>,

    /// Edit a section: <type> <ordinal> <new-content>
    /// Example: --edit-section step 0 "New step content"
    #[arg(long = "edit-section", num_args = 3, value_names = ["TYPE", "ORDINAL", "CONTENT"])]
    pub edit_section: Option<Vec<String>>,

    /// Remove a section: <type> <ordinal>
    /// Example: --remove-section step 0
    #[arg(long = "remove-section", num_args = 2, value_names = ["TYPE", "ORDINAL"])]
    pub remove_section: Option<Vec<String>>,
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

/// Parse a section type string into a SectionType enum
fn parse_section_type(s: &str) -> Result<SectionType, String> {
    match s.to_lowercase().as_str() {
        "goal" => Ok(SectionType::Goal),
        "context" => Ok(SectionType::Context),
        "current_behavior" => Ok(SectionType::CurrentBehavior),
        "desired_behavior" => Ok(SectionType::DesiredBehavior),
        "step" => Ok(SectionType::Step),
        "testing_criterion" => Ok(SectionType::TestingCriterion),
        "anti_pattern" => Ok(SectionType::AntiPattern),
        "failure_test" => Ok(SectionType::FailureTest),
        "constraint" => Ok(SectionType::Constraint),
        _ => Err(format!(
            "invalid section type '{}'. Valid types: goal, context, current_behavior, \
             desired_behavior, step, testing_criterion, anti_pattern, failure_test, constraint",
            s
        )),
    }
}

impl UpdateCommand {
    /// Execute the update command.
    ///
    /// Builds an UpdateTaskOptions from CLI arguments and uses the service
    /// layer to apply updates. Section edits and removals are also performed
    /// via the service layer.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The task with the given ID does not exist
    /// - The parent task doesn't exist (if specified)
    /// - Attempting to set self as parent
    /// - Service operations fail
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        // Normalize ID to lowercase for case-insensitive lookup
        let id = self.id.to_lowercase();

        // Verify task exists
        if !services.tasks().task_exists(&id).await? {
            return Err(ServiceError::task_not_found(&id));
        }

        // Check if any updates were specified
        if !self.has_updates() {
            return Ok(id);
        }

        // Validate parent if specified (for field/tag updates)
        if let Some(parent_id) = &self.parent
            && !parent_id.is_empty()
        {
            let parent_id_lower = parent_id.to_lowercase();

            // Check for self-parent
            if parent_id_lower == id {
                return Err(ServiceError::validation_failed(
                    "Cannot set task as its own parent",
                ));
            }

            // Check parent exists
            if !services.tasks().task_exists(&parent_id_lower).await? {
                return Err(ServiceError::parent_not_found(&parent_id_lower));
            }
        }

        // Build UpdateTaskOptions from CLI arguments
        let mut options = UpdateTaskOptions::new();

        if let Some(title) = &self.title {
            options = options.with_title(title.clone());
        }

        if let Some(description) = &self.description {
            if description.is_empty() {
                options = options.clear_description();
            } else {
                options = options.with_description(description.clone());
            }
        }

        if let Some(priority) = &self.priority {
            options = options.with_priority(priority.clone());
        }

        // Add tags
        for tag in &self.add_tags {
            options = options.add_tag(tag.clone());
        }

        // Remove tags
        for tag in &self.remove_tags {
            options = options.remove_tag(tag.clone());
        }

        // Handle parent
        if let Some(parent_id) = &self.parent {
            if parent_id.is_empty() {
                options = options.clear_parent();
            } else {
                options = options.with_parent(parent_id.to_lowercase());
            }
        }

        // Apply all field/tag/parent updates via service layer
        services.tasks().update_task(&id, options).await?;

        // Handle section edits via service layer
        if let Some(args) = &self.edit_section {
            if args.len() != 3 {
                return Err(ServiceError::validation_failed(
                    "edit-section requires: <type> <ordinal> <content>",
                ));
            }

            let section_type =
                parse_section_type(&args[0]).map_err(ServiceError::validation_failed)?;

            let ordinal: u32 = args[1].parse().map_err(|_| {
                ServiceError::validation_failed(format!(
                    "invalid ordinal '{}': expected a number",
                    args[1]
                ))
            })?;

            let new_content = &args[2];
            services
                .tasks()
                .edit_section_by_ordinal(&id, section_type, ordinal, new_content)
                .await?;
        }

        // Handle section removals via service layer
        if let Some(args) = &self.remove_section {
            if args.len() != 2 {
                return Err(ServiceError::validation_failed(
                    "remove-section requires: <type> <ordinal>",
                ));
            }

            let section_type =
                parse_section_type(&args[0]).map_err(ServiceError::validation_failed)?;

            let ordinal: u32 = args[1].parse().map_err(|_| {
                ServiceError::validation_failed(format!(
                    "invalid ordinal '{}': expected a number",
                    args[1]
                ))
            })?;

            services
                .tasks()
                .remove_section_by_ordinal(&id, section_type, ordinal)
                .await?;
        }

        Ok(id)
    }

    /// Check if any updates were specified.
    fn has_updates(&self) -> bool {
        self.title.is_some()
            || self.description.is_some()
            || self.priority.is_some()
            || !self.add_tags.is_empty()
            || !self.remove_tags.is_empty()
            || self.parent.is_some()
            || self.edit_section.is_some()
            || self.remove_section.is_some()
    }
}
