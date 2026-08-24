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
                    supported_speed_tier_ids: None,
                },
                ClaudeModelOption {
                    id: "opus".to_string(),
                    label: "Opus".to_string(),
                    supported_speed_tier_ids: None,
                },
                ClaudeModelOption {
                    id: "haiku".to_string(),
                    label: "Haiku".to_string(),
                    supported_speed_tier_ids: None,
                },
                ClaudeModelOption {
                    id: "fable".to_string(),
                    label: "Fable".to_string(),
                    supported_speed_tier_ids: None,
                },
                ClaudeModelOption {
                    id: "claude-opus-5".to_string(),
                    label: "Claude Opus 5".to_string(),
                    supported_speed_tier_ids: Some(vec!["default".into(), "fast".into()]),
                },
                ClaudeModelOption {
                    id: "claude-opus-4-8".to_string(),
                    label: "Claude Opus 4.8".to_string(),
                    supported_speed_tier_ids: Some(vec!["default".into(), "fast".into()]),
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
