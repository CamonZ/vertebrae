//! Output parsing utilities for workflow execution

use vertebrae_core::OrchestratorOutput;

/// Parse orchestrator output from streaming JSONL output
///
/// With `--output-format stream-json`, the output is JSONL (one JSON object per line).
/// The final line with `type: "result"` contains `structured_output` with our data.
pub fn parse_orchestrator_output(output: &str) -> Result<OrchestratorOutput, String> {
    log::info!("[WorkflowRunner] Parsing orchestrator streaming JSONL output");

    // Parse each line looking for the result line with structured_output
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Try to parse the line as JSON
        let json_value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // Skip non-JSON lines
        };

        // Check if this is the result line with structured_output
        if json_value.get("type").and_then(|v| v.as_str()) == Some("result") {
            if let Some(structured_output) = json_value.get("structured_output") {
                log::info!(
                    "[WorkflowRunner] Found structured_output in result line ({} chars)",
                    structured_output.to_string().len()
                );

                // Parse the structured_output directly as OrchestratorOutput
                return serde_json::from_value(structured_output.clone())
                    .map_err(|e| format!("Failed to parse structured_output: {}", e));
            }
        }
    }

    // Fallback: try parsing the entire output as JSON (for backwards compatibility)
    let trimmed = output.trim();
    if let Ok(result) = OrchestratorOutput::from_json(trimmed) {
        return Ok(result);
    }

    // Last resort: extract JSON object if there's extra content
    let json_start = trimmed.find('{');
    let json_end = trimmed.rfind('}');

    match (json_start, json_end) {
        (Some(start), Some(end)) if end > start => {
            let json_str = &trimmed[start..=end];
            log::info!(
                "[WorkflowRunner] Fallback: Extracted JSON ({} chars) from output",
                json_str.len()
            );
            OrchestratorOutput::from_json(json_str)
                .map_err(|e| format!("Failed to parse orchestrator JSON: {}", e))
        }
        _ => {
            Err("Orchestrator did not produce valid JSON output with structured_output".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_orchestrator_output_stream_json() {
        let output = r#"{"type":"init","session_id":"abc123"}
{"type":"text","content":"Thinking..."}
{"type":"result","structured_output":{"result":"Do the thing","goal":"Complete the task"}}
"#;

        let result = parse_orchestrator_output(output);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert_eq!(parsed.result, "Do the thing");
        assert_eq!(parsed.goal, Some("Complete the task".to_string()));
    }

    #[test]
    fn test_parse_orchestrator_output_stream_json_with_all_fields() {
        let output = r#"{"type":"result","structured_output":{"result":"Execute task","goal":"Complete goal","steps":["Step 1","Step 2"],"constraints":["No side effects"],"success_criteria":["Tests pass"]}}"#;

        let result = parse_orchestrator_output(output);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert_eq!(parsed.result, "Execute task");
        assert_eq!(parsed.goal, Some("Complete goal".to_string()));
        assert_eq!(parsed.steps, vec!["Step 1", "Step 2"]);
        assert_eq!(parsed.constraints, vec!["No side effects"]);
        assert_eq!(parsed.success_criteria, vec!["Tests pass"]);
    }

    #[test]
    fn test_parse_orchestrator_output_minimal_result_only() {
        let output = r#"{"result":"Just the prompt"}"#;

        let result = parse_orchestrator_output(output);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert_eq!(parsed.result, "Just the prompt");
        assert_eq!(parsed.goal, None);
        assert!(parsed.steps.is_empty());
        assert!(parsed.constraints.is_empty());
        assert!(parsed.success_criteria.is_empty());
    }

    #[test]
    fn test_parse_orchestrator_output_direct_json() {
        let output = r#"{"result":"Direct prompt","goal":"Direct goal"}"#;

        let result = parse_orchestrator_output(output);
        assert!(result.is_ok());
        let parsed = result.unwrap();
        assert_eq!(parsed.result, "Direct prompt");
    }

    #[test]
    fn test_parse_orchestrator_output_with_prefix() {
        let output = r#"Some debug output
{"result":"Embedded prompt","goal":"Embedded goal"}
More output"#;

        let result = parse_orchestrator_output(output);
        assert!(result.is_ok());
    }

    #[test]
    fn test_parse_orchestrator_output_with_whitespace() {
        let output = "   \n\n  {\"result\":\"Whitespace prompt\"}  \n\n  ";

        let result = parse_orchestrator_output(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().result, "Whitespace prompt");
    }

    #[test]
    fn test_parse_orchestrator_output_invalid() {
        let output = "This is not JSON at all";
        let result = parse_orchestrator_output(output);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_orchestrator_output_empty_string() {
        let result = parse_orchestrator_output("");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_orchestrator_output_missing_result_field() {
        let output = r#"{"goal":"Has goal but no result"}"#;
        let result = parse_orchestrator_output(output);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_orchestrator_output_ignores_non_result_lines() {
        let output = r#"{"type":"init","data":"ignored"}
{"type":"text","content":"also ignored"}
{"type":"result","structured_output":{"result":"Found it"}}"#;

        let result = parse_orchestrator_output(output);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().result, "Found it");
    }
}
