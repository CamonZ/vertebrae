use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::StepType;

mod route;
#[cfg(test)]
mod tests;
mod validation;

pub use route::{RouteTargetRefs, symbolize_route_config};
pub use validation::ManifestValidationError;

pub const WORKFLOW_BUNDLE_SCHEMA_VERSION: u32 = 1;

pub type WorkflowRef = String;

pub type StepRef = String;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepAddress {
    pub workflow_ref: WorkflowRef,
    pub step_ref: StepRef,
}

impl StepAddress {
    pub fn new(workflow_ref: impl Into<String>, step_ref: impl Into<String>) -> Self {
        Self {
            workflow_ref: workflow_ref.into(),
            step_ref: step_ref.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowManifest {
    pub workflow_ref: WorkflowRef,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub display_order: i32,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kanban_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory_name: Option<String>,
    // Opaque Sacrum metadata: only the top-level value must be an object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_step: Option<StepAddress>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<StepManifest>,
}

impl WorkflowManifest {
    pub fn new(workflow_ref: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            workflow_ref: workflow_ref.into(),
            name: name.into(),
            description: None,
            display_order: 0,
            is_default: false,
            kanban_column: None,
            factory_name: None,
            metadata: None,
            initial_step: None,
            steps: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepManifest {
    pub step_ref: StepRef,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    // Keep null distinct from an explicitly empty prompt in canonical JSON.
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    // Opaque Sacrum configuration: target references are validated separately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_config: Option<Value>,
    #[serde(default = "default_step_type", skip_serializing_if = "is_execute")]
    pub step_type: StepType,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub step_order: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persistence_options: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_config: Option<Value>,
}

impl StepManifest {
    pub fn new(step_ref: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            step_ref: step_ref.into(),
            name: name.into(),
            goal: None,
            prompt: None,
            agents: Vec::new(),
            skills: Vec::new(),
            agent_config: None,
            step_type: StepType::default(),
            step_order: 0,
            output_schema: None,
            persistence_options: None,
            route_config: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepEdge {
    pub from: StepAddress,
    pub to: StepAddress,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowEdge {
    pub from_workflow_ref: WorkflowRef,
    pub to_workflow_ref: WorkflowRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_step: Option<StepAddress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowBundleManifest {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflows: Vec<WorkflowManifest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub step_edges: Vec<StepEdge>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workflow_edges: Vec<WorkflowEdge>,
}

pub type WorkflowBundle = WorkflowBundleManifest;

impl WorkflowBundleManifest {
    pub fn empty() -> Self {
        Self {
            schema_version: WORKFLOW_BUNDLE_SCHEMA_VERSION,
            workflows: Vec::new(),
            step_edges: Vec::new(),
            workflow_edges: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<(), ManifestValidationError> {
        validation::validate_bundle(self)
    }

    pub fn canonicalize(&self) -> Self {
        let mut canonical = self.clone();
        for workflow in &mut canonical.workflows {
            workflow.steps.sort_by(|left, right| {
                (left.step_order, &left.step_ref).cmp(&(right.step_order, &right.step_ref))
            });
        }
        canonical.workflows.sort_by(|left, right| {
            (left.display_order, &left.workflow_ref)
                .cmp(&(right.display_order, &right.workflow_ref))
        });
        canonical.step_edges.sort_by(|left, right| {
            (&left.from, &left.to, &left.label).cmp(&(&right.from, &right.to, &right.label))
        });
        canonical.workflow_edges.sort_by(|left, right| {
            (
                &left.from_workflow_ref,
                &left.to_workflow_ref,
                &left.destination_step,
                &left.label,
            )
                .cmp(&(
                    &right.from_workflow_ref,
                    &right.to_workflow_ref,
                    &right.destination_step,
                    &right.label,
                ))
        });
        canonical
    }

    pub fn canonical_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(&self.canonicalize())
    }
}

#[derive(Debug)]
pub enum ManifestError {
    Json(serde_json::Error),
    InvalidField(ManifestValidationError),
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(formatter, "invalid workflow bundle JSON: {error}"),
            Self::InvalidField(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ManifestError {}

pub fn parse_manifest(input: &str) -> Result<WorkflowBundleManifest, ManifestError> {
    let value: Value = serde_json::from_str(input).map_err(ManifestError::Json)?;
    let manifest: WorkflowBundleManifest =
        serde_path_to_error::deserialize(value).map_err(|error| {
            let path = error.path().to_string();
            let path = if path.is_empty() { "$" } else { &path };
            ManifestError::InvalidField(ManifestValidationError::new(
                path,
                error.inner().to_string(),
            ))
        })?;
    manifest.validate().map_err(ManifestError::InvalidField)?;
    Ok(manifest)
}

fn default_step_type() -> StepType {
    StepType::default()
}

fn is_execute(step_type: &StepType) -> bool {
    matches!(step_type, StepType::Execute)
}

fn is_zero(value: &i32) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}
