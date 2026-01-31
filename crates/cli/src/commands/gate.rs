//! Gate commands for managing validation gates
//!
//! Implements the `vtb gate` subcommand group for creating and managing validation gates.

use clap::{Args, Subcommand, ValueEnum};
use vertebrae_core::{
    AgentConfig, ValidationGate, ValidationGateType, ValidationGateUpdate, ValidationMechanism,
};
use vertebrae_core::{ServiceError, VertebraeServices};

/// Gate management commands
#[derive(Debug, Subcommand)]
pub enum GateCommand {
    /// Create a new validation gate
    Create(GateCreateCommand),
    /// List all validation gates
    List(GateListCommand),
    /// Show details of a specific gate
    Show(GateShowCommand),
    /// Update a gate's properties
    Update(GateUpdateCommand),
    /// Delete a gate
    Delete(GateDeleteCommand),
}

impl GateCommand {
    /// Execute the gate subcommand.
    ///
    /// # Arguments
    ///
    /// * `services` - Reference to the vertebrae services
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let gate_service = services.gates();
        match self {
            GateCommand::Create(cmd) => cmd.execute(gate_service).await,
            GateCommand::List(cmd) => cmd.execute(gate_service).await,
            GateCommand::Show(cmd) => cmd.execute(gate_service).await,
            GateCommand::Update(cmd) => cmd.execute(gate_service).await,
            GateCommand::Delete(cmd) => cmd.execute(gate_service).await,
        }
    }
}

/// Gate type for CLI parsing
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum GateTypeArg {
    /// Run a shell command and check exit code (0 = pass)
    #[value(name = "command")]
    CommandExecution,
    /// Use an LLM agent to classify the result as pass/fail
    #[value(name = "agent")]
    AgentClassification,
    /// Require manual human approval
    #[value(name = "manual")]
    ManualApproval,
    /// Combine multiple gates with a mechanism
    #[value(name = "composite")]
    Composite,
}

impl From<GateTypeArg> for ValidationGateType {
    fn from(arg: GateTypeArg) -> Self {
        match arg {
            GateTypeArg::CommandExecution => ValidationGateType::CommandExecution,
            GateTypeArg::AgentClassification => ValidationGateType::AgentClassification,
            GateTypeArg::ManualApproval => ValidationGateType::ManualApproval,
            GateTypeArg::Composite => ValidationGateType::Composite,
        }
    }
}

/// Mechanism type for CLI parsing
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum MechanismArg {
    /// All gates must pass
    #[value(name = "all")]
    AllMustPass,
    /// At least one gate must pass
    #[value(name = "any")]
    AnyMustPass,
    /// Weighted voting with pass threshold
    #[value(name = "weighted")]
    Weighted,
}

impl From<MechanismArg> for ValidationMechanism {
    fn from(arg: MechanismArg) -> Self {
        match arg {
            MechanismArg::AllMustPass => ValidationMechanism::AllMustPass,
            MechanismArg::AnyMustPass => ValidationMechanism::AnyMustPass,
            MechanismArg::Weighted => ValidationMechanism::Weighted,
        }
    }
}

/// Create a new validation gate
#[derive(Debug, Args)]
pub struct GateCreateCommand {
    /// Name of the gate
    #[arg(required = true)]
    pub name: String,

    /// Type of validation gate
    #[arg(long, short = 't', value_enum, required = true)]
    pub gate_type: GateTypeArg,

    /// Optional gate ID (auto-generated if not provided)
    #[arg(long)]
    pub id: Option<String>,

    /// Description of the gate
    #[arg(long, short)]
    pub description: Option<String>,

    /// Command to run (for command type)
    #[arg(long, short = 'c')]
    pub command: Option<String>,

    /// Timeout in seconds (for command type, default: 30)
    #[arg(long, default_value = "30")]
    pub timeout: u32,

    /// Model to use (for agent type)
    #[arg(long, short = 'm')]
    pub model: Option<String>,

