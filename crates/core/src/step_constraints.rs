//! Shared validation for workflow-step field coupling.
//!
//! Sacrum owns the semantics of a route configuration. Vertebrae owns the
//! cross-field rules that must hold before any client sends a step mutation.

use serde_json::Value;

use crate::error::ServiceResult;
use crate::models::{Step, StepType, StepUpdate};

/// Return the value represented by a nullable update field.
///
/// `None` means unchanged, while `Some(None)` clears the value and
/// `Some(Some(value))` replaces it.
pub fn resulting_option<'a, T>(
    write: &'a Option<Option<T>>,
    existing: Option<&'a T>,
) -> Option<&'a T> {
    match write {
        Some(value) => value.as_ref(),
        None => existing,
    }
}

/// Validate the Vertebrae-owned coupling between route fields.
///
/// Sacrum remains responsible for validating and evaluating the opaque route
/// configuration itself. This helper only enforces which fields can be
/// authored with the resulting step type. Legacy route rows may still expose
/// an old output schema; an update that does not write that field preserves it.
pub fn validate_route_fields(
    resulting_type: &StepType,
    prompt_write: bool,
    // Whether the update creates or replaces an output schema. Route steps
    // reject writes, but retained legacy values are not rewritten here.
    output_schema_write: bool,
    resulting_route_config: Option<&Value>,
) -> ServiceResult<()> {
    if matches!(resulting_type, StepType::Route) && prompt_write {
        return Err(crate::error::ServiceError::validation_failed(
            "route steps may only clear an existing prompt",
        ));
    }

    if matches!(resulting_type, StepType::Route) && output_schema_write {
        return Err(crate::error::ServiceError::validation_failed(
            "route steps do not accept output_schema; use route_config",
        ));
    }

    if !matches!(resulting_type, StepType::Route) && resulting_route_config.is_some() {
        return Err(crate::error::ServiceError::validation_failed(
            "route_config is only valid for route steps",
        ));
    }

    Ok(())
}

/// Validate route fields after merging an update with the existing step.
pub fn validate_route_update(existing: &Step, updates: &StepUpdate) -> ServiceResult<()> {
    let resulting_type = updates.step_type.as_ref().unwrap_or(&existing.step_type);
    let resulting_route_config =
        resulting_option(&updates.route_config, existing.route_config.as_ref());

    validate_route_fields(
        resulting_type,
        matches!(updates.prompt, Some(Some(_))),
        matches!(updates.output_schema, Some(Some(_))),
        resulting_route_config,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> Step {
        Step::new("router", "workflow").with_step_type(StepType::Route)
    }

    #[test]
    fn route_rejects_prompt_write_but_allows_clear() {
        let step = route().with_prompt("retained");

        assert!(validate_route_update(&step, &StepUpdate::new().with_prompt("new")).is_err());
        assert!(validate_route_update(&step, &StepUpdate::new().clear_prompt()).is_ok());
    }

    #[test]
    fn retained_prompt_does_not_affect_route_validation() {
        let step = route().with_prompt("retained");
        assert!(validate_route_update(&step, &StepUpdate::new()).is_ok());
    }

    #[test]
    fn route_rejects_output_schema_writes_but_allows_legacy_values() {
        let step = route();
        let schema = serde_json::json!({"type": "object"});

        assert!(
            validate_route_update(
                &step,
                &StepUpdate::new().with_output_schema(Some(schema.clone()))
            )
            .is_err()
        );

        let step = step.with_output_schema(schema);
        assert!(validate_route_update(&step, &StepUpdate::new()).is_ok());
        assert!(validate_route_update(&step, &StepUpdate::new().clear_prompt()).is_ok());
    }

    #[test]
    fn route_config_is_only_valid_for_routes() {
        let config = serde_json::json!({"version": 1});
        let route_step = route().with_route_config(config.clone());
        assert!(validate_route_update(&route_step, &StepUpdate::new()).is_ok());

        let execute_step = Step::new("execute", "workflow");
        assert!(
            validate_route_update(
                &execute_step,
                &StepUpdate::new().with_route_config(Some(config.clone()))
            )
            .is_err()
        );
        assert!(
            validate_route_update(
                &route_step,
                &StepUpdate::new()
                    .with_step_type(StepType::Execute)
                    .with_route_config(None)
            )
            .is_ok()
        );
    }

    #[test]
    fn resulting_option_distinguishes_unchanged_set_and_clear() {
        let existing = serde_json::json!("old");
        let replacement = serde_json::json!("new");

        assert_eq!(resulting_option(&None, Some(&existing)), Some(&existing));
        assert_eq!(
            resulting_option(&Some(Some(replacement.clone())), Some(&existing)),
            Some(&replacement)
        );
        assert_eq!(resulting_option(&Some(None), Some(&existing)), None);
    }
}
