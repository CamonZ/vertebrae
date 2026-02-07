//! Step commands for managing first-class workflow steps
//!
//! Implements the `vtb step` subcommand group for creating and managing steps.

use clap::{Args, Subcommand};
use vertebrae_core::{AgentConfig, ServiceError, Step, StepService, StepUpdate, VertebraeServices};

/// Step management commands
#[derive(Debug, Subcommand)]
pub enum StepCommand {
    /// Create a new step for a workflow
    Add(StepAddCommand),
    /// List all steps for a workflow
    List(StepListCommand),
    /// Show details of a specific step
    Show(StepShowCommand),
    /// Update a step's properties
    Update(StepUpdateCommand),
    /// Delete a step
    Delete(StepDeleteCommand),
}

impl StepCommand {
    /// Execute the step subcommand.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the services container
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let step_service = services.steps();
        match self {
            StepCommand::Add(cmd) => cmd.execute(step_service).await,
            StepCommand::List(cmd) => cmd.execute(step_service).await,
            StepCommand::Show(cmd) => cmd.execute(step_service).await,
            StepCommand::Update(cmd) => cmd.execute(step_service).await,
            StepCommand::Delete(cmd) => cmd.execute(step_service).await,
        }
    }
}

/// Create a new step for a workflow
#[derive(Debug, Args)]
pub struct StepAddCommand {
    /// Name of the step
    #[arg(required = true)]
    pub name: String,

    /// ID of the workflow this step belongs to
    #[arg(long, short = 'w', required = true, value_parser = crate::commands::parse_uuid("workflow ID"))]
    pub workflow: String,

    /// Optional step ID (auto-generated if not provided)
    #[arg(long, value_parser = crate::commands::parse_uuid("step ID"))]
    pub id: Option<String>,

    /// Goal describing what this step should accomplish
    #[arg(long, short)]
    pub goal: Option<String>,

    /// Paths to .claude/agents/ files (can be specified multiple times)
    #[arg(long, short = 'a')]
    pub agent: Vec<String>,

    /// Skill names available for this step (can be specified multiple times)
    #[arg(long, short = 's')]
    pub skill: Vec<String>,

    /// Model to use for this step's agent (legacy, use --agent instead)
    #[arg(long, short)]
    pub model: Option<String>,

    /// Step order (0-indexed, defaults to 0)
    #[arg(long, short, default_value = "0")]
    pub order: i32,

    /// Mark this step as a final step
    #[arg(long)]
    pub r#final: bool,

    /// IDs of steps this step can transition to (can be specified multiple times)
    #[arg(long = "transition-to", short = 't', value_parser = crate::commands::parse_uuid("transition target ID"))]
    pub transitions_to: Vec<String>,
}

impl StepAddCommand {
    /// Execute the add step command.
    ///
    /// Creates a new step with the specified options and stores it in the database.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the step service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The name is empty
    /// - The workflow doesn't exist
    /// - Service operations fail
    pub async fn execute(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        // Build the workflow ID string
        let workflow_id = self.workflow.to_lowercase();

        // Build agent config (legacy support)
        let mut agent_config = AgentConfig::new();
        if let Some(model) = &self.model {
            agent_config = agent_config.with_model(model);
        }

        // Build transitions_to list (string IDs)
        let transitions_to: Vec<String> = self
            .transitions_to
            .iter()
            .map(|id| id.to_lowercase())
            .collect();

        // Build the step
        let mut step = Step::new(&self.name, workflow_id)
            .with_agent_config(agent_config)
            .with_order(self.order)
            .with_is_final(self.r#final);

        // Set goal if provided
        if let Some(goal) = &self.goal {
            step = step.with_goal(goal);
        }

        // Set agents if provided
        if !self.agent.is_empty() {
            step = step.with_agents(self.agent.clone());
        }

        // Set skills if provided
        if !self.skill.is_empty() {
            step = step.with_skills(self.skill.clone());
        }

        // Add transitions
        for transition in transitions_to {
            step = step.with_transition(transition);
        }

        // Create the step
        let created = if let Some(id) = &self.id {
            service
                .create_step_with_id(&id.to_lowercase(), &step)
                .await?
        } else {
            service.create_step(&step).await?
        };

        let step_id = created
            .id
            .as_ref()
            .map(|t| t.to_string())
            .unwrap_or_else(|| "unknown".to_string());

        Ok(format!("Created step: {}", step_id))
    }
}

/// List all steps for a workflow
#[derive(Debug, Args)]
pub struct StepListCommand {
    /// ID of the workflow to list steps for
    #[arg(required = true, value_parser = crate::commands::parse_uuid("workflow ID"))]
    pub workflow: String,
}

impl StepListCommand {
    /// Execute the list steps command.
    ///
    /// Fetches all steps for the given workflow from the database and returns a formatted list.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the step service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        let workflow_id = self.workflow.to_lowercase();
        let steps = service.list_steps_for_workflow(&workflow_id).await?;

