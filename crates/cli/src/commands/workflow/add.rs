//! Workflow add command

use clap::Args;
use vertebrae_core::AgentConfig;
use vertebrae_core::{CreateWorkflowOptions, ServiceError, WorkflowService, WorkflowStepInput};

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

    /// Automatically advance to the next step on successful completion
    #[arg(long)]
    pub auto_advance: bool,

    /// Display order for sorting workflows (lower values appear first)
    #[arg(short, long, default_value = "0")]
    pub order: i32,

    /// Kanban column for board placement
    #[arg(long)]
    pub kanban_column: Option<String>,

    /// Mark this workflow as the default for new tasks
    #[arg(long)]
    pub default: bool,
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
pub fn parse_step(s: &str) -> Result<ParsedStep, String> {
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
        let mut options = CreateWorkflowOptions::new(&self.name, steps)
            .with_auto_advance(self.auto_advance)
            .with_is_default(self.default)
            .with_order(self.order);

        if let Some(description) = &self.description {
            options = options.with_description(description);
        }

        if let Some(kanban_column) = &self.kanban_column {
            options = options.with_kanban_column(kanban_column);
        }

        // Create the workflow
        let id = service.create_workflow(options).await?;

        Ok(format!("Created workflow: {}", id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_step_valid() {
        let step = parse_step("review:sonnet").unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_config.model, Some("sonnet".to_string()));
    }

    #[test]
    fn test_parse_step_with_spaces() {
        let step = parse_step("  review  :  sonnet  ").unwrap();
        assert_eq!(step.name, "review");
        assert_eq!(step.agent_config.model, Some("sonnet".to_string()));
    }

    #[test]
    fn test_parse_step_with_multiple_colons() {
        // Should only split on first colon
        let step = parse_step("step:model:extra").unwrap();
        assert_eq!(step.name, "step");
        assert_eq!(step.agent_config.model, Some("model:extra".to_string()));
    }

    #[test]
    fn test_parse_step_missing_colon() {
        let result = parse_step("invalid");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid step format"));
    }

    #[test]
    fn test_parse_step_empty_name() {
        let result = parse_step(":model");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("step name cannot be empty"));
    }

    #[test]
    fn test_parse_step_empty_model() {
        let result = parse_step("step:");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("model cannot be empty"));
    }

    #[test]
    fn test_parse_step_whitespace_only_name() {
        let result = parse_step("   :model");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_step_whitespace_only_model() {
        let result = parse_step("step:   ");
        assert!(result.is_err());
    }
}