    /// Classification prompt (for agent type)
    #[arg(long, short = 'p')]
    pub prompt: Option<String>,

    /// Validation mechanism (for composite type)
    #[arg(long, value_enum)]
    pub mechanism: Option<MechanismArg>,

    /// Child gate IDs (for composite type, can be specified multiple times)
    #[arg(long = "child")]
    pub children: Vec<String>,

    /// Pass threshold for weighted mechanism (0.0-1.0)
    #[arg(long)]
    pub threshold: Option<f64>,
}

impl GateCreateCommand {
    /// Execute the create gate command.
    pub async fn execute(
        &self,
        gate_service: &dyn vertebrae_core::GateService,
    ) -> Result<String, ServiceError> {
        // Build the gate based on type
        let mut gate = match self.gate_type {
            GateTypeArg::CommandExecution => {
                let cmd = self.command.as_ref().ok_or_else(|| {
                    ServiceError::validation_failed(
                        "Command type requires --command/-c".to_string(),
                    )
                })?;
                ValidationGate::command_execution(&self.name, cmd)
                    .with_timeout_seconds(self.timeout)
            }
            GateTypeArg::AgentClassification => {
                let prompt = self.prompt.as_ref().ok_or_else(|| {
                    ServiceError::validation_failed("Agent type requires --prompt/-p".to_string())
                })?;
                let model = self.model.as_deref().unwrap_or("sonnet");
                let config = AgentConfig::new().with_model(model);
                ValidationGate::agent_classification(&self.name, prompt, config)
            }
            GateTypeArg::ManualApproval => ValidationGate::manual_approval(&self.name),
            GateTypeArg::Composite => {
                let mech = self.mechanism.ok_or_else(|| {
                    ServiceError::validation_failed(
                        "Composite type requires --mechanism".to_string(),
                    )
                })?;
                if self.children.is_empty() {
                    return Err(ServiceError::validation_failed(
                        "Composite type requires at least one --child".to_string(),
                    ));
                }
                let mut gate = ValidationGate::composite(&self.name, mech.into());
                for child_id in &self.children {
                    gate = gate.with_child_gate(child_id.to_lowercase());
                }
                if let Some(threshold) = self.threshold {
                    gate = gate.with_pass_threshold(threshold);
                }
                gate
            }
        };

        // Add optional description
        if let Some(desc) = &self.description {
            gate = gate.with_description(desc);
        }

        // Create the gate
        let created_id = if let Some(id) = &self.id {
            gate_service
                .create_gate_with_id(&id.to_lowercase(), &gate)
                .await?
        } else {
            gate_service.create_gate(&gate).await?
        };

        Ok(format!("Created validation gate: {}", created_id))
    }
}

/// List all validation gates
#[derive(Debug, Args)]
pub struct GateListCommand {
    /// Filter by gate type
    #[arg(long, short = 't', value_enum)]
    pub gate_type: Option<GateTypeArg>,
}

impl GateListCommand {
    /// Execute the list gates command.
    pub async fn execute(
        &self,
        gate_service: &dyn vertebrae_core::GateService,
    ) -> Result<String, ServiceError> {
        let gates = if let Some(gate_type) = self.gate_type {
            gate_service.list_gates_by_type(gate_type.into()).await?
        } else {
            gate_service.list_gates().await?
        };

        if gates.is_empty() {
            return Ok("No validation gates found".to_string());
        }

        let output = gates
            .iter()
            .map(|g| {
                let id = g.id.as_deref().unwrap_or("?");
                let desc = g
                    .description
                    .as_deref()
                    .map(|d| format!(" - {}", d))
                    .unwrap_or_default();
                format!("{:12} {:20} [{}]{}", id, g.name, g.gate_type, desc)
            })
            .collect::<Vec<_>>()
            .join("\n");

        Ok(format!("Validation Gates:\n{}", output))
    }
}

