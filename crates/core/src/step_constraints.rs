//! Client-side validation of step config fields against the step type.
//!
//! Sacrum validates every step mutation; this mirrors its config-key rule so
//! a client can reject a field the step type does not declare before sending.

use crate::error::{ServiceError, ServiceResult};
use crate::models::{Step, StepConfig, StepType};

/// Reject config fields that `step_type` does not declare, using Sacrum's
/// error wording.
pub fn validate_config_fields<'a>(
    step_type: &StepType,
    fields: impl IntoIterator<Item = &'a str>,
) -> ServiceResult<()> {
    let mut fields = fields.into_iter().peekable();
    if fields.peek().is_none() {
        return Ok(());
    }

    let Some(declared) = step_type.config_fields() else {
        return Err(ServiceError::validation_failed(format!(
            "config: must be null for {step_type} steps"
        )));
    };

    if let Some(field) = fields.find(|field| !declared.contains(field)) {
        return Err(ServiceError::validation_failed(format!(
            "config: $.{field}: is not supported for {step_type} steps"
        )));
    }

    Ok(())
}

/// Validate a new step's config against its type, as Sacrum does on create.
pub fn validate_step_config(step: &Step) -> ServiceResult<()> {
    let config = step
        .config
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|e| ServiceError::validation_failed(format!("config: {e}")))?;
    match config {
        Some(serde_json::Value::Object(fields)) => validate_config_fields(
            &step.step_type,
            fields
                .keys()
                .map(String::as_str)
                .filter(|key| *key != "version"),
        ),
        _ => Ok(()),
    }
}

/// Apply a partial config patch the way Sacrum does: undeclared fields are
/// rejected, sent fields replace the stored values, and `null` clears one.
pub fn apply_config_patch(
    step: &mut Step,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> ServiceResult<()> {
    validate_config_fields(&step.step_type, patch.keys().map(String::as_str))?;
    let Some(config) = &step.config else {
        return Ok(());
    };

    let mut merged = serde_json::to_value(config)
        .map_err(|e| ServiceError::validation_failed(format!("config: {e}")))?;
    if let serde_json::Value::Object(fields) = &mut merged {
        fields.extend(patch.clone());
    }
    step.config = StepConfig::from_value(&step.step_type, merged)
        .map_err(|e| ServiceError::validation_failed(format!("config: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_declared_fields() {
        assert!(validate_config_fields(&StepType::LlmInference, ["prompt", "skills"]).is_ok());
        assert!(validate_config_fields(&StepType::Route, ["route_config"]).is_ok());
        assert!(validate_config_fields(&StepType::WaitChildren, ["output_schema"]).is_ok());
        assert!(validate_config_fields(&StepType::Finish, []).is_ok());
    }

    #[test]
    fn rejects_undeclared_fields() {
        let error = validate_config_fields(&StepType::Route, ["route_config", "prompt"])
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("config: $.prompt: is not supported for route steps"),
            "{error}"
        );

        let error = validate_config_fields(&StepType::WaitChildren, ["agents"])
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("$.agents: is not supported for wait_children steps"),
            "{error}"
        );
    }

    #[test]
    fn apply_config_patch_writes_only_sent_fields() {
        let mut step = Step::new("s", "wf")
            .with_prompt("keep")
            .with_skills(vec!["a".to_string()]);
        let patch = serde_json::json!({"skills": ["b"], "output_schema": null});
        apply_config_patch(&mut step, patch.as_object().unwrap()).unwrap();
        assert_eq!(step.prompt(), Some("keep"));
        assert_eq!(step.skills(), ["b"]);
        assert_eq!(step.output_schema(), None);

        let patch = serde_json::json!({"route_config": {"version": 1}});
        assert!(apply_config_patch(&mut step, patch.as_object().unwrap()).is_err());
        assert_eq!(step.prompt(), Some("keep"));
    }

    #[test]
    fn rejects_any_field_for_config_less_types() {
        for step_type in [StepType::HumanInput, StepType::Stop, StepType::Finish] {
            let error = validate_config_fields(&step_type, ["prompt"])
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(&format!("config: must be null for {step_type} steps")),
                "{error}"
            );
        }
    }
}
