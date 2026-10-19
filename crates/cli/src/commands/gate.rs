//! `vtb gate`: answer a waiting `human_input` gate field by field.
//!
//! Each command reports the gate's durable draft as Sacrum computes it, so
//! whoever resolves the gate reads what is still needed and whether the draft
//! is complete instead of judging it.

use clap::{Args, Subcommand};
use serde_json::Value;
use vertebrae_core::{HumanInputDraft, ServiceError, VertebraeServices};

/// Draft commands for a waiting human_input gate.
#[derive(Debug, Subcommand)]
pub enum GateCommand {
    /// Record answers in the gate's draft (merge; a null value clears a field)
    Set(GateSetCommand),
    /// Show the gate's draft: answered fields and what is still needed
    Show(GateShowCommand),
    /// Resolve the gate from its complete draft
    Submit(GateSubmitCommand),
}

#[derive(Debug, Args)]
pub struct GateSetCommand {
    /// Waiting human_input step execution ID
    #[arg(value_parser = crate::commands::parse_full_uuid("execution ID"))]
    pub execution_id: String,
    /// JSON object of answers keyed by the gate's output_schema properties
    #[arg(long, value_name = "JSON")]
    pub values: String,
}

#[derive(Debug, Args)]
pub struct GateShowCommand {
    /// Waiting human_input step execution ID
    #[arg(value_parser = crate::commands::parse_full_uuid("execution ID"))]
    pub execution_id: String,
}

#[derive(Debug, Args)]
pub struct GateSubmitCommand {
    /// Waiting human_input step execution ID
    #[arg(value_parser = crate::commands::parse_full_uuid("execution ID"))]
    pub execution_id: String,
}

impl GateCommand {
    /// Run the command and return the draft Sacrum reports.
    pub async fn execute_result(
        &self,
        services: &VertebraeServices,
    ) -> Result<HumanInputDraft, ServiceError> {
        let executions = services.executions();
        match self {
            Self::Set(command) => {
                let values = parse_values(&command.values)?;
                executions
                    .set_human_input_draft(&command.execution_id, values)
                    .await
            }
            Self::Show(command) => executions.human_input_draft(&command.execution_id).await,
            Self::Submit(command) => {
                executions
                    .submit_human_input_draft(&command.execution_id)
                    .await
            }
        }
    }

    pub async fn execute(&self, services: &VertebraeServices) -> Result<String, ServiceError> {
        let draft = self.execute_result(services).await?;
        Ok(match self {
            Self::Submit(_) => format!(
                "Submitted the draft for execution {}; the gate is resolved and the run continues.",
                draft.execution_id
            ),
            Self::Set(_) | Self::Show(_) => format_draft(&draft),
        })
    }
}

fn parse_values(values: &str) -> Result<serde_json::Map<String, Value>, ServiceError> {
    match serde_json::from_str(values) {
        Ok(Value::Object(values)) => Ok(values),
        Ok(_) => Err(ServiceError::validation_failed(
            "--values must be a JSON object keyed by the gate's fields",
        )),
        Err(error) => Err(ServiceError::validation_failed(format!(
            "--values is not valid JSON: {error}"
        ))),
    }
}

