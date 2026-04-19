//! Schema validation for a step's structured output.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaValidationError {
    pub instance_path: String,
    pub schema_path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SchemaError {
    MissingOutput,
    InvalidJson(String),
    SchemaViolation(Vec<SchemaValidationError>),
    SchemaCompile(String),
}

impl SchemaError {
    pub fn summary(&self) -> String {
        match self {
            SchemaError::MissingOutput => {
                "step declared output_schema but produced no JSON output".to_string()
            }
            SchemaError::InvalidJson(msg) => {
                format!("step output contained a JSON fence with invalid JSON: {msg}")
            }
            SchemaError::SchemaViolation(errors) => {
                let count = errors.len();
                let first = errors
                    .first()
                    .map(|e| {
                        format!(
                            " (first: {} at {})",
                            e.message,
                            pretty_path(&e.instance_path)
                        )
                    })
                    .unwrap_or_default();
                format!("step output violated output_schema ({count} error(s)){first}")
            }
            SchemaError::SchemaCompile(msg) => {
                format!("output_schema is malformed and could not be compiled: {msg}")
            }
        }
    }
}

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary())
    }
}

fn pretty_path(path: &str) -> &str {
    if path.is_empty() { "/" } else { path }
}

pub struct CompiledSchema {
    validator: jsonschema::Validator,
}

impl CompiledSchema {
    pub fn compile(schema: &serde_json::Value) -> Result<Self, SchemaError> {
        jsonschema::validator_for(schema)
            .map(|validator| Self { validator })
            .map_err(|e| SchemaError::SchemaCompile(e.to_string()))
    }

    pub fn validate_output(&self, output: Option<&str>) -> Result<(), SchemaError> {
        let text = output.map(str::trim).filter(|s| !s.is_empty());
        let Some(text) = text else {
            return Err(SchemaError::MissingOutput);
        };

        let Some(json_text) = extract_fenced_json(text) else {
            return Err(SchemaError::MissingOutput);
        };

        let instance: serde_json::Value =
            serde_json::from_str(json_text).map_err(|e| SchemaError::InvalidJson(e.to_string()))?;

        if self.validator.is_valid(&instance) {
            return Ok(());
        }

        let errors: Vec<SchemaValidationError> = self
            .validator
            .iter_errors(&instance)
            .map(|err| SchemaValidationError {
                instance_path: err.instance_path.to_string(),
                schema_path: err.schema_path.to_string(),
                message: err.to_string(),
            })
            .collect();

        Err(SchemaError::SchemaViolation(errors))
    }
}

impl std::fmt::Debug for CompiledSchema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompiledSchema").finish_non_exhaustive()
    }
}

/// Returns the inner content of the **last** ```` ```json ``` ```` fenced block.
///
/// LLMs frequently emit an illustrative `json` block earlier in prose and the
/// real answer last; picking the final block is the most forgiving rule that
/// still selects the answer. A bare ```` ``` ```` fence without the `json`
/// language tag is ignored — too ambiguous (could wrap YAML, shell, Markdown).
/// Both fences must sit at a line start. Language tag match is case-insensitive.
pub fn extract_fenced_json(text: &str) -> Option<&str> {
    let mut last: Option<&str> = None;
    let mut cursor = 0usize;

    while cursor < text.len() {
        let Some(rel_idx) = text[cursor..].find("```") else {
            break;
        };
        let open_idx = cursor + rel_idx;

        let at_line_start = open_idx == 0 || text.as_bytes()[open_idx - 1] == b'\n';
        if !at_line_start {
            cursor = open_idx + 3;
            continue;
        }

        let after_backticks = open_idx + 3;
        let line_end = text[after_backticks..]
            .find('\n')
            .map(|i| after_backticks + i)
            .unwrap_or(text.len());
        let lang = text[after_backticks..line_end].trim();

        if !lang.eq_ignore_ascii_case("json") {
            cursor = line_end + 1;
            continue;
        }

        let content_start = if line_end < text.len() {
            line_end + 1
        } else {
            line_end
        };

        let Some(close_idx) = find_closing_fence(text, content_start) else {
            cursor = content_start;
            continue;
        };

        last = Some(text[content_start..close_idx].trim_matches('\n'));

        cursor = text[close_idx..]
            .find('\n')
            .map(|i| close_idx + i + 1)
            .unwrap_or(text.len());
    }

    last
}

