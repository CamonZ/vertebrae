use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::models::StepType;

use super::route::validate_route_config;
use super::{StepAddress, WorkflowBundleManifest};

pub(super) fn validate_bundle(
    bundle: &WorkflowBundleManifest,
) -> Result<(), ManifestValidationError> {
    let mut workflows = BTreeMap::new();
    let mut step_maps = BTreeMap::new();
    for (index, workflow) in bundle.workflows.iter().enumerate() {
        let path = format!("workflows[{index}]");
        require_ref(&workflow.workflow_ref, format!("{path}.workflow_ref"))?;
        require_text(&workflow.name, format!("{path}.name"))?;
        if workflows
            .insert(workflow.workflow_ref.clone(), index)
            .is_some()
        {
            return Err(ManifestValidationError::new(
                format!("{path}.workflow_ref"),
                format!("duplicate workflow ref {:?}", workflow.workflow_ref),
            ));
        }
        if workflow
            .metadata
            .as_ref()
            .is_some_and(|metadata| !metadata.is_object())
        {
            return Err(ManifestValidationError::new(
                format!("{path}.metadata"),
                "workflow metadata must be a JSON object",
            ));
        }

        let mut steps = BTreeMap::new();
        for (step_index, step) in workflow.steps.iter().enumerate() {
            let step_path = format!("{path}.steps[{step_index}]");
            require_ref(&step.step_ref, format!("{step_path}.step_ref"))?;
            require_text(&step.name, format!("{step_path}.name"))?;
            if steps.insert(step.step_ref.clone(), step_index).is_some() {
                return Err(ManifestValidationError::new(
                    format!("{step_path}.step_ref"),
                    format!(
                        "duplicate step ref {:?} in workflow {:?}",
                        step.step_ref, workflow.workflow_ref
                    ),
                ));
            }
            if matches!(step.step_type, StepType::Unsupported(_)) {
                return Err(ManifestValidationError::new(
                    format!("{step_path}.step_type"),
                    format!("unsupported step type {:?}", step.step_type.as_str()),
                ));
            }
            validate_step_config(step, &step_path)?;
            validate_json_object_or_null(
                step.persistence_options.as_ref(),
                format!("{step_path}.persistence_options"),
            )?;
        }

        if let Some(initial) = &workflow.initial_step {
            validate_step_address(
                initial,
                &workflow.workflow_ref,
                &steps,
                format!("{path}.initial_step"),
                "initial step",
            )?;
        }
        step_maps.insert(workflow.workflow_ref.clone(), steps);
    }

    let step_addresses = bundle
        .workflows
        .iter()
        .flat_map(|workflow| {
            workflow
                .steps
                .iter()
                .map(move |step| StepAddress::new(&workflow.workflow_ref, &step.step_ref))
        })
        .collect::<BTreeSet<_>>();

    let mut step_edges = BTreeSet::new();
    let mut outgoing_step_edges: BTreeMap<StepAddress, BTreeSet<StepAddress>> = BTreeMap::new();
    for (index, edge) in bundle.step_edges.iter().enumerate() {
        let path = format!("step_edges[{index}]");
        if edge.from.workflow_ref != edge.to.workflow_ref {
            return Err(ManifestValidationError::new(
                path,
                format!(
                    "step edge crosses workflows: {:?} -> {:?}",
                    edge.from, edge.to
                ),
            ));
        }
        if !step_addresses.contains(&edge.from) {
            return Err(ManifestValidationError::new(
                format!("step_edges[{index}].from"),
                format!("unresolved step ref {:?}", edge.from),
            ));
        }
        if !step_addresses.contains(&edge.to) {
            return Err(ManifestValidationError::new(
                format!("step_edges[{index}].to"),
                format!("unresolved step ref {:?}", edge.to),
            ));
        }
        let key = (edge.from.clone(), edge.to.clone());
        if !step_edges.insert(key) {
            return Err(ManifestValidationError::new(
                path,
                "duplicate step edge (same endpoints)",
            ));
        }
        outgoing_step_edges
            .entry(edge.from.clone())
            .or_default()
            .insert(edge.to.clone());
    }

    let workflow_refs = workflows.keys().cloned().collect::<BTreeSet<_>>();
    let mut workflow_edges = BTreeSet::new();
    let mut outgoing_workflow_edges = BTreeSet::new();
    for (index, edge) in bundle.workflow_edges.iter().enumerate() {
        let path = format!("workflow_edges[{index}]");
        if !workflow_refs.contains(&edge.from_workflow_ref) {
            return Err(ManifestValidationError::new(
                format!("{path}.from_workflow_ref"),
                format!("unresolved workflow ref {:?}", edge.from_workflow_ref),
            ));
        }
        if !workflow_refs.contains(&edge.to_workflow_ref) {
            return Err(ManifestValidationError::new(
                format!("{path}.to_workflow_ref"),
                format!("unresolved workflow ref {:?}", edge.to_workflow_ref),
            ));
        }
        if let Some(destination) = &edge.destination_step {
            if destination.workflow_ref != edge.to_workflow_ref {
                return Err(ManifestValidationError::new(
                    format!("{path}.destination_step.workflow_ref"),
                    "destination step must belong to to_workflow_ref",
                ));
            }
            if !step_addresses.contains(destination) {
                return Err(ManifestValidationError::new(
                    format!("{path}.destination_step"),
                    format!("unresolved step ref {:?}", destination),
                ));
            }
        }
        let key = (edge.from_workflow_ref.clone(), edge.to_workflow_ref.clone());
        if !workflow_edges.insert(key) {
            return Err(ManifestValidationError::new(
                path,
                "duplicate workflow edge (same endpoints)",
            ));
        }
        outgoing_workflow_edges
            .insert((edge.from_workflow_ref.clone(), edge.to_workflow_ref.clone()));
    }

    // Route targets are validated after the complete workflow and graph
    // namespaces are known, so declaration order does not matter.
    for (workflow_index, workflow) in bundle.workflows.iter().enumerate() {
        let steps = step_maps
            .get(&workflow.workflow_ref)
            .expect("step map is created with every workflow");
        for (step_index, step) in workflow.steps.iter().enumerate() {
            if let Some(route_config) = step
                .config
                .as_ref()
                .and_then(|config| config.get("route_config"))
            {
                validate_route_config(
                    route_config,
                    &workflow.workflow_ref,
                    steps,
                    &workflows,
                    outgoing_step_edges
                        .get(&StepAddress::new(&workflow.workflow_ref, &step.step_ref)),
                    &outgoing_workflow_edges,
                    format!("workflows[{workflow_index}].steps[{step_index}].config.route_config"),
                )?;
            }
        }
    }

    Ok(())
}