/// Answered fields, invalid values with their paths, then what is still
/// needed or that the draft is complete.
pub(crate) fn format_draft(draft: &HumanInputDraft) -> String {
    let mut lines = Vec::new();
    if draft.values.is_empty() {
        lines.push("Answered: none yet".to_string());
    } else {
        lines.push("Answered:".to_string());
        lines.extend(
            draft
                .values
                .iter()
                .map(|(field, value)| format!("  {field}: {value}")),
        );
    }
    if !draft.invalid.is_empty() {
        lines.push("Invalid:".to_string());
        lines.extend(draft.invalid.iter().map(|violation| {
            let path = if violation.path.is_empty() {
                "(draft)"
            } else {
                violation.path.as_str()
            };
            format!("  {path}: {}", violation.message)
        }));
    }
    if draft.complete {
        lines.push("Complete — confirm with the user, then submit.".to_string());
    } else if draft.missing.is_empty() {
        lines.push("Not complete: fix the invalid fields above.".to_string());
    } else {
        lines.push(format!("Still needed: {}", draft.missing.join(", ")));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use serde_json::json;
    use vertebrae_core::HumanInputDraftViolation;

    #[derive(Parser)]
    struct TestCli {
        #[command(subcommand)]
        gate: GateCommand,
    }

    const EXECUTION: &str = "11111111-1111-4111-8111-111111111111";

    fn draft(values: Value, missing: &[&str], complete: bool) -> HumanInputDraft {
        HumanInputDraft {
            execution_id: EXECUTION.to_string(),
            values: values.as_object().cloned().unwrap_or_default(),
            missing: missing.iter().map(|field| field.to_string()).collect(),
            invalid: Vec::new(),
            complete,
            updated_at: None,
        }
    }

    #[test]
    fn set_takes_the_execution_and_a_values_object() {
        let cli = TestCli::parse_from(["test", "set", EXECUTION, "--values", r#"{"a":1}"#]);
        let GateCommand::Set(command) = cli.gate else {
            panic!("expected set");
        };
        assert_eq!(command.execution_id, EXECUTION);
        assert_eq!(
            parse_values(&command.values).unwrap()["a"],
            json!(1),
            "values parse as an object"
        );
    }

    #[test]
    fn commands_require_a_full_execution_uuid() {
        assert!(TestCli::try_parse_from(["test", "show", "a1b2c3d4"]).is_err());
        assert!(TestCli::try_parse_from(["test", "submit", "not-a-uuid"]).is_err());
        assert!(TestCli::try_parse_from(["test", "set", EXECUTION]).is_err());
    }

    #[test]
    fn values_must_be_a_json_object() {
        assert!(
            parse_values("[1]")
                .unwrap_err()
                .to_string()
                .contains("JSON object")
        );
        assert!(
            parse_values("{")
                .unwrap_err()
                .to_string()
                .contains("not valid JSON")
        );
        assert!(parse_values(r#"{"reason":null}"#).unwrap()["reason"].is_null());
    }

    #[test]
    fn an_incomplete_draft_lists_answers_then_what_is_still_needed() {
        let output = format_draft(&draft(
            json!({"approved": true}),
            &["reason", "channel"],
            false,
        ));
        assert_eq!(
            output,
            "Answered:\n  approved: true\nStill needed: reason, channel"
        );
    }

    #[test]
    fn an_empty_draft_says_nothing_is_answered() {
        let output = format_draft(&draft(json!({}), &["approved"], false));
        assert_eq!(output, "Answered: none yet\nStill needed: approved");
    }

    #[test]
    fn a_complete_draft_asks_for_confirmation_before_submitting() {
        let output = format_draft(&draft(
            json!({"approved": false, "reason": "no"}),
            &[],
            true,
        ));
        assert!(output.ends_with("Complete — confirm with the user, then submit."));
        assert!(output.contains("  reason: \"no\""));
    }

    #[test]
    fn invalid_values_are_listed_with_their_paths() {
        let mut invalid = draft(json!({"size": "xl"}), &[], false);
        invalid.invalid = vec![
            HumanInputDraftViolation {
                path: "/size".to_string(),
                message: "Value is not allowed in enum.".to_string(),
            },
            HumanInputDraftViolation {
                path: String::new(),
                message: "Expected exactly one of a, b.".to_string(),
            },
        ];
        let output = format_draft(&invalid);
        assert!(output.contains("Invalid:\n  /size: Value is not allowed in enum.\n  (draft): Expected exactly one of a, b."));
        assert!(output.ends_with("Not complete: fix the invalid fields above."));
    }
}