        if steps.is_empty() {
            return Ok(format!("No steps found for workflow '{}'", self.workflow));
        }

        let output = steps
            .iter()
            .map(|s| {
                let id =
                    s.id.as_ref()
                        .map(|t| t.to_string())
                        .unwrap_or_else(|| "?".to_string());
                let model = s.agent_config.model.as_deref().unwrap_or("default");
                let final_marker = if s.is_final { " [FINAL]" } else { "" };
                format!(
                    "{}. {} (id: {}, model: {}){}",
                    s.order + 1,
                    s.name,
                    id,
                    model,
                    final_marker
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        Ok(format!(
            "Steps for workflow '{}':\n{}",
            self.workflow, output
        ))
    }
}

/// Show details of a specific step
#[derive(Debug, Args)]
pub struct StepShowCommand {
    /// Step ID to show (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("step ID"))]
    pub id: String,
}

impl StepShowCommand {
    /// Execute the show step command.
    ///
    /// Fetches the step with the given ID and returns detailed information.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the step service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError::NotFound` if the step doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        let step = service.get_step(&self.id.to_lowercase()).await?;

        match step {
            Some(s) => {
                let id =
                    s.id.as_ref()
                        .map(|t| t.to_string())
                        .unwrap_or_else(|| "?".to_string());
                let workflow_id = s.workflow_id.to_string();
                let model = s.agent_config.model.as_deref().unwrap_or("default");

                let goal = s.goal.as_deref().unwrap_or("(none)");

                let agents = if s.agents.is_empty() {
                    "(none)".to_string()
                } else {
                    s.agents.join(", ")
                };

                let skills = if s.skills.is_empty() {
                    "(none)".to_string()
                } else {
                    s.skills.join(", ")
                };

                let transitions = if s.transitions_to.is_empty() {
                    "(none)".to_string()
                } else {
                    s.transitions_to
                        .iter()
                        .map(|t| t.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                };

                let output = format!(
                    r#"Step: {} - {}
============================================================

Workflow:      {}
Order:         {}
Goal:          {}
Agents:        {}
Skills:        {}
Model:         {}
Is Final:      {}
Transitions:   {}
Created:       {}
Updated:       {}"#,
                    id,
                    s.name,
                    workflow_id,
                    s.order,
                    goal,
                    agents,
                    skills,
                    model,
                    if s.is_final { "Yes" } else { "No" },
                    transitions,
                    s.created_at
                        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| "-".to_string()),
                    s.updated_at
                        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| "-".to_string()),
                );

                Ok(output)
            }
            None => Err(ServiceError::validation_failed(format!(
                "Step not found: {}",
                self.id
            ))),
        }
    }
}

/// Update a step's properties
#[derive(Debug, Args)]
pub struct StepUpdateCommand {
    /// Step ID to update (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("step ID"))]
    pub id: String,

    /// New name for the step
    #[arg(long)]
    pub name: Option<String>,

    /// New goal for the step
    #[arg(long, short)]
    pub goal: Option<String>,

    /// New agents list (replaces existing)
    #[arg(long, short = 'a')]
    pub agent: Vec<String>,

    /// Clear all agents
    #[arg(long)]
    pub clear_agents: bool,

    /// New skills list (replaces existing)
    #[arg(long, short = 's')]
    pub skill: Vec<String>,

    /// Clear all skills
    #[arg(long)]
    pub clear_skills: bool,

    /// New model for the step's agent (legacy)
    #[arg(long, short)]
    pub model: Option<String>,

    /// New order for the step
    #[arg(long, short)]
    pub order: Option<i32>,

    /// Set whether this step is a final step
    #[arg(long)]
    pub r#final: Option<bool>,

