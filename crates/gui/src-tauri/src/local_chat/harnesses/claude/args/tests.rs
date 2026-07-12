use super::*;

#[test]
fn supported_claude_model_catalog_uses_expected_aliases_and_default() {
    let catalog = supported_claude_model_catalog();

    assert_eq!(
        catalog,
        ClaudeModelCatalog {
            default_model_id: "sonnet".to_string(),
            models: vec![
                ClaudeModelOption {
                    id: "sonnet".to_string(),
                    label: "Sonnet".to_string(),
                },
                ClaudeModelOption {
                    id: "opus".to_string(),
                    label: "Opus".to_string(),
                },
                ClaudeModelOption {
                    id: "haiku".to_string(),
                    label: "Haiku".to_string(),
                },
                ClaudeModelOption {
                    id: "fable".to_string(),
                    label: "Fable".to_string(),
                },
            ],
        }
    );
}

#[test]
fn resolve_requested_claude_model_accepts_supported_ids() {
    for (requested, expected) in [
        ("sonnet", "sonnet"),
        (" Opus ", "opus"),
        ("HAIKU", "haiku"),
        ("fable", "fable"),
    ] {
        assert_eq!(
            resolve_requested_claude_model(Some(requested.to_string()), false),
            ResolvedClaudeModel {
                model_id: Some(expected.to_string()),
                warning: None,
            }
        );
    }
}

#[test]
fn resolve_requested_claude_model_omits_blank_selection() {
    for requested in [None, Some(String::new()), Some(" \t\n ".to_string())] {
        assert_eq!(
            resolve_requested_claude_model(requested, false),
            ResolvedClaudeModel {
                model_id: None,
                warning: None,
            }
        );
    }
}

#[test]
fn resolve_requested_claude_model_falls_back_with_exact_warning_for_fresh_session() {
    assert_eq!(
        resolve_requested_claude_model(Some("claude-unknown".to_string()), false),
        ResolvedClaudeModel {
            model_id: Some("sonnet".to_string()),
            warning: Some(
                "Unsupported Claude model 'claude-unknown'; falling back to default model 'sonnet'."
                    .to_string()
            ),
        }
    );
}

#[test]
fn resolve_requested_claude_model_escapes_warning_id() {
    assert_eq!(
        resolve_requested_claude_model(Some("Mystery\nINFO fake".to_string()), false),
        ResolvedClaudeModel {
            model_id: Some("sonnet".to_string()),
            warning: Some(
                "Unsupported Claude model 'mystery\\ninfo fake'; falling back to default model 'sonnet'."
                    .to_string()
            ),
        }
    );
}

#[test]
fn resolve_requested_claude_model_omits_unsupported_model_on_resume_with_exact_warning() {
    assert_eq!(
        resolve_requested_claude_model(Some("retired".to_string()), true),
        ResolvedClaudeModel {
            model_id: None,
            warning: Some(
                "Unsupported Claude model 'retired'; resuming with the conversation's original model."
                    .to_string()
            ),
        }
    );
}

#[test]
fn build_claude_args_without_model_matches_existing_defaults() {
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
}

#[test]
fn build_claude_args_preserves_full_argv_shape() {
    let args = build_claude_args(
        "{\"mcpServers\":{\"vtb-gate\":{\"command\":\"/bin/vtb-gate\"}}}",
        Some("conv-123"),
        Some("haiku"),
        Some(PermissionMode::BypassPermissions),
    );

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
            "{\"mcpServers\":{\"vtb-gate\":{\"command\":\"/bin/vtb-gate\"}}}".to_string(),
            "--permission-prompt-tool".to_string(),
            "mcp__vtb-gate__permission_prompt".to_string(),
            "--model".to_string(),
            "haiku".to_string(),
            "--permission-mode".to_string(),
            "bypassPermissions".to_string(),
            "--resume=conv-123".to_string(),
        ]
    );
}

#[test]
fn build_claude_args_omits_model_on_resume_fallback() {
    let resolved = resolve_requested_claude_model(Some("retired".to_string()), true);

    let args = build_claude_args(
        "{}",
        Some("conv-123"),
        resolved.model_id.as_deref(),
        Some(PermissionMode::Auto),
    );

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
            "{}".to_string(),
            "--permission-prompt-tool".to_string(),
            "mcp__vtb-gate__permission_prompt".to_string(),
            "--permission-mode".to_string(),
            "auto".to_string(),
            "--resume=conv-123".to_string(),
        ]
    );
}

#[test]
fn build_claude_args_maps_all_permission_modes() {
    for (permission_mode, expected) in [
        (PermissionMode::AcceptEdits, "acceptEdits"),
        (PermissionMode::Auto, "auto"),
        (PermissionMode::BypassPermissions, "bypassPermissions"),
        (PermissionMode::Default, "manual"),
        (PermissionMode::DontAsk, "dontAsk"),
        (PermissionMode::Plan, "plan"),
    ] {
        let args = build_claude_args("{}", None, None, Some(permission_mode));
        let permission_idx = args
            .iter()
            .position(|arg| arg == "--permission-mode")
            .expect("--permission-mode should be present");

        assert_eq!(
            args.get(permission_idx + 1).map(String::as_str),
            Some(expected)
        );
    }
}
