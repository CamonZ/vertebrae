//! Step commands for managing first-class workflow steps
//!
//! Implements the `vtb step` subcommand group for creating and managing steps.

use clap::{Args, Subcommand, ValueEnum};
use vertebrae_core::{
    AgentConfig, OutputVerbosity, Provider, ServiceError, SpeedTier, Step, StepService, StepType,
    StepUpdate, VertebraeServices, normalize_provider_personality,
    normalize_provider_reasoning_effort, validate_provider_model_with_codex_provider,
    validate_route_fields, validate_route_update,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum CliSpeedTier {
    Default,
    Fast,
}

impl From<CliSpeedTier> for SpeedTier {
    fn from(value: CliSpeedTier) -> Self {
        match value {
            CliSpeedTier::Default => Self::Default,
            CliSpeedTier::Fast => Self::Fast,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum CliOutputVerbosity {
    Low,
    Medium,
    High,
}

impl From<CliOutputVerbosity> for OutputVerbosity {
    fn from(value: CliOutputVerbosity) -> Self {
        match value {
            CliOutputVerbosity::Low => Self::Low,
            CliOutputVerbosity::Medium => Self::Medium,
            CliOutputVerbosity::High => Self::High,
        }
    }
}

/// CLI representation of step types, maps to `vertebrae_core::StepType`.
#[derive(Debug, Clone, ValueEnum)]
pub enum CliStepType {
    Execute,
    Evaluate,
    Route,
    #[value(name = "wait_children")]
    WaitChildren,
    #[value(name = "human_input")]
    HumanInput,
    #[value(name = "stop")]
    Stop,
    Finish,
}

impl From<CliStepType> for StepType {
    fn from(cli: CliStepType) -> Self {
        match cli {
            CliStepType::Execute => StepType::Execute,
            CliStepType::Evaluate => StepType::Evaluate,
            CliStepType::Route => StepType::Route,
            CliStepType::WaitChildren => StepType::WaitChildren,
            CliStepType::HumanInput => StepType::HumanInput,
            CliStepType::Stop => StepType::Stop,
            CliStepType::Finish => StepType::Finish,
        }
    }
}

fn validate_step_constraints(
    step_type: &StepType,
    prompt: Option<&str>,
    transitions_to: &[String],
) -> Result<(), ServiceError> {
    if matches!(step_type, StepType::Finish) && (prompt.is_some() || !transitions_to.is_empty()) {
        return Err(ServiceError::validation_failed(
            "Finish steps cannot define a prompt or outgoing transitions",
        ));
    }

    if matches!(step_type, StepType::Stop) && transitions_to.len() != 1 {
        return Err(ServiceError::validation_failed(
            "Stop steps must define exactly one outgoing transition",
        ));
    }

    Ok(())
}

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

    /// Prompt sent to the agent when executing this step
    #[arg(long)]
    pub prompt: Option<String>,

    /// Full agent config as a JSON string (e.g. '{"model":"opus","max_budget_usd":5.0}')
    #[arg(long, value_name = "JSON")]
    pub agent_config: Option<String>,

    /// Model to use for this step's agent (convenience shortcut for agent_config.model)
    #[arg(long, short)]
    pub model: Option<String>,

    /// Codex upstream model provider from ~/.codex/config.toml (alias: --codex-provider).
    ///
    /// Convenience shortcut for `agent_config.codex_model_provider`. Only
    /// valid with `--provider openai`.
    #[arg(long, alias = "codex-provider", value_name = "PROVIDER")]
    pub codex_model_provider: Option<String>,

    /// OpenAI/Codex reasoning effort (low, medium, high, xhigh).
    ///
    /// Convenience shortcut for `agent_config.reasoning_effort`. Only valid
    /// with `--provider openai`.
    #[arg(long, value_name = "EFFORT")]
    pub reasoning_effort: Option<String>,

    /// Provider serving speed preference (default or fast).
    #[arg(long, value_enum)]
    pub speed_tier: Option<CliSpeedTier>,

    /// Provider style identifier (for example friendly, pragmatic, or none).
    #[arg(long)]
    pub personality: Option<String>,

    /// Output detail level (low, medium, or high; alias: --output-verbosity).
    #[arg(long, alias = "output-verbosity", value_enum)]
    pub verbosity: Option<CliOutputVerbosity>,

    /// Built-in execution provider for this step (anthropic, openai; alias: --model-provider).
    ///
    /// Convenience shortcut for `agent_config.provider`. Use `--agent-config`
    /// JSON for any field this flag does not cover.
    #[arg(long, alias = "model-provider", value_name = "PROVIDER", value_parser = parse_provider_arg)]
    pub provider: Option<Provider>,

    /// Type of this step (execute, evaluate, route, wait_children, human_input, stop, finish)
    #[arg(long, value_enum, default_value = "execute")]
    pub step_type: CliStepType,

    /// JSON Schema describing the expected output of this step (raw JSON string)
    #[arg(long, value_name = "JSON")]
    pub output_schema: Option<String>,

    /// Orchestrator-owned persistence configuration (raw JSON string)
    #[arg(long, value_name = "JSON")]
    pub persistence_options: Option<String>,

    /// Deterministic route configuration (raw JSON string)
    #[arg(long, value_name = "JSON")]
    pub route_config: Option<String>,

    /// Step order (0-indexed, defaults to 0)
    #[arg(long, short, default_value = "0")]
    pub order: i32,

    /// IDs of steps this step can transition to (can be specified multiple times)
    #[arg(long = "transition-to", short = 't', value_parser = crate::commands::parse_uuid("transition target ID"))]
    pub transitions_to: Vec<String>,
}

fn parse_provider_arg(input: &str) -> Result<Provider, String> {
    Provider::parse(input)
}

#[derive(Debug, Clone, Copy)]
struct AgentConfigOverrides<'a> {
    provider: Option<Provider>,
    model: Option<&'a str>,
    codex_model_provider: Option<&'a str>,
    reasoning_effort: Option<&'a str>,
    speed_tier: Option<SpeedTier>,
    personality: Option<&'a str>,
    verbosity: Option<OutputVerbosity>,
}

fn build_overlayed_agent_config(
    base: AgentConfig,
    json: Option<&str>,
    overrides: AgentConfigOverrides<'_>,
) -> Result<AgentConfig, ServiceError> {
    let mut config = match json {
        Some(json_str) => serde_json::from_str::<AgentConfig>(json_str).map_err(|e| {
            ServiceError::validation_failed(format!("Invalid --agent-config JSON: {}", e))
        })?,
        None => base,
    };
    if let Some(provider) = overrides.provider {
        config = config.with_provider(provider);
        if provider != Provider::Openai && overrides.reasoning_effort.is_none() {
            config.reasoning_effort = None;
        }
    }
    if let Some(model) = overrides.model {
        config = config.with_model(model);
    }
    if let Some(codex_model_provider) = overrides.codex_model_provider {
        config = config.with_codex_model_provider(codex_model_provider);
    }
    if let Some(reasoning_effort) = overrides.reasoning_effort {
        config = config.with_reasoning_effort(reasoning_effort);
    }
    if let Some(speed_tier) = overrides.speed_tier {
        config = config.with_speed_tier(speed_tier);
    }
    if let Some(personality) = overrides.personality {
        config = config.with_personality(personality);
    }
    if let Some(verbosity) = overrides.verbosity {
        config = config.with_verbosity(verbosity);
    }
    if config.provider.is_some() || config.codex_model_provider.is_some() {
        let provider = config.provider.unwrap_or(Provider::Anthropic);
        validate_provider_model_with_codex_provider(
            provider,
            config.model.as_deref(),
            config.codex_model_provider.as_deref(),
        )
        .map_err(|e| ServiceError::validation_failed(e.to_string()))?;
    }
    if config.reasoning_effort.is_some() {
        let provider = config.provider.unwrap_or(Provider::Anthropic);
        config.reasoning_effort =
            normalize_provider_reasoning_effort(provider, config.reasoning_effort.as_deref())
                .map_err(|e| ServiceError::validation_failed(e.to_string()))?;
    }
    let provider = config.provider.unwrap_or(Provider::Anthropic);
    config.personality = normalize_provider_personality(provider, config.personality.as_deref())
        .map_err(|error| ServiceError::validation_failed(error.to_string()))?;
    if config.verbosity.is_some()
        && config.provider.unwrap_or(Provider::Anthropic) != Provider::Openai
    {
        return Err(ServiceError::validation_failed(
            "verbosity is currently supported only by the openai / Codex provider",
        ));
    }
    Ok(config)
}

impl StepAddCommand {
    pub async fn execute_result(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        let workflow_id = self.workflow.to_lowercase();

        let agent_config = build_overlayed_agent_config(
            AgentConfig::new(),
            self.agent_config.as_deref(),
            AgentConfigOverrides {
                provider: self.provider,
                model: self.model.as_deref(),
                codex_model_provider: self.codex_model_provider.as_deref(),
                reasoning_effort: self.reasoning_effort.as_deref(),
                speed_tier: self.speed_tier.map(Into::into),
                personality: self.personality.as_deref(),
                verbosity: self.verbosity.map(Into::into),
            },
        )?;

        let transitions_to: Vec<String> = self
            .transitions_to
            .iter()
            .map(|id| id.to_lowercase())
            .collect();

        let output_schema = self
            .output_schema
            .as_deref()
            .map(|json_str| {
                serde_json::from_str::<serde_json::Value>(json_str).map_err(|e| {
                    ServiceError::validation_failed(format!("Invalid --output-schema JSON: {}", e))
                })
            })
            .transpose()?;

        let persistence_options = self
            .persistence_options
            .as_deref()
            .map(|json_str| {
                serde_json::from_str::<serde_json::Value>(json_str).map_err(|e| {
                    ServiceError::validation_failed(format!(
                        "Invalid --persistence-options JSON: {}",
                        e
                    ))
                })
            })
            .transpose()?;

        let route_config = self
            .route_config
            .as_deref()
            .map(|json_str| {
                serde_json::from_str::<serde_json::Value>(json_str).map_err(|e| {
                    ServiceError::validation_failed(format!("Invalid --route-config JSON: {}", e))
                })
            })
            .transpose()?;

        let step_type: StepType = self.step_type.clone().into();
        validate_step_constraints(&step_type, self.prompt.as_deref(), &transitions_to)?;
        validate_route_fields(
            &step_type,
            self.prompt.is_some(),
            output_schema.is_some(),
            route_config.as_ref(),
        )?;

        let mut step = Step::new(&self.name, workflow_id)
            .with_agent_config(agent_config)
            .with_step_type(step_type)
            .with_order(self.order);

        if let Some(schema) = output_schema {
            step = step.with_output_schema(schema);
        }
        if let Some(options) = persistence_options {
            step = step.with_persistence_options(options);
        }
        if let Some(route_config) = route_config {
            step = step.with_route_config(route_config);
        }
        if let Some(goal) = &self.goal {
            step = step.with_goal(goal);
        }
        if let Some(prompt) = &self.prompt {
            step = step.with_prompt(prompt);
        }
        if !self.agent.is_empty() {
            step = step.with_agents(self.agent.clone());
        }
        if !self.skill.is_empty() {
            step = step.with_skills(self.skill.clone());
        }
        for transition in transitions_to {
            step = step.with_transition(transition);
        }

        let created = if let Some(id) = &self.id {
            service
                .create_step_with_id(&id.to_lowercase(), &step)
                .await?
        } else {
            service.create_step(&step).await?
        };

        Ok(created
            .id
            .as_ref()
            .map(|t| t.to_string())
            .unwrap_or_else(|| "unknown".to_string()))
    }

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
        let step_id = self.execute_result(service).await?;
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
    /// Fetch steps for the workflow, returning the raw Step objects.
    pub async fn list_steps(&self, service: &dyn StepService) -> Result<Vec<Step>, ServiceError> {
        let workflow_id = self.workflow.to_lowercase();
        service.list_steps_for_workflow(&workflow_id).await
    }

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
        let steps = self.list_steps(service).await?;

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
                let step_type = s.step_type.to_string();
                format!(
                    "{}. {} (id: {}, type: {}, model: {})",
                    s.order + 1,
                    s.name,
                    id,
                    step_type,
                    model
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
    /// Fetch the step for structured output.
    pub async fn get_step(&self, service: &dyn StepService) -> Result<Step, ServiceError> {
        service
            .get_step(&self.id.to_lowercase())
            .await?
            .ok_or_else(|| ServiceError::validation_failed(format!("Step not found: {}", self.id)))
    }

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
    /// Returns `ServiceError::ValidationFailed` if the step doesn't exist.
    /// Returns `ServiceError` if service operations fail.
    pub async fn execute(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        let s = self.get_step(service).await?;
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
            s.transitions_to.join(", ")
        };

        let output_schema = s
            .output_schema
            .as_ref()
            .map(|v| serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()))
            .unwrap_or_else(|| "(none)".to_string());

        let persistence_options = s
            .persistence_options
            .as_ref()
            .map(|v| serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()))
            .unwrap_or_else(|| "(none)".to_string());

        let prompt = s.prompt.as_deref().unwrap_or("(none)");

        let route_config = s
            .route_config
            .as_ref()
            .map(|v| serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()))
            .unwrap_or_else(|| "(none)".to_string());

        let output = format!(
            r#"Step: {} - {}
============================================================

Workflow:      {}
Order:         {}
Step Type:     {}
Goal:          {}
Agents:        {}
Skills:        {}
Model:         {}
Prompt:        {}
Output Schema: {}
Persistence:    {}
Route Config:   {}
Transitions:   {}
Created:       {}
Updated:       {}"#,
            id,
            s.name,
            workflow_id,
            s.order,
            s.step_type,
            goal,
            agents,
            skills,
            model,
            prompt,
            output_schema,
            persistence_options,
            route_config,
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

    /// New prompt for the step
    #[arg(long)]
    pub prompt: Option<String>,

    /// Clear the existing prompt
    #[arg(long)]
    pub clear_prompt: bool,

    /// Full agent config as a JSON string (e.g. '{"model":"opus","max_budget_usd":5.0}')
    #[arg(long, value_name = "JSON")]
    pub agent_config: Option<String>,

    /// New model for the step's agent (convenience shortcut for agent_config.model)
    #[arg(long, short)]
    pub model: Option<String>,

    /// New Codex upstream model provider from ~/.codex/config.toml (alias: --codex-provider).
    ///
    /// Convenience shortcut for `agent_config.codex_model_provider`. Only
    /// valid when the resulting provider is OpenAI/Codex.
    #[arg(long, alias = "codex-provider", value_name = "PROVIDER")]
    pub codex_model_provider: Option<String>,

    /// New OpenAI/Codex reasoning effort (low, medium, high, xhigh).
    ///
    /// Convenience shortcut for `agent_config.reasoning_effort`. Only valid
    /// when the resulting provider is OpenAI/Codex.
    #[arg(long, value_name = "EFFORT")]
    pub reasoning_effort: Option<String>,

    /// New provider serving speed preference.
    #[arg(long, value_enum)]
    pub speed_tier: Option<CliSpeedTier>,

    /// New provider style identifier.
    #[arg(long)]
    pub personality: Option<String>,

    /// New output detail level (alias: --output-verbosity).
    #[arg(long, alias = "output-verbosity", value_enum)]
    pub verbosity: Option<CliOutputVerbosity>,

    /// Clear the speed preference.
    #[arg(long)]
    pub clear_speed_tier: bool,

    /// Clear the personality setting.
    #[arg(long)]
    pub clear_personality: bool,

    /// Clear the output verbosity setting.
    #[arg(long)]
    pub clear_verbosity: bool,

    /// New built-in execution provider for this step (anthropic, openai; alias: --model-provider).
    ///
    /// Convenience shortcut for `agent_config.provider`. Use `--agent-config`
    /// JSON for any field this flag does not cover.
    #[arg(long, alias = "model-provider", value_name = "PROVIDER", value_parser = parse_provider_arg)]
    pub provider: Option<Provider>,

    /// New step type (execute, evaluate, route, wait_children, human_input, stop, finish)
    #[arg(long, value_enum)]
    pub step_type: Option<CliStepType>,

    /// New output schema as a JSON string
    #[arg(long, value_name = "JSON")]
    pub output_schema: Option<String>,

    /// Clear the output schema
    #[arg(long)]
    pub clear_output_schema: bool,

    /// Replace the orchestrator-owned persistence configuration with JSON
    #[arg(long, value_name = "JSON")]
    pub persistence_options: Option<String>,

    /// Clear the orchestrator-owned persistence configuration
    #[arg(long)]
    pub clear_persistence_options: bool,

    /// Replace the deterministic route configuration with JSON
    #[arg(long, value_name = "JSON")]
    pub route_config: Option<String>,

    /// Clear the deterministic route configuration
    #[arg(long)]
    pub clear_route_config: bool,

    /// New order for the step
    #[arg(long, short)]
    pub order: Option<i32>,

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
        let existing = service.get_step(&self.id.to_lowercase()).await?;
        if existing.is_none() {
            return Err(ServiceError::validation_failed(format!(
                "Step not found: {}",
                self.id
            )));
        }

        let existing = existing.unwrap();
        let resulting_step_type = self
            .step_type
            .as_ref()
            .map(|step_type| StepType::from(step_type.clone()))
            .unwrap_or_else(|| existing.step_type.clone());

        if self.prompt.is_some() && self.clear_prompt {
            return Err(ServiceError::validation_failed(
                "--prompt and --clear-prompt cannot be used together",
            ));
        }
        if self.route_config.is_some() && self.clear_route_config {
            return Err(ServiceError::validation_failed(
                "--route-config and --clear-route-config cannot be used together",
            ));
        }

        let route_config = self
            .route_config
            .as_deref()
            .map(|json_str| {
                serde_json::from_str::<serde_json::Value>(json_str).map_err(|e| {
                    ServiceError::validation_failed(format!("Invalid --route-config JSON: {}", e))
                })
            })
            .transpose()?;

        let resulting_prompt = if self.clear_prompt {
            None
        } else {
            self.prompt.as_deref().or(existing.prompt.as_deref())
        };
        let resulting_transitions = if self.clear_transitions || !self.transitions_to.is_empty() {
            if self.clear_transitions {
                Vec::new()
            } else {
                self.transitions_to.clone()
            }
        } else {
            existing.transitions_to.clone()
        };
        validate_step_constraints(
            &resulting_step_type,
            resulting_prompt,
            &resulting_transitions,
        )?;

        let mut updates = StepUpdate::new();

        if let Some(name) = &self.name {
            updates = updates.with_name(name);
        }

        if let Some(goal) = &self.goal {
            updates = updates.with_goal(goal);
        }

        if let Some(prompt) = &self.prompt {
            updates = updates.with_prompt(prompt);
        }
        if self.clear_prompt {
            updates = updates.clear_prompt();
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

        if let Some(step_type) = &self.step_type {
            updates = updates.with_step_type(step_type.clone().into());
        }

        if self.clear_output_schema {
            updates = updates.with_output_schema(None);
        } else if let Some(json_str) = &self.output_schema {
            let value: serde_json::Value = serde_json::from_str(json_str).map_err(|e| {
                ServiceError::validation_failed(format!("Invalid --output-schema JSON: {}", e))
            })?;
            updates = updates.with_output_schema(Some(value));
        }

        if self.clear_persistence_options {
            updates = updates.with_persistence_options(None);
        } else if let Some(json_str) = &self.persistence_options {
            let value: serde_json::Value = serde_json::from_str(json_str).map_err(|e| {
                ServiceError::validation_failed(format!(
                    "Invalid --persistence-options JSON: {}",
                    e
                ))
            })?;
            updates = updates.with_persistence_options(Some(value));
        }

        if self.clear_route_config {
            updates = updates.with_route_config(None);
        } else if let Some(route_config) = route_config {
            updates = updates.with_route_config(Some(route_config));
        }

        if let Some(order) = self.order {
            updates = updates.with_order(order);
        }

        if self.agent_config.is_some()
            || self.model.is_some()
            || self.provider.is_some()
            || self.codex_model_provider.is_some()
            || self.reasoning_effort.is_some()
            || self.speed_tier.is_some()
            || self.personality.is_some()
            || self.verbosity.is_some()
            || self.clear_speed_tier
            || self.clear_personality
            || self.clear_verbosity
        {
            let mut agent_config = build_overlayed_agent_config(
                existing.agent_config.clone(),
                self.agent_config.as_deref(),
                AgentConfigOverrides {
                    provider: self.provider,
                    model: self.model.as_deref(),
                    codex_model_provider: self.codex_model_provider.as_deref(),
                    reasoning_effort: self.reasoning_effort.as_deref(),
                    speed_tier: self.speed_tier.map(Into::into),
                    personality: self.personality.as_deref(),
                    verbosity: self.verbosity.map(Into::into),
                },
            )?;
            if self.clear_speed_tier {
                agent_config.speed_tier = None;
            }
            if self.clear_personality {
                agent_config.personality = None;
            }
            if self.clear_verbosity {
                agent_config.verbosity = None;
            }
            let config_value = serde_json::to_value(&agent_config).map_err(|e| {
                ServiceError::validation_failed(format!("Invalid agent config: {}", e))
            })?;
            updates = updates.with_agent_config(config_value);
        }

        validate_route_update(&existing, &updates)?;

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

    /// Accepted for compatibility; step deletion does not prompt for confirmation
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
        let id = self.id.to_lowercase();
        let existing = service.get_step(&id).await?;
        if existing.is_none() {
            return Err(ServiceError::validation_failed(format!(
                "Step not found: {}",
                self.id
            )));
        }

        service.delete_step(&id).await?;

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
    fn test_step_add_with_reasoning_effort_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Coding",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000007",
            "--provider",
            "openai",
            "--model",
            "gpt-5.5",
            "--reasoning-effort",
            "high",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert_eq!(cmd.provider, Some(Provider::Openai));
                assert_eq!(cmd.model.as_deref(), Some("gpt-5.5"));
                assert_eq!(cmd.reasoning_effort.as_deref(), Some("high"));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_execution_settings_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Review",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000007",
            "--provider",
            "openai",
            "--speed-tier",
            "fast",
            "--personality",
            "friendly",
            "--verbosity",
            "high",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert!(matches!(cmd.speed_tier, Some(CliSpeedTier::Fast)));
                assert_eq!(cmd.personality.as_deref(), Some("friendly"));
                assert!(matches!(cmd.verbosity, Some(CliOutputVerbosity::High)));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_codex_model_provider_alias_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Coding",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000007",
            "--provider",
            "openai",
            "--model",
            "deepseek/deepseek-v4-flash",
            "--codex-provider",
            "openrouter",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert_eq!(cmd.provider, Some(Provider::Openai));
                assert_eq!(cmd.model.as_deref(), Some("deepseek/deepseek-v4-flash"));
                assert_eq!(cmd.codex_model_provider.as_deref(), Some("openrouter"));
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
                assert_eq!(
                    cmd.transitions_to,
                    vec!["a1b2c3d4-0000-4000-8000-00000000000c"]
                );
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_reasoning_effort_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--reasoning-effort",
            "xhigh",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.reasoning_effort.as_deref(), Some("xhigh"));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_execution_settings_and_clear_flags_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--speed-tier",
            "default",
            "--personality",
            "pragmatic",
            "--output-verbosity",
            "low",
            "--clear-speed-tier",
            "--clear-personality",
            "--clear-verbosity",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert!(matches!(cmd.speed_tier, Some(CliSpeedTier::Default)));
                assert_eq!(cmd.personality.as_deref(), Some("pragmatic"));
                assert!(matches!(cmd.verbosity, Some(CliOutputVerbosity::Low)));
                assert!(cmd.clear_speed_tier);
                assert!(cmd.clear_personality);
                assert!(cmd.clear_verbosity);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_codex_model_provider_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--codex-model-provider",
            "zai",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.codex_model_provider.as_deref(), Some("zai"));
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

    #[test]
    fn test_step_add_with_prompt() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Review",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--prompt",
            "Review the code for quality",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert_eq!(cmd.prompt, Some("Review the code for quality".to_string()));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_route_config() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Router",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "route",
            "--route-config",
            r#"{"version":1,"rules":[]}"#,
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                assert_eq!(
                    cmd.route_config,
                    Some(r#"{"version":1,"rules":[]}"#.to_string())
                );
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_agent_config_json() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Deploy",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--agent-config",
            r#"{"model":"opus","max_budget_usd":5.0}"#,
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert_eq!(
                    cmd.agent_config,
                    Some(r#"{"model":"opus","max_budget_usd":5.0}"#.to_string())
                );
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_agent_config_and_model() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Deploy",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--agent-config",
            r#"{"model":"sonnet","max_budget_usd":5.0}"#,
            "--model",
            "opus",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Add(cmd) => {
                assert_eq!(
                    cmd.agent_config,
                    Some(r#"{"model":"sonnet","max_budget_usd":5.0}"#.to_string())
                );
                assert_eq!(cmd.model, Some("opus".to_string()));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_update_with_prompt() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--prompt",
            "New prompt text",
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.prompt, Some("New prompt text".to_string()));
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_route_config_and_prompt_clear() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--route-config",
            r#"{"version":1}"#,
            "--clear-prompt",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.route_config, Some(r#"{"version":1}"#.to_string()));
                assert!(cmd.clear_prompt);
                assert!(!cmd.clear_route_config);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_route_config_clear() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--clear-route-config",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                assert!(cmd.route_config.is_none());
                assert!(cmd.clear_route_config);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_agent_config_json() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--agent-config",
            r#"{"model":"haiku","permission_mode":"plan"}"#,
        ]);
        assert!(cli.is_ok());
        match cli.unwrap().command {
            StepCommand::Update(cmd) => {
                assert_eq!(
                    cmd.agent_config,
                    Some(r#"{"model":"haiku","permission_mode":"plan"}"#.to_string())
                );
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_add_defaults_step_type_to_execute() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Review",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::Execute);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_step_type_route() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Router",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "route",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::Route);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_step_type_evaluate() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Checker",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "evaluate",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::Evaluate);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_step_type_wait_children() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Waiter",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "wait_children",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::WaitChildren);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_step_type_human_input() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Human Approval",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "human_input",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::HumanInput);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_step_type_stop() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Stop",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "stop",
            "--transition-to",
            "a1b2c3d4-0000-4000-8000-000000000007",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::Stop);
                assert_eq!(cmd.transitions_to.len(), 1);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_step_type_finish() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Finish",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "finish",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::Finish);
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_update_with_step_type_wait_children() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--step-type",
            "wait_children",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                let core_type: StepType = cmd.step_type.unwrap().into();
                assert_eq!(core_type, StepType::WaitChildren);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_step_type_human_input() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--step-type",
            "human_input",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                let core_type: StepType = cmd.step_type.unwrap().into();
                assert_eq!(core_type, StepType::HumanInput);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_step_type_stop() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--step-type",
            "stop",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                let core_type: StepType = cmd.step_type.unwrap().into();
                assert_eq!(core_type, StepType::Stop);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_stop_requires_exactly_one_transition() {
        let error = validate_step_constraints(&StepType::Stop, None, &[]).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("exactly one outgoing transition")
        );

        let transitions = vec!["step-1".to_string(), "step-2".to_string()];
        let error = validate_step_constraints(&StepType::Stop, None, &transitions).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("exactly one outgoing transition")
        );

        validate_step_constraints(
            &StepType::Stop,
            Some("ignored by the orchestrator"),
            &["step-1".to_string()],
        )
        .unwrap();
    }

    #[test]
    fn test_step_update_with_step_type_finish() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--step-type",
            "finish",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                let core_type: StepType = cmd.step_type.unwrap().into();
                assert_eq!(core_type, StepType::Finish);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_add_with_output_schema() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Evaluator",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--output-schema",
            r#"{"type":"object","properties":{"score":{"type":"number"}}}"#,
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                assert_eq!(
                    cmd.output_schema,
                    Some(
                        r#"{"type":"object","properties":{"score":{"type":"number"}}}"#.to_string()
                    )
                );
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_persistence_options() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Persisted",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--persistence-options",
            r#"{"artifact":{"logical_name":"step_result"}}"#,
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => assert_eq!(
                cmd.persistence_options,
                Some(r#"{"artifact":{"logical_name":"step_result"}}"#.to_string())
            ),
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_with_step_type_and_output_schema() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Evaluator",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "evaluate",
            "--output-schema",
            r#"{"type":"object"}"#,
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::Evaluate);
                assert_eq!(cmd.output_schema, Some(r#"{"type":"object"}"#.to_string()));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_rejects_invalid_step_type() {
        let result = TestCli::try_parse_from([
            "test",
            "add",
            "Bad",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "nonexistent",
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn test_step_update_with_step_type() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--step-type",
            "evaluate",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                let core_type: StepType = cmd.step_type.unwrap().into();
                assert_eq!(core_type, StepType::Evaluate);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_output_schema() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--output-schema",
            r#"{"type":"string"}"#,
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.output_schema, Some(r#"{"type":"string"}"#.to_string()));
                assert!(!cmd.clear_output_schema);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_clear_output_schema() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--clear-output-schema",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                assert!(cmd.clear_output_schema);
                assert!(cmd.output_schema.is_none());
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_with_persistence_options_and_clear() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--persistence-options",
            r#"{"artifact":{"logical_name":"step_result"}}"#,
            "--clear-persistence-options",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                assert_eq!(
                    cmd.persistence_options,
                    Some(r#"{"artifact":{"logical_name":"step_result"}}"#.to_string())
                );
                assert!(cmd.clear_persistence_options);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_update_without_step_type_defaults_to_none() {
        let cli =
            TestCli::try_parse_from(["test", "update", "a1b2c3d4-0000-4000-8000-00000000000b"])
                .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                assert!(cmd.step_type.is_none());
                assert!(cmd.output_schema.is_none());
                assert!(!cmd.clear_output_schema);
                assert!(cmd.persistence_options.is_none());
                assert!(!cmd.clear_persistence_options);
            }
            _ => panic!("Expected Update command"),
        }
    }

    #[test]
    fn test_step_add_with_provider_flag() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Review",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--provider",
            "openai",
            "--model",
            "gpt-4o",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                assert_eq!(cmd.provider, Some(Provider::Openai));
                assert_eq!(cmd.model.as_deref(), Some("gpt-4o"));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_provider_alias_model_provider() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Review",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--model-provider",
            "anthropic",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                assert_eq!(cmd.provider, Some(Provider::Anthropic));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_update_with_provider_flag() {
        let cli = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--provider",
            "openai",
        ])
        .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
                assert_eq!(cmd.provider, Some(Provider::Openai));
            }
            _ => panic!("Expected Update command"),
        }
    }
}
