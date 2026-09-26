//! Step commands for managing first-class workflow steps
//!
//! Implements the `vtb step` subcommand group for creating and managing steps.

use clap::{Args, Subcommand, ValueEnum};
use vertebrae_core::{
    AgentConfig, OutputVerbosity, Provider, ServiceError, SpeedTier, Step, StepConfig, StepService,
    StepType, StepUpdate, VertebraeServices, normalize_provider_personality,
    normalize_provider_reasoning_effort, validate_config_fields, validate_provider_agent_config,
    validate_provider_model_with_codex_provider,
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
    #[value(name = "llm_inference")]
    LlmInference,
    #[value(name = "structured_inference")]
    StructuredInference,
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
            CliStepType::LlmInference => StepType::LlmInference,
            CliStepType::StructuredInference => StepType::StructuredInference,
            CliStepType::Route => StepType::Route,
            CliStepType::WaitChildren => StepType::WaitChildren,
            CliStepType::HumanInput => StepType::HumanInput,
            CliStepType::Stop => StepType::Stop,
            CliStepType::Finish => StepType::Finish,
        }
    }
}

fn validate_step_transitions(
    step_type: &StepType,
    transitions_to: &[String],
) -> Result<(), ServiceError> {
    if matches!(step_type, StepType::Finish) && !transitions_to.is_empty() {
        return Err(ServiceError::validation_failed(
            "Finish steps cannot define outgoing transitions",
        ));
    }

    if matches!(step_type, StepType::Stop) && transitions_to.len() != 1 {
        return Err(ServiceError::validation_failed(
            "Stop steps must define exactly one outgoing transition",
        ));
    }

    Ok(())
}

fn parse_json_flag(
    value: Option<&str>,
    flag: &str,
) -> Result<Option<serde_json::Value>, ServiceError> {
    value
        .map(|json_str| {
            serde_json::from_str::<serde_json::Value>(json_str)
                .map_err(|e| ServiceError::validation_failed(format!("Invalid {flag} JSON: {e}")))
        })
        .transpose()
}

/// Read an `@path` flag value from the file; other values are used as given.
fn read_flag_value(value: &str, flag: &str) -> Result<String, ServiceError> {
    match value.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path).map_err(|e| {
            ServiceError::validation_failed(format!("Failed to read {flag} file {path}: {e}"))
        }),
        None => Ok(value.to_string()),
    }
}

/// Parse `--state`: JSON objects, arrays, and strings are decoded; any other
/// value is sent as a literal string template.
fn parse_state_flag(value: Option<&str>) -> Result<Option<serde_json::Value>, ServiceError> {
    value
        .map(|value| {
            let raw = read_flag_value(value, "--state")?;
            Ok(match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(
                    json @ (serde_json::Value::Object(_)
                    | serde_json::Value::Array(_)
                    | serde_json::Value::String(_)),
                ) => json,
                _ => serde_json::Value::String(raw),
            })
        })
        .transpose()
}

fn parse_fields_flag(value: Option<&str>) -> Result<Option<serde_json::Value>, ServiceError> {
    value
        .map(|value| read_flag_value(value, "--fields"))
        .transpose()?
        .as_deref()
        .map(|raw| parse_json_flag(Some(raw), "--fields"))
        .transpose()
        .map(Option::flatten)
}

fn parse_agent_provider(value: Option<&str>) -> Result<Option<Provider>, ServiceError> {
    value
        .map(|value| Provider::parse(value).map_err(ServiceError::validation_failed))
        .transpose()
}

/// Step management commands
#[derive(Debug, Subcommand)]
pub enum StepCommand {
    /// Create a new step for a workflow
    Add(Box<StepAddCommand>),
    /// List all steps for a workflow
    List(StepListCommand),
    /// Show details of a specific step
    Show(StepShowCommand),
    /// Update a step's properties
    Update(Box<StepUpdateCommand>),
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

    /// Model to use: `config.model` for structured_inference steps, otherwise
    /// a convenience shortcut for agent_config.model
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

    /// Provider for this step (alias: --model-provider).
    ///
    /// For structured_inference steps this is `config.provider`, any
    /// non-blank provider name. Otherwise it is a convenience shortcut for
    /// `agent_config.provider` (anthropic, openai); use `--agent-config` JSON
    /// for any field this flag does not cover.
    #[arg(long, alias = "model-provider", value_name = "PROVIDER")]
    pub provider: Option<String>,