    /// New transitions_to list (replaces existing)
    #[arg(long = "transition-to", short = 't', value_parser = crate::commands::parse_uuid("transition target ID"))]
    pub transitions_to: Vec<String>,

    /// Clear all transitions
    #[arg(long)]
    pub clear_transitions: bool,
}

impl StepUpdateCommand {
    /// Execute the update step command.
    ///
    /// Updates the step with the specified ID.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the step service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the step doesn't exist or service operations fail.
    pub async fn execute(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        // Check if step exists
        let existing = service.get_step(&self.id.to_lowercase()).await?;
        if existing.is_none() {
            return Err(ServiceError::validation_failed(format!(
                "Step not found: {}",
                self.id
            )));
        }

        // Build the update
        let mut updates = StepUpdate::new();

        if let Some(name) = &self.name {
            updates = updates.with_name(name);
        }

        if let Some(goal) = &self.goal {
            updates = updates.with_goal(goal);
        }

        if self.clear_agents {
            updates = updates.with_agents(vec![]);
        } else if !self.agent.is_empty() {
            updates = updates.with_agents(self.agent.clone());
        }

        if self.clear_skills {
            updates = updates.with_skills(vec![]);
        } else if !self.skill.is_empty() {
            updates = updates.with_skills(self.skill.clone());
        }

        if let Some(order) = self.order {
            updates = updates.with_order(order);
        }

        if let Some(is_final) = self.r#final {
            updates = updates.with_is_final(is_final);
        }

        if let Some(model) = &self.model {
            let agent_config = AgentConfig::new().with_model(model);
            let config_value = serde_json::to_value(&agent_config).map_err(|e| {
                ServiceError::validation_failed(format!("Invalid agent config: {}", e))
            })?;
            updates = updates.with_agent_config(config_value);
        }

        if self.clear_transitions {
            updates = updates.with_transitions_to(vec![]);
        } else if !self.transitions_to.is_empty() {
            let transitions: Vec<String> = self
                .transitions_to
                .iter()
                .map(|id| id.to_lowercase())
                .collect();
            updates = updates.with_transitions_to(transitions);
        }

        service
            .update_step(&self.id.to_lowercase(), &updates)
            .await?;

        Ok(format!("Updated step: {}", self.id))
    }
}

/// Delete a step
#[derive(Debug, Args)]
pub struct StepDeleteCommand {
    /// Step ID to delete (case-insensitive)
    #[arg(required = true, value_parser = crate::commands::parse_uuid("step ID"))]
    pub id: String,

    /// Force deletion without confirmation
    #[arg(long, short)]
    pub force: bool,
}

