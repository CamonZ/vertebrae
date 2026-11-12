use super::*;

#[test]
fn supported_claude_model_catalog_is_concrete_ranked_and_has_valid_default() {
    let catalog = supported_claude_model_catalog();
    assert_eq!(catalog.default_model_id, "claude-sonnet-5-5");
    assert_eq!(
        catalog
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        [
            "claude-fable-5-2",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5"
        ]
    );
    assert_eq!(catalog.models[0].label, "Claude Fable 5.2");
    assert_eq!(
        catalog.models[0].supported_speed_tier_ids,
        Some(vec!["default".into(), "fast".into()])
    );
    assert!(catalog.models[2].supported_speed_tier_ids.is_none());
}

#[test]
fn resolve_requested_claude_model_accepts_supported_ids() {
    for (requested, expected) in [
        ("sonnet", "sonnet"),
        (" Opus ", "opus"),
        ("HAIKU", "haiku"),
        ("fable", "fable"),
        ("claude-fable-5-2", "claude-fable-5-2"),
        (" CLAUDE-OPUS-5-5 ", "claude-opus-5-5"),
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
fn resolve_requested_5_5_models_preserve_fresh_and_resumed_selection() {
    for is_resume in [false, true] {
        for (requested, expected) in [
            (" CLAUDE-HAIKU-5-5 ", "claude-haiku-5-5"),
            (" CLAUDE-SONNET-5-5 ", "claude-sonnet-5-5"),
        ] {
            assert_eq!(
                resolve_requested_claude_model(Some(requested.into()), is_resume),
                ResolvedClaudeModel {
                    model_id: Some(expected.into()),
                    warning: None,
                }
            );
        }
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