    /// Type of this step (llm_inference, structured_inference, route,
    /// wait_children, human_input, stop, finish).
    ///
    /// A step's type cannot change after creation. Config flags must be
    /// declared by the type: llm_inference takes the prompt, output schema,
    /// agent, skill, and agent-config flags; structured_inference takes
    /// --provider, --model, --state, and --fields; route takes
    /// --route-config; wait_children takes --output-schema; the others take
    /// none.
    #[arg(long, value_enum, default_value = "llm_inference")]
    pub step_type: CliStepType,

    /// Input of a structured_inference step: JSON object, array, or string,
    /// or a plain string template (`{{ dotted.path }}` references allowed);
    /// `@path` reads it from a file
    #[arg(long, value_name = "JSON|STRING")]
    pub state: Option<String>,

    /// JSON Schema of a structured_inference step's output, inline or `@path`
    #[arg(long, value_name = "JSON")]
    pub fields: Option<String>,

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
    validate_provider_agent_config(provider, &config)
        .map_err(|error| ServiceError::validation_failed(error.to_string()))?;
    Ok(config)
}

impl StepAddCommand {
    fn agent_config_flags_present(&self, step_type: &StepType) -> bool {
        let shortcuts = *step_type != StepType::StructuredInference
            && (self.model.is_some() || self.provider.is_some());
        self.agent_config.is_some()
            || shortcuts
            || self.codex_model_provider.is_some()
            || self.reasoning_effort.is_some()
            || self.speed_tier.is_some()
            || self.personality.is_some()
            || self.verbosity.is_some()
    }

