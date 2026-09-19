use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use super::validation::ManifestValidationError;
use super::{StepAddress, StepRef, WorkflowRef};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RouteTargetRefs {
    pub step_refs: BTreeMap<String, StepRef>,
    pub workflow_refs: BTreeMap<String, WorkflowRef>,
}

// Only documented target fields are rewritten; predicates and metadata stay opaque.
pub fn symbolize_route_config(
    route_config: &Value,
    refs: &RouteTargetRefs,
) -> Result<Value, ManifestValidationError> {
    let mut result = route_config.clone();
    let object = result.as_object_mut().ok_or_else(|| {
        ManifestValidationError::new("route_config", "route_config must be a JSON object")
    })?;

    if let Some(rules) = object.get_mut("rules") {
        let rules = rules.as_array_mut().ok_or_else(|| {
            ManifestValidationError::new("route_config.rules", "rules must be an array")
        })?;
        for (index, rule) in rules.iter_mut().enumerate() {
            let rule = rule.as_object_mut().ok_or_else(|| {
                ManifestValidationError::new(
                    format!("route_config.rules[{index}]"),
                    "rule must be a JSON object",
                )
            })?;
            rewrite_route_transition(
                rule.get_mut("transition"),
                refs,
                format!("route_config.rules[{index}].transition"),
            )?;
        }
    }
    match object.get_mut("default") {
        Some(default) if !default.is_null() => {
            let default = default.as_object_mut().ok_or_else(|| {
                ManifestValidationError::new(
                    "route_config.default",
                    "default must be a JSON object or null",
                )
            })?;
            rewrite_route_transition(
                default.get_mut("transition"),
                refs,
                "route_config.default.transition".to_string(),
            )?;
        }
        _ => {}
    }
    Ok(result)
}

fn rewrite_route_transition(
    transition: Option<&mut Value>,
    refs: &RouteTargetRefs,
    path: String,
) -> Result<(), ManifestValidationError> {
    let transition = transition.ok_or_else(|| {
        ManifestValidationError::new(path.clone(), "route transition is required")
    })?;
    let transition = transition.as_object_mut().ok_or_else(|| {
        ManifestValidationError::new(path.clone(), "transition must be a JSON object")
    })?;
    let transition_type = transition
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ManifestValidationError::new(format!("{path}.type"), "type must be a string")
        })?;

    match transition_type {
        "intra_workflow" => rewrite_target(
            transition,
            "step_id",
            "step_ref",
            &refs.step_refs,
            format!("{path}.step_id"),
        ),
        "inter_workflow" => {
            if transition.contains_key("step_id") {
                return Err(ManifestValidationError::new(
                    format!("{path}.step_id"),
                    "inter_workflow targets do not support step_id",
                ));
            }
            rewrite_target(
                transition,
                "workflow_id",
                "workflow_ref",
                &refs.workflow_refs,
                format!("{path}.workflow_id"),
            )?;
            Ok(())
        }
        other => Err(ManifestValidationError::new(
            format!("{path}.type"),
            format!("unsupported route transition type {other:?}"),
        )),
    }
}

fn rewrite_target(
    transition: &mut Map<String, Value>,
    source_key: &str,
    destination_key: &str,
    refs: &BTreeMap<String, String>,
    path: String,
) -> Result<(), ManifestValidationError> {
    let source = transition.remove(source_key).ok_or_else(|| {
        ManifestValidationError::new(path.clone(), format!("{source_key} is required"))
    })?;
    let source = source.as_str().ok_or_else(|| {
        ManifestValidationError::new(path.clone(), format!("{source_key} must be a string"))
    })?;
    let reference = refs.get(source).ok_or_else(|| {
        ManifestValidationError::new(path, format!("unresolved persisted target ref {source:?}"))
    })?;
    transition.insert(
        destination_key.to_string(),
        Value::String(reference.clone()),
    );
    Ok(())
}