impl StepDeleteCommand {
    /// Execute the delete step command.
    ///
    /// Deletes the step with the specified ID.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the step service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the step doesn't exist or service operations fail.
    pub async fn execute(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        // Check if step exists
        let existing = service.get_step(&self.id.to_lowercase()).await?;
        if existing.is_none() {
            return Err(ServiceError::validation_failed(format!(
                "Step not found: {}",
                self.id
            )));
        }

        service.delete_step(&self.id.to_lowercase()).await?;

        Ok(format!("Deleted step: {}", self.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Test struct to parse commands
    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: StepCommand,
    }

    #[test]
    fn test_step_add_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Review",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert_eq!(cmd.name, "Review");
                assert_eq!(cmd.workflow, "a1b2c3d4-0000-4000-8000-000000000006");
                assert_eq!(cmd.order, 0);
                assert!(!cmd.r#final);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_all_options() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Deploy",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000007",
            "--id",
            "a1b2c3d4-0000-4000-8000-000000000008",
            "--model",
            "sonnet",
            "--order",
            "3",
            "--final",
            "--transition-to",
            "a1b2c3d4-0000-4000-8000-000000000009",
            "--transition-to",
            "a1b2c3d4-0000-4000-8000-00000000000a",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert_eq!(cmd.name, "Deploy");
                assert_eq!(cmd.workflow, "a1b2c3d4-0000-4000-8000-000000000007");
                assert_eq!(
                    cmd.id,
                    Some("a1b2c3d4-0000-4000-8000-000000000008".to_string())
                );
                assert_eq!(cmd.model, Some("sonnet".to_string()));
                assert_eq!(cmd.order, 3);
                assert!(cmd.r#final);
                assert_eq!(
                    cmd.transitions_to,
                    vec![
                        "a1b2c3d4-0000-4000-8000-000000000009",
                        "a1b2c3d4-0000-4000-8000-00000000000a"
                    ]
                );
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_orchestration_fields() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Code Review",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--goal",
            "Review code for best practices",
            "--agent",
            ".claude/agents/reviewer.md",
            "--agent",
            ".claude/agents/linter.md",
            "--skill",
            "code-review",
            "--skill",
            "lint",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert_eq!(cmd.name, "Code Review");
                assert_eq!(cmd.goal, Some("Review code for best practices".to_string()));
                assert_eq!(
                    cmd.agent,
                    vec![".claude/agents/reviewer.md", ".claude/agents/linter.md"]
                );
                assert_eq!(cmd.skill, vec!["code-review", "lint"]);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_requires_name() {
        let result = TestCli::try_parse_from([
            "test",
            "add",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_step_add_requires_workflow() {
        let result = TestCli::try_parse_from(["test", "add", "Review"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_step_list_parses() {
        let cli = TestCli::try_parse_from(["test", "list", "a1b2c3d4-0000-4000-8000-000000000006"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::List(cmd) => {
                assert_eq!(cmd.workflow, "a1b2c3d4-0000-4000-8000-000000000006");
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_step_list_requires_workflow() {
        let result = TestCli::try_parse_from(["test", "list"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_step_show_parses() {
        let cli = TestCli::try_parse_from(["test", "show", "a1b2c3d4-0000-4000-8000-00000000000b"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Show(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-00000000000b");
            }
            _ => panic!("Expected Show command"),
        }
    }

    #[test]
    fn test_step_show_requires_id() {
        let result = TestCli::try_parse_from(["test", "show"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_step_update_parses() {
        let cli =
            TestCli::try_parse_from(["test", "update", "a1b2c3d4-0000-4000-8000-00000000000b"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-00000000000b");
                assert!(cmd.name.is_none());
                assert!(cmd.model.is_none());
                assert!(cmd.order.is_none());
                assert!(cmd.r#final.is_none());
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_all_options() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--name",
            "Code Review",
            "--model",
            "opus",
            "--order",
            "5",
            "--final",
            "true",
            "--transition-to",
            "a1b2c3d4-0000-4000-8000-00000000000c",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-00000000000b");
                assert_eq!(cmd.name, Some("Code Review".to_string()));
                assert_eq!(cmd.model, Some("opus".to_string()));
                assert_eq!(cmd.order, Some(5));
                assert_eq!(cmd.r#final, Some(true));
                assert_eq!(
                    cmd.transitions_to,
                    vec!["a1b2c3d4-0000-4000-8000-00000000000c"]
                );
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_clear_transitions() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--clear-transitions",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert!(cmd.clear_transitions);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_orchestration_fields() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--goal",
            "Updated goal",
            "--agent",
            ".claude/agents/new-agent.md",
            "--skill",
            "new-skill",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.goal, Some("Updated goal".to_string()));
                assert_eq!(cmd.agent, vec![".claude/agents/new-agent.md"]);
                assert_eq!(cmd.skill, vec!["new-skill"]);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_clear_agents_and_skills() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--clear-agents",
            "--clear-skills",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert!(cmd.clear_agents);
                assert!(cmd.clear_skills);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_delete_parses() {
        let cli =
            TestCli::try_parse_from(["test", "delete", "a1b2c3d4-0000-4000-8000-00000000000b"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Delete(cmd) => {
                assert_eq!(cmd.id, "a1b2c3d4-0000-4000-8000-00000000000b");
                assert!(!cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_step_delete_with_force() {
        let cli = TestCli::try_parse_from([
            "test",
            "delete",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--force",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Delete(cmd) => {
                assert!(cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_step_delete_requires_id() {
        let result = TestCli::try_parse_from(["test", "delete"]);
        assert!(result.is_err());
    }

    #[test]
    fn test_step_command_debug() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Test Step",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
        ])
        .unwrap();
        let debug_str = format!("{:?}", cli.command);
        assert!(
            debug_str.contains("Add") && debug_str.contains("Test Step"),
            "Debug output should contain Add variant and name field value"
        );
    }
}