fn validate_step_config(
    step: &super::StepManifest,
    step_path: &str,
) -> Result<(), ManifestValidationError> {
    let path = format!("{step_path}.config");
    let Some(config) = &step.config else {
        if step.step_type.config_fields().is_some() {
            return Err(ManifestValidationError::new(
                path,
                "config must be an object",
            ));
        }
        return Ok(());
    };
    if step.step_type.config_fields().is_none() {
        return Err(ManifestValidationError::new(
            path,
            "config must be null for this step type",
        ));
    }
    let object = config.as_object().ok_or_else(|| {
        ManifestValidationError::new(&path, "config must be a JSON object or null")
    })?;
    let allowed = step.step_type.config_fields().expect("checked above");
    for key in object.keys() {
        if key != "version" && !allowed.contains(&key.as_str()) {
            return Err(ManifestValidationError::new(
                format!("{path}.{key}"),
                format!("{key} is not supported for {} steps", step.step_type),
            ));
        }
    }
    if let Some(output_schema) = object.get("output_schema")
        && !output_schema.is_null()
        && !output_schema.is_object()
    {
        return Err(ManifestValidationError::new(
            format!("{path}.output_schema"),
            "output_schema must be a JSON object or null",
        ));
    }
    if let Some(version) = object.get("version")
        && version.as_i64() != Some(crate::models::STEP_CONFIG_VERSION as i64)
    {
        return Err(ManifestValidationError::new(
            format!("{path}.version"),
            "unsupported step config version",
        ));
    }
    let decode_error = match &step.step_type {
        StepType::LlmInference => decode_config::<crate::models::LlmInferenceConfig>(config),
        StepType::StructuredInference => {
            decode_config::<crate::models::StructuredInferenceConfig>(config)
        }
        StepType::Route => decode_config::<crate::models::RouteConfig>(config),
        StepType::WaitChildren => decode_config::<crate::models::WaitChildrenConfig>(config),
        _ => None,
    };
    if let Some((field_path, message)) = decode_error {
        let field_path = if field_path.is_empty() {
            message
                .split("missing field `")
                .nth(1)
                .and_then(|part| part.split('`').next())
                .unwrap_or("")
                .to_string()
        } else {
            field_path
        };
        return Err(ManifestValidationError::new(
            if field_path.is_empty() {
                path
            } else {
                format!("{path}.{field_path}")
            },
            message,
        ));
    }
    Ok(())
}

fn decode_config<T: DeserializeOwned>(config: &Value) -> Option<(String, String)> {
    serde_path_to_error::deserialize::<_, T>(config.clone())
        .err()
        .map(|error| (error.path().to_string(), error.inner().to_string()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestValidationError {
    pub path: String,
    pub message: String,
}

impl ManifestValidationError {
    pub(crate) fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ManifestValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.path, self.message)
    }
}

impl std::error::Error for ManifestValidationError {}

fn validate_step_address(
    address: &StepAddress,
    expected_workflow: &str,
    local_steps: &BTreeMap<String, usize>,
    path: String,
    kind: &str,
) -> Result<(), ManifestValidationError> {
    if address.workflow_ref != expected_workflow {
        return Err(ManifestValidationError::new(
            format!("{path}.workflow_ref"),
            format!("{kind} must belong to workflow {expected_workflow:?}"),
        ));
    }
    if !local_steps.contains_key(&address.step_ref) {
        return Err(ManifestValidationError::new(
            format!("{path}.step_ref"),
            format!("unresolved step ref {:?}", address.step_ref),
        ));
    }
    Ok(())
}

fn validate_json_object_or_null(
    value: Option<&Value>,
    path: String,
) -> Result<(), ManifestValidationError> {
    if value.is_some_and(|value| !value.is_object()) {
        return Err(ManifestValidationError::new(
            path,
            "value must be a JSON object",
        ));
    }
    Ok(())
}

fn require_ref(value: &str, path: String) -> Result<(), ManifestValidationError> {
    if value.trim().is_empty() {
        Err(ManifestValidationError::new(
            path,
            "reference must not be empty",
        ))
    } else {
        Ok(())
    }
}

fn require_text(value: &str, path: String) -> Result<(), ManifestValidationError> {
    if value.is_empty() {
        Err(ManifestValidationError::new(
            path,
            "value must not be empty",
        ))
    } else {
        Ok(())
    }
}
