//! Orchestrator agent configuration for workflow step execution
//!
//! The orchestrator is a fixed Claude agent (using Haiku model for fast/cheap generation)
//! that analyzes task context and generates structured JSON prompts for the execution phase.
//!
//! # Role
//!
//! The orchestrator:
//! 1. Reads task details via vtb commands (read-only)
//! 2. Analyzes the current workflow step requirements
//! 3. Generates a structured JSON prompt for the execution agent
//! 4. Creates a StepExecution record with the generated prompt
//!
//! # Constraints
//!
//! - Must not mutate task state (read-only except execution create)
//! - Output must be valid JSON matching [`OrchestratorOutput`]
//! - Uses Haiku model for fast, cost-effective prompt generation

use serde::{Deserialize, Serialize};
use vertebrae_db::AgentConfig;

/// Model to use for orchestrator agent (Haiku for fast/cheap generation)
pub const ORCHESTRATOR_MODEL: &str = "haiku";

/// Path to the orchestrator agent markdown file
pub const ORCHESTRATOR_AGENT_PATH: &str = ".claude/agents/orchestrator.md";

/// Tools allowed for the orchestrator agent (read-only vtb commands + execution create)
pub const ORCHESTRATOR_ALLOWED_TOOLS: &[&str] = &[
    "Bash(vtb show:*)",
    "Bash(vtb workflow show:*)",
    "Bash(vtb step show:*)",
    "Bash(vtb execution create:*)",
];

/// Tools explicitly disallowed for the orchestrator agent
pub const ORCHESTRATOR_DISALLOWED_TOOLS: &[&str] = &[
    "Bash(vtb transition-to:*)",
    "Bash(vtb workflow advance:*)",
    "Bash(vtb workflow retreat:*)",
    "Bash(vtb update:*)",
    "Bash(vtb delete:*)",
    "Edit",
    "Write",
];

/// System prompt for the orchestrator agent
pub const ORCHESTRATOR_SYSTEM_PROMPT: &str = r#"You are the orchestrator agent for the Vertebrae workflow system. Your role is to analyze a task at a specific workflow step and generate a structured JSON prompt that will guide the execution agent.

## Your Responsibilities

1. Read task details using `vtb show <task-id>`
2. Read workflow configuration using `vtb workflow show <workflow-id>`
3. Read step configuration using `vtb step show <step-id>`
4. Analyze the task context, step goal, and constraints
5. Generate a structured JSON prompt for the execution agent
6. Create a StepExecution record using `vtb execution create`

## Constraints

- **Read-only**: You MUST NOT mutate task state. Only use read commands and execution create.
- **No transitions**: You do NOT advance or retreat workflow steps. That is handled by the execution agent.
- **Structured output**: Your final output MUST be valid JSON matching the required schema.
- **Focused**: Gather only the information needed to generate the prompt.

## Output Schema

Your output must be a JSON object with:
- goal: Clear statement of what this execution should accomplish
- context: Object with task_id, task_title, task_description, workflow_name, step_name, step_goal
- steps: Array of concrete actions the execution agent should take
- constraints: Array of rules the execution agent must follow
- success_criteria: Array of conditions that indicate successful completion
- transition_hint: One of "advance", "retreat", or "hold"