pub(super) fn validate_route_config(
    route_config: &Value,
    workflow_ref: &str,
    local_steps: &BTreeMap<String, usize>,
    workflows: &BTreeMap<String, usize>,
    outgoing_steps: Option<&BTreeSet<StepAddress>>,
    outgoing_workflows: &BTreeSet<(String, String)>,
    path: String,
) -> Result<(), ManifestValidationError> {
    let object = route_config.as_object().ok_or_else(|| {
        ManifestValidationError::new(path.clone(), "route_config must be a JSON object")
    })?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(ManifestValidationError::new(
            format!("{path}.version"),
            "route_config version 1 is required",
        ));
    }
    if object.get("match_policy").and_then(Value::as_str) != Some("exactly_one") {
        return Err(ManifestValidationError::new(
            format!("{path}.match_policy"),
            "match_policy exactly_one is required",
        ));
    }
    let rules = object
        .get("rules")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ManifestValidationError::new(format!("{path}.rules"), "rules must be a non-empty array")
        })?;
    if rules.is_empty() {
        return Err(ManifestValidationError::new(
            format!("{path}.rules"),
            "rules must be a non-empty array",
        ));
    }
    let mut rule_ids = BTreeSet::new();
    for (index, rule) in rules.iter().enumerate() {
        let rule_path = format!("{path}.rules[{index}]");
        let rule = rule.as_object().ok_or_else(|| {
            ManifestValidationError::new(rule_path.clone(), "rule must be an object")
        })?;
        let rule_id = rule.get("id").and_then(Value::as_str).ok_or_else(|| {
            ManifestValidationError::new(format!("{rule_path}.id"), "rule id must be a string")
        })?;
        if rule_id.is_empty() || !rule_ids.insert(rule_id) {
            return Err(ManifestValidationError::new(
                format!("{rule_path}.id"),
                "rule id must be non-empty and unique",
            ));
        }
        if !rule.contains_key("when") {
            return Err(ManifestValidationError::new(
                format!("{rule_path}.when"),
                "rule condition is required",
            ));
        }
        validate_route_transition(
            rule.get("transition"),
            workflow_ref,
            local_steps,
            workflows,
            outgoing_steps,
            outgoing_workflows,
            format!("{rule_path}.transition"),
        )?;
    }
    match object.get("default") {
        Some(default) if !default.is_null() => {
            let default = default.as_object().ok_or_else(|| {
                ManifestValidationError::new(format!("{path}.default"), "default must be an object")
            })?;
            validate_route_transition(
                default.get("transition"),
                workflow_ref,
                local_steps,
                workflows,
                outgoing_steps,
                outgoing_workflows,
                format!("{path}.default.transition"),
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn validate_route_transition(
    transition: Option<&Value>,
    workflow_ref: &str,
    local_steps: &BTreeMap<String, usize>,
    workflows: &BTreeMap<String, usize>,
    outgoing_steps: Option<&BTreeSet<StepAddress>>,
    outgoing_workflows: &BTreeSet<(String, String)>,
    path: String,
) -> Result<(), ManifestValidationError> {
    let transition = transition.ok_or_else(|| {
        ManifestValidationError::new(path.clone(), "route transition is required")
    })?;
    let transition = transition.as_object().ok_or_else(|| {
        ManifestValidationError::new(path.clone(), "transition must be a JSON object")
    })?;
    match transition.get("type").and_then(Value::as_str) {
        Some("intra_workflow") => {
            if transition.contains_key("workflow_id") {
                return Err(ManifestValidationError::new(
                    format!("{path}.workflow_id"),
                    "persisted workflow_id is not portable; use workflow_ref",
                ));
            }
            if transition.contains_key("step_id") {
                return Err(ManifestValidationError::new(
                    format!("{path}.step_id"),
                    "persisted step_id is not portable; use step_ref",
                ));
            }
            let step_ref = transition
                .get("step_ref")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ManifestValidationError::new(
                        format!("{path}.step_ref"),
                        "symbolic step_ref is required",
                    )
                })?;
            if !local_steps.contains_key(step_ref) {
                return Err(ManifestValidationError::new(
                    format!("{path}.step_ref"),
                    format!("unresolved step ref {step_ref:?} in workflow {workflow_ref:?}"),
                ));
            }
            if !outgoing_steps
                .is_some_and(|targets| targets.contains(&StepAddress::new(workflow_ref, step_ref)))
            {
                return Err(ManifestValidationError::new(
                    format!("{path}.step_ref"),
                    format!("route target {step_ref:?} is not an outgoing step edge"),
                ));
            }
        }
        Some("inter_workflow") => {
            if transition.contains_key("workflow_id") {
                return Err(ManifestValidationError::new(
                    format!("{path}.workflow_id"),
                    "persisted workflow_id is not portable; use workflow_ref",
                ));
            }
            let destination_workflow = transition
                .get("workflow_ref")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ManifestValidationError::new(
                        format!("{path}.workflow_ref"),
                        "symbolic workflow_ref is required",
                    )
                })?;
            if !workflows.contains_key(destination_workflow) {
                return Err(ManifestValidationError::new(
                    format!("{path}.workflow_ref"),
                    format!("unresolved workflow ref {destination_workflow:?}"),
                ));
            }
            if !outgoing_workflows
                .contains(&(workflow_ref.to_string(), destination_workflow.into()))
            {
                return Err(ManifestValidationError::new(
                    format!("{path}.workflow_ref"),
                    format!(
                        "route target {destination_workflow:?} is not an outgoing workflow edge"
                    ),
                ));
            }
        }
        Some(other) => {
            return Err(ManifestValidationError::new(
                format!("{path}.type"),
                format!("unsupported route transition type {other:?}"),
            ));
        }
        None => {
            return Err(ManifestValidationError::new(
                format!("{path}.type"),
                "route transition type is required",
            ));
        }
    }
    Ok(())
}