    /// Config fields written by the given flags.
    fn config_fields(&self, step_type: &StepType) -> Vec<&'static str> {
        let structured = *step_type == StepType::StructuredInference;
        [
            ("prompt", self.prompt.is_some()),
            ("output_schema", self.output_schema.is_some()),
            ("agents", !self.agent.is_empty()),
            ("skills", !self.skill.is_empty()),
            ("agent_config", self.agent_config_flags_present(step_type)),
            ("route_config", self.route_config.is_some()),
            ("provider", structured && self.provider.is_some()),
            ("model", structured && self.model.is_some()),
            ("state", self.state.is_some()),
            ("fields", self.fields.is_some()),
        ]
        .into_iter()
        .filter_map(|(field, present)| present.then_some(field))
        .collect()
    }

    fn build_config(&self, step_type: &StepType) -> Result<Option<StepConfig>, ServiceError> {
        let output_schema = parse_json_flag(self.output_schema.as_deref(), "--output-schema")?;
        let route_config = parse_json_flag(self.route_config.as_deref(), "--route-config")?;

        let mut config = StepConfig::default_for(step_type);
        match &mut config {
            Some(StepConfig::LlmInference(config)) => {
                config.prompt = self.prompt.clone();
                config.output_schema = output_schema;
                config.agents = self.agent.clone();
                config.skills = self.skill.clone();
                config.agent_config = build_overlayed_agent_config(
                    AgentConfig::new(),
                    self.agent_config.as_deref(),
                    AgentConfigOverrides {
                        provider: parse_agent_provider(self.provider.as_deref())?,
                        model: self.model.as_deref(),
                        codex_model_provider: self.codex_model_provider.as_deref(),
                        reasoning_effort: self.reasoning_effort.as_deref(),
                        speed_tier: self.speed_tier.map(Into::into),
                        personality: self.personality.as_deref(),
                        verbosity: self.verbosity.map(Into::into),
                    },
                )?;
            }
            Some(StepConfig::StructuredInference(config)) => {
                config.provider = self.provider.clone();
                config.model = self.model.clone();
                config.state = parse_state_flag(self.state.as_deref())?;
                config.fields = parse_fields_flag(self.fields.as_deref())?;
            }
            Some(StepConfig::Route(config)) => config.route_config = route_config,
            Some(StepConfig::WaitChildren(config)) => config.output_schema = output_schema,
            None => {}
        }
        Ok(config)
    }

    pub async fn execute_result(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        let workflow_id = self.workflow.to_lowercase();
        let step_type: StepType = self.step_type.clone().into();

        let transitions_to: Vec<String> = self
            .transitions_to
            .iter()
            .map(|id| id.to_lowercase())
            .collect();
        validate_step_transitions(&step_type, &transitions_to)?;
        validate_config_fields(&step_type, self.config_fields(&step_type))?;

        let persistence_options =
            parse_json_flag(self.persistence_options.as_deref(), "--persistence-options")?;
        let config = self.build_config(&step_type)?;

        let mut step = Step::new(&self.name, workflow_id)
            .with_step_type(step_type)
            .with_config(config)
            .with_order(self.order)
            .with_transitions_to(transitions_to);

        if let Some(options) = persistence_options {
            step = step.with_persistence_options(options);
        }
        if let Some(goal) = &self.goal {
            step = step.with_goal(goal);
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
                let step_type = s.step_type.to_string();
                let model = match &s.config {
                    Some(StepConfig::LlmInference(config)) => {
                        Some(config.agent_config.model.as_deref().unwrap_or("default"))
                    }
                    Some(StepConfig::StructuredInference(config)) => {
                        Some(config.model.as_deref().unwrap_or("(none)"))
                    }
                    _ => None,
                };
                match model {
                    Some(model) => format!(
                        "{}. {} (id: {}, type: {}, model: {})",
                        s.order + 1,
                        s.name,
                        id,
                        step_type,
                        model
                    ),
                    None => format!(
                        "{}. {} (id: {}, type: {})",
                        s.order + 1,
                        s.name,
                        id,
                        step_type
                    ),
                }
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
        let goal = s.goal.as_deref().unwrap_or("(none)");

        let transitions = if s.transitions_to.is_empty() {
            "(none)".to_string()
        } else {
            s.transitions_to.join(", ")
        };

        let persistence_options = pretty_json(s.persistence_options.as_ref());

        let mut output = format!(
            r#"Step: {} - {}
============================================================

Workflow:      {}
Order:         {}
Step Type:     {}
Goal:          {}
"#,
            id, s.name, workflow_id, s.order, s.step_type, goal,
        );

        match &s.config {
            Some(StepConfig::LlmInference(config)) => {
                output.push_str(&format!(
                    "Agents:        {}\nSkills:        {}\nModel:         {}\nPrompt:        {}\nOutput Schema: {}\n",
                    list_or_none(&config.agents),
                    list_or_none(&config.skills),
                    config.agent_config.model.as_deref().unwrap_or("default"),
                    config.prompt.as_deref().unwrap_or("(none)"),
                    pretty_json(config.output_schema.as_ref()),
                ));
            }
            Some(StepConfig::StructuredInference(config)) => {
                output.push_str(&format!(
                    "Provider:      {}\nModel:         {}\nState:         {}\nFields:        {}\n",
                    config.provider.as_deref().unwrap_or("(none)"),
                    config.model.as_deref().unwrap_or("(none)"),
                    pretty_json(config.state.as_ref()),
                    pretty_json(config.fields.as_ref()),
                ));
            }
            Some(StepConfig::Route(config)) => {
                output.push_str(&format!(
                    "Route Config:  {}\n",
                    pretty_json(config.route_config.as_ref())
                ));
            }
            Some(StepConfig::WaitChildren(config)) => {
                output.push_str(&format!(
                    "Output Schema: {}\n",
                    pretty_json(config.output_schema.as_ref())
                ));
            }
            None => output.push_str("Config:        (none)\n"),
        }

        output.push_str(&format!(
            "Persistence:   {}\nTransitions:   {}\nCreated:       {}\nUpdated:       {}",
            persistence_options,
            transitions,
            s.created_at
                .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| "-".to_string()),
            s.updated_at
                .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|| "-".to_string()),
        ));

        Ok(output)
    }
}

fn list_or_none(values: &[String]) -> String {
    if values.is_empty() {
        "(none)".to_string()
    } else {
        values.join(", ")
    }
}