/// Show details of a specific gate
#[derive(Debug, Args)]
pub struct GateShowCommand {
    /// Gate ID to show (case-insensitive)
    #[arg(required = true)]
    pub id: String,
}

impl GateShowCommand {
    /// Execute the show gate command.
    pub async fn execute(
        &self,
        gate_service: &dyn vertebrae_core::GateService,
    ) -> Result<String, ServiceError> {
        let gate = gate_service.get_gate(&self.id).await?;

        match gate {
            Some(g) => {
                let id = g.id.as_deref().unwrap_or("?");

                let mut details = vec![
                    format!("Gate: {} - {}", id, g.name),
                    "============================================================".to_string(),
                    format!("Type:          {}", g.gate_type),
                ];

                if let Some(desc) = &g.description {
                    details.push(format!("Description:   {}", desc));
                }

                // Type-specific details
                match g.gate_type {
                    ValidationGateType::CommandExecution => {
                        if let Some(cmd) = &g.command {
                            details.push(format!("Command:       {}", cmd));
                        }
                        if let Some(timeout) = g.timeout_seconds {
                            details.push(format!("Timeout:       {}s", timeout));
                        }
                    }
                    ValidationGateType::AgentClassification => {
                        if let Some(prompt) = &g.classification_prompt {
                            details.push(format!("Prompt:        {}", prompt));
                        }
                        if let Some(config) = &g.agent_config
                            && let Some(model) = &config.model
                        {
                            details.push(format!("Model:         {}", model));
                        }
                    }
                    ValidationGateType::Composite => {
                        if let Some(mech) = &g.mechanism {
                            details.push(format!("Mechanism:     {}", mech));
                        }
                        if !g.child_gates.is_empty() {
                            let children: Vec<String> =
                                g.child_gates.iter().map(|t| t.to_string()).collect();
                            details.push(format!("Child Gates:   {}", children.join(", ")));
                        }
                        if let Some(threshold) = g.pass_threshold {
                            details.push(format!("Threshold:     {:.1}%", threshold * 100.0));
                        }
                    }
                    ValidationGateType::ManualApproval => {
                        // No additional details
                    }
                }

                // Timestamps
                details.push(format!(
                    "Created:       {}",
                    g.created_at
                        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| "-".to_string())
                ));
                details.push(format!(
                    "Updated:       {}",
                    g.updated_at
                        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                        .unwrap_or_else(|| "-".to_string())
                ));

                Ok(details.join("\n"))
            }
            None => Err(ServiceError::validation_failed(format!(
                "Gate not found: {}",
                self.id
            ))),
        }
    }
}

/// Update a gate's properties
#[derive(Debug, Args)]
pub struct GateUpdateCommand {
    /// Gate ID to update (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// New name for the gate
    #[arg(long)]
    pub name: Option<String>,

    /// New description
    #[arg(long, short)]
    pub description: Option<String>,

    /// New command (for command type)
    #[arg(long, short = 'c')]
    pub command: Option<String>,

    /// New timeout in seconds
    #[arg(long)]
    pub timeout: Option<u32>,

    /// New classification prompt (for agent type)
    #[arg(long, short = 'p')]
    pub prompt: Option<String>,

    /// New mechanism (for composite type)
    #[arg(long, value_enum)]
    pub mechanism: Option<MechanismArg>,

    /// New pass threshold (for weighted mechanism)
    #[arg(long)]
    pub threshold: Option<f64>,
}

