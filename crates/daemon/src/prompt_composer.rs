//! Prompt composer for building rich prompts from step execution context.
//!
//! Composes a structured prompt that gives Claude Code the full picture of what
//! it needs to do, including:
//! - The step's primary instruction (prompt field, falling back to goal)
//! - Task context (title, description, sections, code refs)
//! - Workflow context (step name, whether it is final, available transitions)

use crate::actors::project_supervisor::RunStepPayload;
use vertebrae_core::models::SectionType;

/// Compose a rich prompt from a RunStepPayload.
///
/// Priority for the primary instruction:
/// 1. `prompt` field (step-level prompt configured in Sacrum)
/// 2. `goal` field (step goal)
/// 3. Fallback: "Execute step: {step_name}"
///
/// The composed prompt includes task context and workflow context when available.
pub fn compose_prompt(payload: &RunStepPayload) -> String {
    let mut parts: Vec<String> = Vec::new();

    // Primary instruction: prompt > goal > fallback.
    // Filter out empty strings so an empty prompt falls back to goal.
    let instruction = payload
        .prompt
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(payload.goal.as_deref().filter(|s| !s.is_empty()));

    let instruction = match instruction {
        Some(s) => s.to_string(),
        None => format!("Execute step: {}", payload.step_name),
    };

    parts.push(instruction);

    // Task context from the execution context field
    if let Some(context) = &payload.context
        && let Some(context_str) = format_task_context(context)
    {
        parts.push(context_str);
    }

    // Workflow context (always present — includes step name at minimum)
    parts.push(format_workflow_context(payload));

    parts.join("\n\n")
}

/// Format task context from the execution context JSON value.
///
/// Expected structure:
/// ```json
/// {
///   "title": "Task title",
///   "description": "Task description",
///   "sections": [
///     {"type": "checklist_item", "content": "...", "done": false},
///     {"type": "testing_criterion", "content": "...", "refs": [...]}
///   ],
///   "code_refs": [
///     {"path": "src/main.rs", "line_start": 10, "line_end": 20, "name": "main"}
///   ]
/// }
/// ```
fn format_task_context(context: &serde_json::Value) -> Option<String> {
    let obj = context.as_object()?;

    // Skip if context is empty
    if obj.is_empty() {
        return None;
    }

    let mut lines: Vec<String> = Vec::new();
    lines.push("## Task Context".to_string());

    if let Some(title) = obj.get("title").and_then(|v| v.as_str())
        && !title.is_empty()
    {
        lines.push(format!("**Title:** {title}"));
    }

    if let Some(description) = obj.get("description").and_then(|v| v.as_str())
        && !description.is_empty()
    {
        lines.push(format!("\n**Description:**\n{description}"));
    }

    if let Some(sections) = obj.get("sections").and_then(|v| v.as_array())
        && !sections.is_empty()
    {
        let sections_str = format_sections(sections);
        if !sections_str.is_empty() {
            lines.push(sections_str);
        }
    }

    if let Some(code_refs) = obj.get("code_refs").and_then(|v| v.as_array())
        && !code_refs.is_empty()
    {
        let refs_str = format_code_refs(code_refs);
        if !refs_str.is_empty() {
            lines.push(refs_str);
        }
    }

    // Only return if we have more than the header
    if lines.len() > 1 {
        Some(lines.join("\n"))
    } else {
        None
    }
}

/// Format sections grouped by type.
fn format_sections(sections: &[serde_json::Value]) -> String {
    let mut checklist_items: Vec<String> = Vec::new();
    let mut testing_criteria: Vec<String> = Vec::new();
    let mut constraints: Vec<String> = Vec::new();
    let mut other_sections: Vec<(String, String)> = Vec::new();

    for section in sections {
        let section_type = section
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let content = section
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if content.is_empty() {
            continue;
        }

        match section_type.parse::<SectionType>() {
            Ok(SectionType::ChecklistItem) => {
                let done = section
                    .get("done")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let marker = if done { "[x]" } else { "[ ]" };
                checklist_items.push(format!("- {marker} {content}"));
            }
            Ok(SectionType::TestingCriterion) => {
                testing_criteria.push(format!("- {content}"));
            }
            Ok(SectionType::Constraint) => {
                constraints.push(format!("- {content}"));
            }
            Ok(_) => {
                let label = section_type.replace('_', " ");
                other_sections.push((label, content.to_string()));
            }
            Err(_) => {
                other_sections.push((section_type.to_string(), content.to_string()));
            }
        }
    }

    let mut parts: Vec<String> = Vec::new();

    for (label, content) in &other_sections {
        let capitalized = capitalize_first(label);
        parts.push(format!("\n**{capitalized}:**\n{content}"));
    }

    if !checklist_items.is_empty() {
        parts.push(format!("\n**Checklist:**\n{}", checklist_items.join("\n")));
    }

    if !testing_criteria.is_empty() {
        parts.push(format!(
            "\n**Testing Criteria:**\n{}",
            testing_criteria.join("\n")
        ));
    }

    if !constraints.is_empty() {
        parts.push(format!("\n**Constraints:**\n{}", constraints.join("\n")));
    }

    parts.join("\n")
}