fn find_closing_fence(text: &str, from: usize) -> Option<usize> {
    let mut search = from;
    while search < text.len() {
        let rel = text[search..].find("```")?;
        let idx = search + rel;
        let at_line_start = idx == 0 || text.as_bytes()[idx - 1] == b'\n';
        if at_line_start {
            return Some(idx);
        }
        search = idx + 3;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ----- extract_fenced_json -----

    #[test]
    fn extract_returns_inner_content_of_fenced_block() {
        let text = "Here you go:\n```json\n{\"a\":1}\n```\nThanks!";
        assert_eq!(extract_fenced_json(text), Some("{\"a\":1}"));
    }

    #[test]
    fn extract_picks_last_block_when_multiple_are_present() {
        let text =
            "Example:\n```json\n{\"example\":true}\n```\nActual:\n```json\n{\"final\":42}\n```\n";
        assert_eq!(extract_fenced_json(text), Some("{\"final\":42}"));
    }

    #[test]
    fn extract_is_case_insensitive_for_language_tag() {
        let text = "```JSON\n{\"x\":1}\n```\n";
        assert_eq!(extract_fenced_json(text), Some("{\"x\":1}"));
    }

    #[test]
    fn extract_ignores_bare_fences_without_json_tag() {
        let text = "```\n{\"a\":1}\n```\n";
        assert_eq!(extract_fenced_json(text), None);
    }

    #[test]
    fn extract_ignores_fences_with_other_language_tags() {
        let text = "```yaml\nfoo: bar\n```\n```python\nprint('hi')\n```\n";
        assert_eq!(extract_fenced_json(text), None);
    }

    #[test]
    fn extract_returns_none_when_fence_has_no_closing() {
        let text = "```json\n{\"a\":1}\n";
        assert_eq!(extract_fenced_json(text), None);
    }

    #[test]
    fn extract_skips_inline_backticks_not_at_line_start() {
        let text = "Inline code: `x = ```json` something\nand then:\n```json\n{\"ok\":true}\n```";
        assert_eq!(extract_fenced_json(text), Some("{\"ok\":true}"));
    }

    #[test]
    fn extract_preserves_interior_whitespace_and_newlines() {
        let text = "```json\n{\n  \"a\": 1,\n  \"b\": [\n    2,\n    3\n  ]\n}\n```";
        let inner = extract_fenced_json(text).expect("should extract");
        assert!(inner.starts_with("{\n  \"a\""));
        assert!(inner.ends_with("]\n}"));
    }

    #[test]
    fn extract_handles_fence_at_start_of_input() {
        let text = "```json\n{\"v\":5}\n```";
        assert_eq!(extract_fenced_json(text), Some("{\"v\":5}"));
    }

    #[test]
    fn extract_returns_none_for_empty_input() {
        assert_eq!(extract_fenced_json(""), None);
    }

    #[test]
    fn extract_returns_none_when_no_fence_present() {
        assert_eq!(
            extract_fenced_json("plain prose with {\"json\":true}"),
            None
        );
    }

    // ----- CompiledSchema::compile -----

    #[test]
    fn compile_succeeds_for_well_formed_schema() {
        let schema = json!({
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"]
        });
        assert!(CompiledSchema::compile(&schema).is_ok());
    }

    #[test]
    fn compile_fails_for_malformed_schema() {
        // `type` must be a string or array of strings; an object is invalid.
        let schema = json!({"type": {"nested": "wrong"}});
        let err = CompiledSchema::compile(&schema).expect_err("should fail");
        match err {
            SchemaError::SchemaCompile(msg) => {
                assert!(!msg.is_empty(), "compile error message should not be empty")
            }
            other => panic!("expected SchemaCompile, got {other:?}"),
        }
    }

    // ----- validate_output flow -----

    fn compiled() -> CompiledSchema {
        let schema = json!({
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "passed": {"type": "boolean"}
            },
            "required": ["summary", "passed"]
        });
        CompiledSchema::compile(&schema).expect("schema must compile")
    }

    #[test]
    fn validate_passes_for_conforming_output() {
        let schema = compiled();
        let text = "All good.\n```json\n{\"summary\":\"done\",\"passed\":true}\n```";
        assert_eq!(schema.validate_output(Some(text)), Ok(()));
    }

    #[test]
    fn validate_passes_with_prose_on_both_sides_of_fence() {
        let schema = compiled();
        let text = "Here is my answer after analysis:\n\n```json\n{\"summary\":\"ok\",\"passed\":true}\n```\n\nLet me know if you need more.";
        assert_eq!(schema.validate_output(Some(text)), Ok(()));
    }

    #[test]
    fn validate_missing_output_when_none() {
        let schema = compiled();
        let err = schema
            .validate_output(None)
            .expect_err("None output should fail");
        assert_eq!(err, SchemaError::MissingOutput);
    }

    #[test]
    fn validate_missing_output_when_empty_string() {
        let schema = compiled();
        assert_eq!(
            schema.validate_output(Some("")),
            Err(SchemaError::MissingOutput)
        );
        assert_eq!(
            schema.validate_output(Some("   \n  \t")),
            Err(SchemaError::MissingOutput)
        );
    }

    #[test]
    fn validate_missing_output_when_no_fence_present() {
        let schema = compiled();
        let text = "I did the thing but forgot to format my answer as JSON.";
        assert_eq!(
            schema.validate_output(Some(text)),
            Err(SchemaError::MissingOutput)
        );
    }

    #[test]
    fn validate_invalid_json_when_fence_content_is_malformed() {
        let schema = compiled();
        let text = "```json\n{not valid json}\n```";
        match schema.validate_output(Some(text)) {
            Err(SchemaError::InvalidJson(msg)) => {
                assert!(!msg.is_empty(), "invalid-json error should carry a message")
            }
            other => panic!("expected InvalidJson, got {other:?}"),
        }
    }

    #[test]
    fn validate_schema_violation_preserves_instance_path_and_message() {
        let schema = compiled();
        // summary must be a string, passed must be boolean — we give the wrong types.
        let text = "```json\n{\"summary\":42,\"passed\":\"yes\"}\n```";
        match schema.validate_output(Some(text)) {
            Err(SchemaError::SchemaViolation(errors)) => {
                assert!(
                    errors.len() >= 2,
                    "expected at least 2 errors, got {}",
                    errors.len()
                );
                let paths: Vec<&str> = errors.iter().map(|e| e.instance_path.as_str()).collect();
                assert!(
                    paths.iter().any(|p| p.contains("summary")),
                    "expected a path mentioning `summary`, got: {paths:?}"
                );
                assert!(
                    paths.iter().any(|p| p.contains("passed")),
                    "expected a path mentioning `passed`, got: {paths:?}"
                );
                for err in &errors {
                    assert!(!err.message.is_empty(), "message should not be empty");
                }
            }
            other => panic!("expected SchemaViolation, got {other:?}"),
        }
    }

    #[test]
    fn validate_schema_violation_on_missing_required_field() {
        let schema = compiled();
        let text = "```json\n{\"summary\":\"hello\"}\n```";
        match schema.validate_output(Some(text)) {
            Err(SchemaError::SchemaViolation(errors)) => {
                assert!(!errors.is_empty(), "expected at least one error");
                assert!(
                    errors
                        .iter()
                        .any(|e| e.message.to_lowercase().contains("passed")
                            || e.message.to_lowercase().contains("required")),
                    "expected an error mentioning the missing field, got: {:?}",
                    errors
                );
            }
            other => panic!("expected SchemaViolation, got {other:?}"),
        }
    }

    // ----- SchemaError helpers -----

    #[test]
    fn schema_error_summary_missing_output() {
        let err = SchemaError::MissingOutput;
        let s = err.summary();
        assert!(s.contains("no JSON output"));
    }

    #[test]
    fn schema_error_summary_invalid_json_includes_cause() {
        let err = SchemaError::InvalidJson("expected value at line 1".to_string());
        let s = err.summary();
        assert!(s.contains("invalid JSON"));
        assert!(s.contains("expected value at line 1"));
    }

    #[test]
    fn schema_error_summary_schema_violation_includes_count_and_first() {
        let err = SchemaError::SchemaViolation(vec![
            SchemaValidationError {
                instance_path: "/summary".to_string(),
                schema_path: "/properties/summary/type".to_string(),
                message: "42 is not of type \"string\"".to_string(),
            },
            SchemaValidationError {
                instance_path: "/passed".to_string(),
                schema_path: "/properties/passed/type".to_string(),
                message: "\"yes\" is not of type \"boolean\"".to_string(),
            },
        ]);
        let s = err.summary();
        assert!(s.contains("2 error"));
        assert!(s.contains("42 is not of type"));
        assert!(s.contains("/summary"));
    }

    #[test]
    fn schema_error_summary_schema_compile_includes_cause() {
        let err = SchemaError::SchemaCompile("invalid type".to_string());
        assert!(err.summary().contains("malformed"));
        assert!(err.summary().contains("invalid type"));
    }

    #[test]
    fn schema_validation_error_is_serde_round_trippable() {
        let e = SchemaValidationError {
            instance_path: "/items/0/id".to_string(),
            schema_path: "/properties/items/items/properties/id/type".to_string(),
            message: "null is not of type \"string\"".to_string(),
        };
        let json = serde_json::to_string(&e).expect("serialize");
        let parsed: SchemaValidationError = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, e);
    }

    #[test]
    fn display_trait_for_schema_error_matches_summary() {
        let err = SchemaError::MissingOutput;
        assert_eq!(format!("{err}"), err.summary());
    }
}