fn pretty_json(value: Option<&serde_json::Value>) -> String {
    value
        .map(|v| serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()))
        .unwrap_or_else(|| "(none)".to_string())
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

    /// New model: `config.model` for structured_inference steps, otherwise a
    /// convenience shortcut for agent_config.model
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

    /// New provider for this step (alias: --model-provider).
    ///
    /// For structured_inference steps this is `config.provider`. Otherwise it
    /// is a convenience shortcut for `agent_config.provider` (anthropic,
    /// openai); use `--agent-config` JSON for any field this flag does not
    /// cover.
    #[arg(long, alias = "model-provider", value_name = "PROVIDER")]
    pub provider: Option<String>,

    /// New input of a structured_inference step: JSON object, array, or
    /// string, or a plain string template; `@path` reads it from a file
    #[arg(long, value_name = "JSON|STRING")]
    pub state: Option<String>,

    /// New output JSON Schema of a structured_inference step, inline or `@path`
    #[arg(long, value_name = "JSON")]
    pub fields: Option<String>,

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
    fn agent_config_flags_present(&self, step_type: &StepType) -> bool {
        let shortcuts = *step_type != StepType::StructuredInference
            && (self.model.is_some() || self.provider.is_some());
        self.agent_config.is_some()
            || shortcuts
            || self.codex_model_provider.is_some()
            || self.reasoning_effort.is_some()
            || self.speed_tier.is_some()
            || self.personality.is_some()
            || self.verbosity.is_some()
            || self.clear_speed_tier
            || self.clear_personality
            || self.clear_verbosity
    }

    /// Config fields written (set or cleared) by the given flags.
    fn config_fields(&self, step_type: &StepType) -> Vec<&'static str> {
        let structured = *step_type == StepType::StructuredInference;
        [
            ("prompt", self.prompt.is_some() || self.clear_prompt),
            (
                "output_schema",
                self.output_schema.is_some() || self.clear_output_schema,
            ),
            ("agents", !self.agent.is_empty() || self.clear_agents),
            ("skills", !self.skill.is_empty() || self.clear_skills),
            ("agent_config", self.agent_config_flags_present(step_type)),
            (
                "route_config",
                self.route_config.is_some() || self.clear_route_config,
            ),
            ("provider", structured && self.provider.is_some()),
            ("model", structured && self.model.is_some()),
            ("state", self.state.is_some()),
            ("fields", self.fields.is_some()),
        ]
        .into_iter()
        .filter_map(|(field, present)| present.then_some(field))
        .collect()
    }

    pub async fn execute(&self, service: &dyn StepService) -> Result<String, ServiceError> {
        let existing = service
            .get_step(&self.id.to_lowercase())
            .await?
            .ok_or_else(|| {
                ServiceError::validation_failed(format!("Step not found: {}", self.id))
            })?;

        for (set, clear, flags) in [
            (
                self.prompt.is_some(),
                self.clear_prompt,
                "--prompt and --clear-prompt",
            ),
            (
                self.output_schema.is_some(),
                self.clear_output_schema,
                "--output-schema and --clear-output-schema",
            ),
            (
                self.route_config.is_some(),
                self.clear_route_config,
                "--route-config and --clear-route-config",
            ),
        ] {
            if set && clear {
                return Err(ServiceError::validation_failed(format!(
                    "{flags} cannot be used together"
                )));
            }
        }

        validate_config_fields(&existing.step_type, self.config_fields(&existing.step_type))?;

        let resulting_transitions = if self.clear_transitions {
            Vec::new()
        } else if !self.transitions_to.is_empty() {
            self.transitions_to.clone()
        } else {
            existing.transitions_to.clone()
        };
        validate_step_transitions(&existing.step_type, &resulting_transitions)?;

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

        if self.clear_output_schema {
            updates = updates.with_output_schema(None);
        } else if let Some(schema) =
            parse_json_flag(self.output_schema.as_deref(), "--output-schema")?
        {
            updates = updates.with_output_schema(Some(schema));
        }

        if self.clear_persistence_options {
            updates = updates.with_persistence_options(None);
        } else if let Some(options) =
            parse_json_flag(self.persistence_options.as_deref(), "--persistence-options")?
        {
            updates = updates.with_persistence_options(Some(options));
        }

        if self.clear_route_config {
            updates = updates.with_route_config(None);
        } else if let Some(route_config) =
            parse_json_flag(self.route_config.as_deref(), "--route-config")?
        {
            updates = updates.with_route_config(Some(route_config));
        }

        if let Some(order) = self.order {
            updates = updates.with_order(order);
        }

        if existing.step_type == StepType::StructuredInference {
            if let Some(provider) = &self.provider {
                updates = updates.with_config_field("provider", provider.as_str().into());
            }
            if let Some(model) = &self.model {
                updates = updates.with_config_field("model", model.as_str().into());
            }
        }
        if let Some(state) = parse_state_flag(self.state.as_deref())? {
            updates = updates.with_config_field("state", state);
        }
        if let Some(fields) = parse_fields_flag(self.fields.as_deref())? {
            updates = updates.with_config_field("fields", fields);
        }

        if self.agent_config_flags_present(&existing.step_type) {
            let mut agent_config = build_overlayed_agent_config(
                existing.agent_config().cloned().unwrap_or_default(),
                self.agent_config.as_deref(),
                AgentConfigOverrides {
                    provider: parse_agent_provider(self.provider.as_deref())?,
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
                assert_eq!(cmd.provider.as_deref(), Some("openai"));
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
                assert_eq!(cmd.provider.as_deref(), Some("openai"));
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
    fn test_step_add_defaults_step_type_to_llm_inference() {
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
                assert_eq!(core_type, StepType::LlmInference);
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
    fn test_step_add_rejects_retired_step_types() {
        for retired in ["execute", "evaluate"] {
            let result = TestCli::try_parse_from([
                "test",
                "add",
                "Checker",
                "--workflow",
                "a1b2c3d4-0000-4000-8000-000000000006",
                "--step-type",
                retired,
            ]);
            assert!(result.is_err(), "{retired} should be rejected");
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
    fn test_stop_requires_exactly_one_transition() {
        let error = validate_step_transitions(&StepType::Stop, &[]).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("exactly one outgoing transition")
        );

        let transitions = vec!["step-1".to_string(), "step-2".to_string()];
        let error = validate_step_transitions(&StepType::Stop, &transitions).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("exactly one outgoing transition")
        );

        validate_step_transitions(&StepType::Stop, &["step-1".to_string()]).unwrap();
    }

    #[test]
    fn test_finish_rejects_transitions() {
        let error =
            validate_step_transitions(&StepType::Finish, &["step-1".to_string()]).unwrap_err();
        assert!(error.to_string().contains("outgoing transitions"));
        validate_step_transitions(&StepType::Finish, &[]).unwrap();
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
            "wait_children",
            "--output-schema",
            r#"{"type":"object"}"#,
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                let core_type: StepType = cmd.step_type.into();
                assert_eq!(core_type, StepType::WaitChildren);
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
    fn test_step_update_rejects_step_type_flag() {
        let result = TestCli::try_parse_from([
            "test",
            "update",
            "a1b2c3d4-0000-4000-8000-00000000000b",
            "--step-type",
            "route",
        ]);
        assert!(result.is_err());
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
    fn test_step_update_defaults_leave_fields_unchanged() {
        let cli =
            TestCli::try_parse_from(["test", "update", "a1b2c3d4-0000-4000-8000-00000000000b"])
                .unwrap();
        match cli.command {
            StepCommand::Update(cmd) => {
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
                assert_eq!(cmd.provider.as_deref(), Some("openai"));
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
                assert_eq!(cmd.provider.as_deref(), Some("anthropic"));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_step_add_structured_inference_parses() {
        let cli = TestCli::try_parse_from([
            "test",
            "add",
            "Classify",
            "--workflow",
            "a1b2c3d4-0000-4000-8000-000000000006",
            "--step-type",
            "structured_inference",
            "--provider",
            "typesafe",
            "--model",
            "jev",
            "--state",
            "{{ task.title }}",
            "--fields",
            r#"{"type":"object"}"#,
        ])
        .unwrap();
        match cli.command {
            StepCommand::Add(cmd) => {
                assert!(matches!(cmd.step_type, CliStepType::StructuredInference));
                assert_eq!(cmd.provider.as_deref(), Some("typesafe"));
                assert_eq!(cmd.state.as_deref(), Some("{{ task.title }}"));
                assert_eq!(cmd.fields.as_deref(), Some(r#"{"type":"object"}"#));
            }
            _ => panic!("Expected Add command"),
        }
    }

    #[test]
    fn test_parse_state_flag_decodes_json_containers_and_keeps_templates() {
        assert_eq!(
            parse_state_flag(Some(r#"{"a":1}"#)).unwrap(),
            Some(serde_json::json!({"a": 1}))
        );
        assert_eq!(
            parse_state_flag(Some(r#""quoted""#)).unwrap(),
            Some(serde_json::json!("quoted"))
        );
        assert_eq!(
            parse_state_flag(Some("{{ task.title }}")).unwrap(),
            Some(serde_json::json!("{{ task.title }}"))
        );
        assert_eq!(
            parse_state_flag(Some("42")).unwrap(),
            Some(serde_json::json!("42"))
        );
        assert!(
            parse_fields_flag(Some("not json"))
                .unwrap_err()
                .to_string()
                .contains("Invalid --fields JSON")
        );
        assert!(
            parse_fields_flag(Some("@/nonexistent/vtb-fields.json"))
                .unwrap_err()
                .to_string()
                .contains("Failed to read --fields file")
        );
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
                assert_eq!(cmd.provider.as_deref(), Some("openai"));
            }
            _ => panic!("Expected Update command"),
        }
    }
}