After gathering context, create the execution record:
`vtb execution create <task-id> --prompt '<your-json-output>'"#;

/// Context information about the task and workflow
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrchestratorContext {
    /// The task identifier
    pub task_id: String,
    /// The task title
    pub task_title: String,
    /// The task description
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_description: Option<String>,
    /// Name of the workflow
    pub workflow_name: String,
    /// Name of the current step
    pub step_name: String,
    /// The step's configured goal, if any
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_goal: Option<String>,
}

/// Hint for what transition should occur after execution
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TransitionHint {
    /// Advance to the next workflow step
    #[default]
    Advance,
    /// Go back to the previous step (for rework)
    Retreat,
    /// Stay at current step (for multi-turn work)
    Hold,
}

impl std::fmt::Display for TransitionHint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransitionHint::Advance => write!(f, "advance"),
            TransitionHint::Retreat => write!(f, "retreat"),
            TransitionHint::Hold => write!(f, "hold"),
        }
    }
}

impl std::str::FromStr for TransitionHint {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "advance" => Ok(TransitionHint::Advance),
            "retreat" => Ok(TransitionHint::Retreat),
            "hold" => Ok(TransitionHint::Hold),
            _ => Err(format!(
                "Invalid transition hint '{}'. Expected: advance, retreat, or hold",
                s
            )),
        }
    }
}

/// The structured output from the orchestrator agent
///
/// This JSON structure is generated by the orchestrator and used to guide
/// the execution agent during workflow step processing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrchestratorOutput {
    /// Clear statement of what this execution should accomplish
    pub goal: String,

    /// Context information about the task and workflow
    pub context: OrchestratorContext,

    /// Ordered list of concrete actions the execution agent should take
    pub steps: Vec<String>,

    /// Rules or limitations the execution agent must follow
    #[serde(default)]
    pub constraints: Vec<String>,

    /// How to determine if the execution was successful
    #[serde(default)]
    pub success_criteria: Vec<String>,

    /// Suggested next transition based on expected outcome
    #[serde(default)]
    pub transition_hint: TransitionHint,
}

impl OrchestratorOutput {
    /// Create a new orchestrator output with required fields
    pub fn new(goal: impl Into<String>, context: OrchestratorContext) -> Self {
        Self {
            goal: goal.into(),
            context,
            steps: Vec::new(),
            constraints: Vec::new(),
            success_criteria: Vec::new(),
            transition_hint: TransitionHint::default(),
        }
    }

    /// Add a step to the execution plan
    pub fn with_step(mut self, step: impl Into<String>) -> Self {
        self.steps.push(step.into());
        self
    }

    /// Add multiple steps to the execution plan
    pub fn with_steps(mut self, steps: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.steps.extend(steps.into_iter().map(|s| s.into()));
        self
    }

    /// Add a constraint for the execution agent
    pub fn with_constraint(mut self, constraint: impl Into<String>) -> Self {
        self.constraints.push(constraint.into());
        self
    }

    /// Add multiple constraints for the execution agent
    pub fn with_constraints(
        mut self,
        constraints: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.constraints
            .extend(constraints.into_iter().map(|c| c.into()));
        self
    }

    /// Add a success criterion
    pub fn with_success_criterion(mut self, criterion: impl Into<String>) -> Self {
        self.success_criteria.push(criterion.into());
        self
    }

    /// Add multiple success criteria
    pub fn with_success_criteria(
        mut self,
        criteria: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.success_criteria
            .extend(criteria.into_iter().map(|c| c.into()));
        self
    }

    /// Set the transition hint
    pub fn with_transition_hint(mut self, hint: TransitionHint) -> Self {
        self.transition_hint = hint;
        self
    }

    /// Serialize to JSON string
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Serialize to pretty JSON string
    pub fn to_json_pretty(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    /// Parse from JSON string
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

/// Create an AgentConfig configured for the orchestrator
///
/// Returns an AgentConfig with:
/// - Haiku model for fast/cheap generation
/// - Read-only vtb tools allowed
/// - Mutation tools disallowed
/// - Orchestrator system prompt
pub fn orchestrator_agent_config() -> AgentConfig {
    AgentConfig::new()
        .with_model(ORCHESTRATOR_MODEL)
        .with_system_prompt(ORCHESTRATOR_SYSTEM_PROMPT)
        .with_allowed_tools(
            ORCHESTRATOR_ALLOWED_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        )
        .with_disallowed_tools(
            ORCHESTRATOR_DISALLOWED_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        )
}

/// JSON Schema for the orchestrator output
///
/// This can be used with Claude's structured output feature to enforce
/// the output format.
pub fn orchestrator_output_schema() -> serde_json::Value {
    serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "OrchestratorOutput",
        "description": "Structured output from the orchestrator agent for workflow step execution",
        "type": "object",
        "required": ["goal", "context", "steps"],
        "properties": {
            "goal": {
                "type": "string",
                "description": "Clear statement of what this execution should accomplish"
            },
            "context": {
                "type": "object",
                "description": "Context information about the task and workflow",
                "required": ["task_id", "task_title", "workflow_name", "step_name"],
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "The task identifier"
                    },
                    "task_title": {
                        "type": "string",
                        "description": "The task title"
                    },
                    "task_description": {
                        "type": ["string", "null"],
                        "description": "The task description"
                    },
                    "workflow_name": {
                        "type": "string",
                        "description": "Name of the workflow"
                    },
                    "step_name": {
                        "type": "string",
                        "description": "Name of the current step"
                    },
                    "step_goal": {
                        "type": ["string", "null"],
                        "description": "The step's configured goal, if any"
                    }
                }
            },
            "steps": {
                "type": "array",
                "description": "Ordered list of concrete actions the execution agent should take",
                "items": {
                    "type": "string"
                }
            },
            "constraints": {
                "type": "array",
                "description": "Rules or limitations the execution agent must follow",
                "items": {
                    "type": "string"
                },
                "default": []
            },
            "success_criteria": {
                "type": "array",
                "description": "How to determine if the execution was successful",
                "items": {
                    "type": "string"
                },
                "default": []
            },
            "transition_hint": {
                "type": "string",
                "description": "Suggested next transition based on expected outcome",
                "enum": ["advance", "retreat", "hold"],
                "default": "advance"
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orchestrator_output_serialization() {
        let context = OrchestratorContext {
            task_id: "abc123".to_string(),
            task_title: "Add user authentication".to_string(),
            task_description: Some("Implement JWT-based auth".to_string()),
            workflow_name: "Implementation".to_string(),
            step_name: "review".to_string(),
            step_goal: Some("Ensure code quality".to_string()),
        };

        let output = OrchestratorOutput::new("Review the implementation", context)
            .with_steps(["Check security", "Verify tests"])
            .with_constraints(["Do not modify code"])
            .with_success_criteria(["All issues documented"])
            .with_transition_hint(TransitionHint::Advance);

        let json = output.to_json().expect("serialization should succeed");
        let parsed = OrchestratorOutput::from_json(&json).expect("deserialization should succeed");

        assert_eq!(output, parsed);
        assert_eq!(parsed.goal, "Review the implementation");
        assert_eq!(parsed.steps.len(), 2);
        assert_eq!(parsed.constraints.len(), 1);
        assert_eq!(parsed.success_criteria.len(), 1);
        assert_eq!(parsed.transition_hint, TransitionHint::Advance);
    }

    #[test]
    fn test_transition_hint_parsing() {
        assert_eq!(
            "advance".parse::<TransitionHint>().unwrap(),
            TransitionHint::Advance
        );
        assert_eq!(
            "RETREAT".parse::<TransitionHint>().unwrap(),
            TransitionHint::Retreat
        );
        assert_eq!(
            "Hold".parse::<TransitionHint>().unwrap(),
            TransitionHint::Hold
        );
        assert!("invalid".parse::<TransitionHint>().is_err());
    }

    #[test]
    fn test_transition_hint_display() {
        assert_eq!(TransitionHint::Advance.to_string(), "advance");
        assert_eq!(TransitionHint::Retreat.to_string(), "retreat");
        assert_eq!(TransitionHint::Hold.to_string(), "hold");
    }

    #[test]
    fn test_orchestrator_agent_config() {
        let config = orchestrator_agent_config();

        assert_eq!(config.model, Some(ORCHESTRATOR_MODEL.to_string()));
        assert!(config.system_prompt.is_some());
        assert!(!config.allowed_tools.is_empty());
        assert!(!config.disallowed_tools.is_empty());

        // Verify allowed tools include vtb read commands
        assert!(config.allowed_tools.iter().any(|t| t.contains("vtb show")));
        assert!(
            config
                .allowed_tools
                .iter()
                .any(|t| t.contains("vtb workflow show"))
        );
        assert!(
            config
                .allowed_tools
                .iter()
                .any(|t| t.contains("vtb execution create"))
        );

        // Verify disallowed tools include mutation commands
        assert!(
            config
                .disallowed_tools
                .iter()
                .any(|t| t.contains("vtb transition-to"))
        );
        assert!(config.disallowed_tools.iter().any(|t| t.contains("Edit")));
    }

    #[test]
    fn test_orchestrator_output_schema_is_valid_json() {
        let schema = orchestrator_output_schema();

        // Verify it's a valid JSON object with expected structure
        assert!(schema.is_object());
        assert_eq!(schema["type"], "object");
        assert!(schema["required"].is_array());
        assert!(schema["properties"].is_object());

        // Verify required fields
        let required = schema["required"].as_array().unwrap();
        assert!(required.contains(&serde_json::json!("goal")));
        assert!(required.contains(&serde_json::json!("context")));
        assert!(required.contains(&serde_json::json!("steps")));
    }

    #[test]
    fn test_orchestrator_output_defaults() {
        let context = OrchestratorContext {
            task_id: "test".to_string(),
            task_title: "Test task".to_string(),
            task_description: None,
            workflow_name: "Test workflow".to_string(),
            step_name: "test_step".to_string(),
            step_goal: None,
        };

        let output = OrchestratorOutput::new("Test goal", context);

        assert!(output.steps.is_empty());
        assert!(output.constraints.is_empty());
        assert!(output.success_criteria.is_empty());
        assert_eq!(output.transition_hint, TransitionHint::Advance);
    }

    #[test]
    fn test_orchestrator_context_optional_fields() {
        // Test with all optional fields as None
        let context = OrchestratorContext {
            task_id: "id".to_string(),
            task_title: "title".to_string(),
            task_description: None,
            workflow_name: "workflow".to_string(),
            step_name: "step".to_string(),
            step_goal: None,
        };

        let json = serde_json::to_string(&context).unwrap();

        // Verify optional fields are skipped when None
        assert!(!json.contains("task_description"));
        assert!(!json.contains("step_goal"));

        // Test with optional fields set
        let context_with_optionals = OrchestratorContext {
            task_id: "id".to_string(),
            task_title: "title".to_string(),
            task_description: Some("description".to_string()),
            workflow_name: "workflow".to_string(),
            step_name: "step".to_string(),
            step_goal: Some("goal".to_string()),
        };

        let json_with_optionals = serde_json::to_string(&context_with_optionals).unwrap();
        assert!(json_with_optionals.contains("task_description"));
        assert!(json_with_optionals.contains("step_goal"));
    }
}
