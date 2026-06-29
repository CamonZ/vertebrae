use super::*;

#[test]
fn test_supported_claude_model_catalog_uses_aliases() {
    let catalog = supported_claude_model_catalog();

    assert_eq!(catalog.default_model_id, "sonnet");
    assert_eq!(
        catalog
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["sonnet", "opus", "haiku", "fable"]
    );
}

#[test]
fn test_resolve_requested_claude_model_accepts_supported_ids() {
    assert_eq!(
        resolve_requested_claude_model(Some(" Opus ".to_string()), false),
        ResolvedClaudeModel {
            model_id: Some("opus".to_string()),
            warning: None,
        }
    );
}

#[test]
fn test_resolve_requested_claude_model_omits_blank_selection() {
    assert_eq!(
        resolve_requested_claude_model(Some("   ".to_string()), false),
        ResolvedClaudeModel {
            model_id: None,
            warning: None,
        }
    );
}

#[test]
fn test_resolve_requested_claude_model_falls_back_with_warning() {
    let resolved = resolve_requested_claude_model(Some("claude-unknown".to_string()), false);

    assert_eq!(resolved.model_id.as_deref(), Some("sonnet"));
    assert!(resolved
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("claude-unknown")));
}

#[test]
fn test_resolve_requested_claude_model_escapes_warning_id() {
    let resolved = resolve_requested_claude_model(Some("Mystery\nINFO fake".to_string()), false);

    assert_eq!(resolved.model_id.as_deref(), Some("sonnet"));
    assert!(resolved
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("mystery\\ninfo fake")));
}

#[test]
fn test_resolve_requested_claude_model_omits_unsupported_model_on_resume() {
    let resolved = resolve_requested_claude_model(Some("retired".to_string()), true);

    assert_eq!(resolved.model_id, None);
    assert!(resolved
        .warning
        .as_deref()
        .is_some_and(|warning| warning.contains("original model")));
}

#[test]
fn test_build_claude_args_without_model_matches_existing_defaults() {
    let args = build_claude_args("{\"mcpServers\":{}}", None, None, None);

    assert_eq!(
        args,
        vec![
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--include-partial-messages".to_string(),
            "--mcp-config".to_string(),
            "{\"mcpServers\":{}}".to_string(),
            "--permission-prompt-tool".to_string(),
            "mcp__vtb-gate__permission_prompt".to_string(),
        ]
    );
    assert!(!args.iter().any(|arg| arg == "--model"));
    assert!(!args.iter().any(|arg| arg == "--permission-mode"));
}

#[test]
fn test_build_claude_args_includes_selected_model() {
    let args = build_claude_args("{}", None, Some("opus"), None);

    let model_idx = args
        .iter()
        .position(|arg| arg == "--model")
        .expect("--model should be present");
    assert_eq!(args.get(model_idx + 1).map(String::as_str), Some("opus"));
}

#[test]
fn test_build_claude_args_includes_permission_mode() {
    let args = build_claude_args("{}", None, None, Some(PermissionMode::Auto));

    let permission_idx = args
        .iter()
        .position(|arg| arg == "--permission-mode")
        .expect("--permission-mode should be present");
    assert_eq!(
        args.get(permission_idx + 1).map(String::as_str),
        Some("auto")
    );
}

#[test]
fn test_build_claude_args_keeps_resume_and_model_when_override_is_explicit() {
    let args = build_claude_args("{}", Some("conv-123"), Some("haiku"), None);

    assert!(args.contains(&"--model".to_string()));
    assert!(args.contains(&"haiku".to_string()));
    assert!(args.contains(&"--resume=conv-123".to_string()));
}
