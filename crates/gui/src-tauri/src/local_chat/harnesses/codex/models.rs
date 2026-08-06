use std::collections::BTreeSet;

use vertebrae_harness_core::HarnessCapabilities;

use crate::local_chat::{
    LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatModelOption,
    LocalChatPermissionModeOption, LocalChatReasoningEffortOption,
};
use crate::types::PermissionMode;

pub(super) const CODEX_DEFAULT_MODEL_ID: &str = "default";
pub(super) const CODEX_DEFAULT_REASONING_EFFORT: &str = "default";

pub(super) fn requested_model_override(model_id: Option<&str>) -> Option<&str> {
    match model_id {
        Some(CODEX_DEFAULT_MODEL_ID) | None => None,
        Some(model_id) => Some(model_id),
    }
}

pub(super) fn requested_reasoning_effort(reasoning_effort: Option<&str>) -> Option<&str> {
    match reasoning_effort {
        Some(CODEX_DEFAULT_REASONING_EFFORT) | None => None,
        Some(reasoning_effort) => Some(reasoning_effort),
    }
}

pub(super) fn local_chat_harness_info_from_capabilities(
    capabilities: HarnessCapabilities,
) -> LocalChatHarnessInfo {
    let mut reasoning_effort_ids = BTreeSet::new();
    let models = capabilities
        .models
        .into_iter()
        .map(|model| {
            reasoning_effort_ids.extend(model.reasoning_efforts.iter().cloned());
            let supported_reasoning_effort_ids = if model.id == CODEX_DEFAULT_MODEL_ID {
                None
            } else {
                Some(model.reasoning_efforts.into_iter().collect())
            };
            LocalChatModelOption {
                id: model.id,
                label: model.label,
                supported_reasoning_effort_ids,
            }
        })
        .collect();

    let permission_modes = capabilities
        .permission_modes
        .into_iter()
        .filter_map(|mode| {
            Some(LocalChatPermissionModeOption {
                id: permission_mode_from_id(&mode.id)?,
                label: mode.label,
                is_default: mode.is_default,
            })
        })
        .collect::<Vec<_>>();

    LocalChatHarnessInfo {
        harness: LocalChatHarnessKind::Codex,
        label: "Codex".into(),
        available: capabilities.available,
        unavailable_reason: capabilities.unavailable_reason,
        default_model_id: capabilities.default_model,
        models,
        default_reasoning_effort: capabilities
            .available
            .then_some(CODEX_DEFAULT_REASONING_EFFORT.into()),
        reasoning_efforts: reasoning_effort_ids
            .into_iter()
            .map(|id| LocalChatReasoningEffortOption {
                label: reasoning_effort_label(&id),
                id,
            })
            .collect(),
        permission_modes: Some(permission_modes),
        supports_resume: capabilities.session_resumption,
    }
}

fn permission_mode_from_id(id: &str) -> Option<PermissionMode> {
    match id {
        "accept_edits" => Some(PermissionMode::AcceptEdits),
        "auto" => Some(PermissionMode::Auto),
        "bypass_permissions" => Some(PermissionMode::BypassPermissions),
        "default" => Some(PermissionMode::Default),
        "dont_ask" => Some(PermissionMode::DontAsk),
        "plan" => Some(PermissionMode::Plan),
        _ => None,
    }
}

fn reasoning_effort_label(effort: &str) -> String {
    match effort {
        "xhigh" => "Extra high".to_string(),
        _ => {
            let mut label = effort.to_string();
            if let Some(first) = label.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            label
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use vertebrae_harness_core::{HarnessCapabilities, ModelCapability, QuestionCapabilities};

    use super::*;

    #[test]
    fn local_chat_catalog_uses_provider_discovered_models_and_efforts() {
        let info = local_chat_harness_info_from_capabilities(HarnessCapabilities {
            provider: "openai".into(),
            available: true,
            unavailable_reason: None,
            persistent_sessions: true,
            one_shot_runs: true,
            session_resumption: true,
            default_model: Some("default".into()),
            models: vec![
                ModelCapability {
                    id: "default".into(),
                    label: "Codex default".into(),
                    reasoning_efforts: BTreeSet::new(),
                },
                ModelCapability {
                    id: "server-only-model".into(),
                    label: "Server only model".into(),
                    reasoning_efforts: BTreeSet::from(["ultra".into()]),
                },
            ],
            default_permission_mode: Some("default".into()),
            permission_modes: vec![
                vertebrae_harness_core::PermissionModeCapability {
                    id: "default".into(),
                    label: "Ask for approval".into(),
                    is_default: true,
                },
                vertebrae_harness_core::PermissionModeCapability {
                    id: "auto".into(),
                    label: "Approve for me".into(),
                    is_default: false,
                },
            ],
            approval_categories: BTreeSet::new(),
            questions: QuestionCapabilities::default(),
        });

        assert_eq!(
            info.models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "server-only-model"]
        );
        assert_eq!(
            info.models[1].supported_reasoning_effort_ids,
            Some(vec!["ultra".into()])
        );
        assert_eq!(
            info.reasoning_efforts,
            vec![LocalChatReasoningEffortOption {
                id: "ultra".into(),
                label: "Ultra".into(),
            }]
        );
        assert_eq!(
            info.permission_modes,
            Some(vec![
                LocalChatPermissionModeOption {
                    id: PermissionMode::Default,
                    label: "Ask for approval".into(),
                    is_default: true,
                },
                LocalChatPermissionModeOption {
                    id: PermissionMode::Auto,
                    label: "Approve for me".into(),
                    is_default: false,
                },
            ])
        );
        assert!(!info.models.iter().any(|model| model.id == "gpt-5.5"));
    }

    #[test]
    fn failed_discovery_does_not_expose_a_static_picker() {
        let info = local_chat_harness_info_from_capabilities(HarnessCapabilities {
            provider: "openai".into(),
            available: false,
            unavailable_reason: Some("catalog unavailable".into()),
            persistent_sessions: true,
            one_shot_runs: true,
            session_resumption: true,
            default_model: None,
            models: Vec::new(),
            default_permission_mode: None,
            permission_modes: Vec::new(),
            approval_categories: BTreeSet::new(),
            questions: QuestionCapabilities::default(),
        });

        assert!(!info.available);
        assert!(info.models.is_empty());
        assert!(info.reasoning_efforts.is_empty());
        assert_eq!(info.default_model_id, None);
    }
}