/// Format code references into a readable list.
fn format_code_refs(refs: &[serde_json::Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("\n**Code References:**".to_string());

    for r in refs {
        let path = r.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            continue;
        }

        let mut location = path.to_string();
        if let Some(start) = r.get("line_start").and_then(|v| v.as_u64()) {
            if let Some(end) = r.get("line_end").and_then(|v| v.as_u64()) {
                location = format!("{path}:L{start}-L{end}");
            } else {
                location = format!("{path}:L{start}");
            }
        }

        let name = r.get("name").and_then(|v| v.as_str());
        if let Some(name) = name {
            lines.push(format!("- `{location}` ({name})"));
        } else {
            lines.push(format!("- `{location}`"));
        }
    }

    if lines.len() > 1 {
        lines.join("\n")
    } else {
        String::new()
    }
}

/// Format workflow context from the payload.
fn format_workflow_context(payload: &RunStepPayload) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("## Workflow Context".to_string());
    lines.push(format!("**Step:** {}", payload.step_name));

    if payload.is_final {
        lines.push("**Note:** This is the final step in the workflow.".to_string());
    }

    if !payload.transitions_to.is_empty() {
        lines.push(format!(
            "**Available transitions:** {}",
            payload.transitions_to.join(", ")
        ));
    }

    lines.join("\n")
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_payload() -> RunStepPayload {
        RunStepPayload {
            id: "exec-1".to_string(),
            task_id: "task-1".to_string(),
            workflow_id: "wf-1".to_string(),
            step_name: "implement".to_string(),
            status: "pending".to_string(),
            goal: None,
            prompt: None,
            eval_prompt: None,
            context: None,
            agents: Vec::new(),
            skills: Vec::new(),
            agent_config: serde_json::Value::Null,
            is_final: false,
            transitions_to: Vec::new(),
            auto_advance: false,
        }
    }

    #[test]
    fn compose_prompt_fallback_to_step_name() {
        let payload = minimal_payload();
        let result = compose_prompt(&payload);
        assert!(
            result.contains("Execute step: implement"),
            "Should fall back to step name when no prompt or goal. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_uses_goal_when_no_prompt() {
        let mut payload = minimal_payload();
        payload.goal = Some("Write the feature code".to_string());

        let result = compose_prompt(&payload);
        assert!(
            result.starts_with("Write the feature code"),
            "Should use goal as primary instruction. Got: {result}"
        );
        assert!(
            !result.contains("Execute step:"),
            "Should not contain fallback when goal is set"
        );
    }

    #[test]
    fn compose_prompt_prefers_prompt_over_goal() {
        let mut payload = minimal_payload();
        payload.goal = Some("Write the feature code".to_string());
        payload.prompt = Some("Implement the authentication module".to_string());

        let result = compose_prompt(&payload);
        assert!(
            result.starts_with("Implement the authentication module"),
            "Should prefer prompt over goal. Got: {result}"
        );
        assert!(
            !result.contains("Write the feature code"),
            "Should not contain goal when prompt is set"
        );
    }

    #[test]
    fn compose_prompt_empty_prompt_falls_back_to_goal() {
        let mut payload = minimal_payload();
        payload.prompt = Some(String::new());
        payload.goal = Some("Write tests".to_string());

        let result = compose_prompt(&payload);
        assert!(
            result.starts_with("Write tests"),
            "Empty prompt should fall back to goal. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_empty_prompt_and_goal_falls_back_to_step_name() {
        let mut payload = minimal_payload();
        payload.prompt = Some(String::new());
        payload.goal = Some(String::new());

        let result = compose_prompt(&payload);
        assert!(
            result.contains("Execute step: implement"),
            "Empty prompt and goal should fall back to step name. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_includes_workflow_context() {
        let payload = minimal_payload();
        let result = compose_prompt(&payload);
        assert!(
            result.contains("## Workflow Context"),
            "Should include workflow context section. Got: {result}"
        );
        assert!(
            result.contains("**Step:** implement"),
            "Should include step name. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_includes_final_step_note() {
        let mut payload = minimal_payload();
        payload.is_final = true;

        let result = compose_prompt(&payload);
        assert!(
            result.contains("This is the final step"),
            "Should note when step is final. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_includes_transitions() {
        let mut payload = minimal_payload();
        payload.transitions_to = vec!["step-2".to_string(), "step-3".to_string()];

        let result = compose_prompt(&payload);
        assert!(
            result.contains("step-2, step-3"),
            "Should list available transitions. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_includes_task_context_title() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "Fix authentication bug"
        }));

        let result = compose_prompt(&payload);
        assert!(
            result.contains("## Task Context"),
            "Should include task context header. Got: {result}"
        );
        assert!(
            result.contains("**Title:** Fix authentication bug"),
            "Should include task title. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_includes_task_description() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "Task",
            "description": "The auth module fails when tokens expire"
        }));

        let result = compose_prompt(&payload);
        assert!(
            result.contains("The auth module fails when tokens expire"),
            "Should include task description. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_includes_sections() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "Task",
            "sections": [
                {"type": "checklist_item", "content": "Add validation", "done": false},
                {"type": "checklist_item", "content": "Write tests", "done": true},
                {"type": "testing_criterion", "content": "All tests pass"},
                {"type": "constraint", "content": "Must be backwards compatible"}
            ]
        }));

        let result = compose_prompt(&payload);
        assert!(
            result.contains("- [ ] Add validation"),
            "Should include unchecked checklist item. Got: {result}"
        );
        assert!(
            result.contains("- [x] Write tests"),
            "Should include checked checklist item. Got: {result}"
        );
        assert!(
            result.contains("- All tests pass"),
            "Should include testing criterion. Got: {result}"
        );
        assert!(
            result.contains("- Must be backwards compatible"),
            "Should include constraint. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_includes_code_refs() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "Task",
            "code_refs": [
                {"path": "src/auth.rs", "line_start": 42, "line_end": 50, "name": "verify_token"},
                {"path": "src/main.rs", "line_start": 10}
            ]
        }));

        let result = compose_prompt(&payload);
        assert!(
            result.contains("`src/auth.rs:L42-L50` (verify_token)"),
            "Should format code ref with range and name. Got: {result}"
        );
        assert!(
            result.contains("`src/main.rs:L10`"),
            "Should format code ref with single line. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_skips_empty_context() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({}));

        let result = compose_prompt(&payload);
        assert!(
            !result.contains("## Task Context"),
            "Should skip task context when context object is empty. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_skips_null_context() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::Value::Null);

        let result = compose_prompt(&payload);
        assert!(
            !result.contains("## Task Context"),
            "Should skip task context when context is null. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_handles_context_with_empty_title() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "",
            "description": "Some description"
        }));

        let result = compose_prompt(&payload);
        assert!(
            !result.contains("**Title:**"),
            "Should skip empty title. Got: {result}"
        );
        assert!(
            result.contains("Some description"),
            "Should still include description. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_handles_sections_with_goal_type() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "Task",
            "sections": [
                {"type": "goal", "content": "Implement the feature"},
                {"type": "context", "content": "Background information here"}
            ]
        }));

        let result = compose_prompt(&payload);
        assert!(
            result.contains("**Goal:**\nImplement the feature"),
            "Should format goal section. Got: {result}"
        );
        assert!(
            result.contains("**Context:**\nBackground information here"),
            "Should format context section. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_skips_sections_with_empty_content() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "Task",
            "sections": [
                {"type": "checklist_item", "content": ""},
                {"type": "checklist_item", "content": "Valid item"}
            ]
        }));

        let result = compose_prompt(&payload);
        assert!(
            result.contains("- [ ] Valid item"),
            "Should include non-empty items. Got: {result}"
        );
        // The empty item should not create a bare "- [ ] " line
        let lines: Vec<&str> = result.lines().collect();
        let checklist_lines: Vec<&&str> = lines.iter().filter(|l| l.contains("[ ]")).collect();
        assert_eq!(
            checklist_lines.len(),
            1,
            "Should have exactly one checklist item (skipping empty). Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_skips_code_refs_with_empty_path() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "Task",
            "code_refs": [
                {"path": "", "line_start": 10},
                {"path": "src/valid.rs", "line_start": 5}
            ]
        }));

        let result = compose_prompt(&payload);
        assert!(
            result.contains("`src/valid.rs:L5`"),
            "Should include valid ref. Got: {result}"
        );
        let ref_lines: Vec<&str> = result.lines().filter(|l| l.starts_with("- `")).collect();
        assert_eq!(
            ref_lines.len(),
            1,
            "Should have exactly one code ref (skipping empty path). Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_full_payload() {
        let mut payload = minimal_payload();
        payload.prompt = Some("Implement JWT token validation".to_string());
        payload.is_final = false;
        payload.transitions_to = vec!["review-step".to_string()];
        payload.context = Some(serde_json::json!({
            "title": "JWT Authentication",
            "description": "Add JWT token validation to the auth middleware",
            "sections": [
                {"type": "checklist_item", "content": "Parse JWT header", "done": true},
                {"type": "checklist_item", "content": "Validate signature", "done": false},
                {"type": "testing_criterion", "content": "Expired tokens are rejected"},
                {"type": "constraint", "content": "Must support RS256 and HS256"}
            ],
            "code_refs": [
                {"path": "src/auth/middleware.rs", "line_start": 15, "line_end": 30, "name": "validate"}
            ]
        }));

        let result = compose_prompt(&payload);

        // Primary instruction
        assert!(result.starts_with("Implement JWT token validation"));

        // Task context
        assert!(result.contains("## Task Context"));
        assert!(result.contains("**Title:** JWT Authentication"));
        assert!(result.contains("Add JWT token validation to the auth middleware"));
        assert!(result.contains("- [x] Parse JWT header"));
        assert!(result.contains("- [ ] Validate signature"));
        assert!(result.contains("- Expired tokens are rejected"));
        assert!(result.contains("- Must support RS256 and HS256"));
        assert!(result.contains("`src/auth/middleware.rs:L15-L30` (validate)"));

        // Workflow context
        assert!(result.contains("## Workflow Context"));
        assert!(result.contains("**Step:** implement"));
        assert!(result.contains("review-step"));
        assert!(!result.contains("final step"));
    }

    #[test]
    fn compose_prompt_code_ref_without_lines() {
        let mut payload = minimal_payload();
        payload.context = Some(serde_json::json!({
            "title": "Task",
            "code_refs": [
                {"path": "src/lib.rs"}
            ]
        }));

        let result = compose_prompt(&payload);
        assert!(
            result.contains("`src/lib.rs`"),
            "Should format code ref without line numbers. Got: {result}"
        );
    }

    #[test]
    fn compose_prompt_no_transitions_omits_line() {
        let payload = minimal_payload();
        let result = compose_prompt(&payload);
        assert!(
            !result.contains("Available transitions"),
            "Should omit transitions line when empty. Got: {result}"
        );
    }

    #[test]
    fn format_task_context_returns_none_for_non_object() {
        let value = serde_json::json!("just a string");
        assert!(format_task_context(&value).is_none());
    }

    #[test]
    fn format_task_context_returns_none_for_empty_object() {
        let value = serde_json::json!({});
        assert!(format_task_context(&value).is_none());
    }

    #[test]
    fn format_task_context_returns_none_for_only_empty_fields() {
        let value = serde_json::json!({
            "title": "",
            "description": ""
        });
        assert!(
            format_task_context(&value).is_none(),
            "Should return None when all fields are empty"
        );
    }

    #[test]
    fn capitalize_first_works() {
        assert_eq!(capitalize_first("hello"), "Hello");
        assert_eq!(capitalize_first(""), "");
        assert_eq!(capitalize_first("a"), "A");
        assert_eq!(capitalize_first("current behavior"), "Current behavior");
    }
}