impl GateUpdateCommand {
    /// Execute the update gate command.
    pub async fn execute(
        &self,
        gate_service: &dyn vertebrae_core::GateService,
    ) -> Result<String, ServiceError> {
        // Check if gate exists
        let existing = gate_service.get_gate(&self.id).await?;

        if existing.is_none() {
            return Err(ServiceError::validation_failed(format!(
                "Gate not found: {}",
                self.id
            )));
        }

        // Build the update
        let mut updates = ValidationGateUpdate::new();

        if let Some(name) = &self.name {
            updates = updates.with_name(name);
        }

        if let Some(desc) = &self.description {
            updates = updates.with_description(desc);
        }

        if let Some(cmd) = &self.command {
            updates = updates.with_command(cmd);
        }

        if let Some(timeout) = self.timeout {
            updates = updates.with_timeout_seconds(timeout);
        }

        if let Some(prompt) = &self.prompt {
            updates = updates.with_classification_prompt(prompt);
        }

        if let Some(mech) = self.mechanism {
            updates = updates.with_mechanism(mech.into());
        }

        if let Some(threshold) = self.threshold {
            updates = updates.with_pass_threshold(threshold);
        }

        gate_service.update_gate(&self.id, &updates).await?;

        Ok(format!("Updated gate: {}", self.id))
    }
}

/// Delete a gate
#[derive(Debug, Args)]
pub struct GateDeleteCommand {
    /// Gate ID to delete (case-insensitive)
    #[arg(required = true)]
    pub id: String,

    /// Force deletion without confirmation
    #[arg(long, short)]
    pub force: bool,
}

impl GateDeleteCommand {
    /// Execute the delete gate command.
    pub async fn execute(
        &self,
        gate_service: &dyn vertebrae_core::GateService,
    ) -> Result<String, ServiceError> {
        // Check if gate exists
        let existing = gate_service.get_gate(&self.id).await?;

        if existing.is_none() {
            return Err(ServiceError::validation_failed(format!(
                "Gate not found: {}",
                self.id
            )));
        }

        // Delete the gate
        gate_service.delete_gate(&self.id).await?;

        Ok(format!("Deleted gate: {}", self.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// Test struct to parse gate commands
    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        command: GateCommand,
    }

    #[test]
    fn test_gate_create_command_parses() {
        let cli = TestCli::try_parse_from(["test", "create", "Test Gate", "-t", "manual"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            GateCommand::Create(cmd) => {
                assert_eq!(cmd.name, "Test Gate");
            }
            _ => panic!("Expected Create command"),
        }
    }

    #[test]
    fn test_gate_create_command_type() {
        let cli = TestCli::try_parse_from([
            "test",
            "create",
            "Runner",
            "-t",
            "command",
            "-c",
            "cargo test",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            GateCommand::Create(cmd) => {
                assert!(matches!(cmd.gate_type, GateTypeArg::CommandExecution));
                assert_eq!(cmd.command, Some("cargo test".to_string()));
            }
            _ => panic!("Expected Create command"),
        }
    }

    #[test]
    fn test_gate_list_parses() {
        let cli = TestCli::try_parse_from(["test", "list"]);
        assert!(cli.is_ok());
    }

    #[test]
    fn test_gate_list_with_type_filter() {
        let cli = TestCli::try_parse_from(["test", "list", "-t", "manual"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            GateCommand::List(cmd) => {
                assert!(cmd.gate_type.is_some());
            }
            _ => panic!("Expected List command"),
        }
    }

    #[test]
    fn test_gate_show_parses() {
        let cli = TestCli::try_parse_from(["test", "show", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            GateCommand::Show(cmd) => {
                assert_eq!(cmd.id, "abc123");
            }
            _ => panic!("Expected Show command"),
        }
    }

    #[test]
    fn test_gate_update_parses() {
        let cli = TestCli::try_parse_from(["test", "update", "abc123", "--name", "New Name"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            GateCommand::Update(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert_eq!(cmd.name, Some("New Name".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_gate_delete_parses() {
        let cli = TestCli::try_parse_from(["test", "delete", "abc123"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            GateCommand::Delete(cmd) => {
                assert_eq!(cmd.id, "abc123");
                assert!(!cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }

    #[test]
    fn test_gate_delete_with_force() {
        let cli = TestCli::try_parse_from(["test", "delete", "abc123", "-f"]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            GateCommand::Delete(cmd) => {
                assert!(cmd.force);
            }
            _ => panic!("Expected Delete command"),
        }
    }
}
