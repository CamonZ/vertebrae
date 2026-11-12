use serde::{Deserialize, Serialize};
use specta::Type;

use crate::local_chat::LocalChatPersonalityOption;

const DEFAULT_CLAUDE_MODEL_ID: &str = "sonnet";
const BUILTIN_CLAUDE_OUTPUT_STYLES: &[(&str, &str, bool)] = &[
    ("Default", "Default", true),
    ("Proactive", "Proactive", false),
    ("Concise", "Concise", false),
    ("Explanatory", "Explanatory", false),
    ("Learning", "Learning", false),
];

pub(crate) fn builtin_claude_output_styles() -> Vec<LocalChatPersonalityOption> {
    BUILTIN_CLAUDE_OUTPUT_STYLES
        .iter()
        .map(|(id, label, is_default)| LocalChatPersonalityOption {
            id: (*id).into(),
            label: (*label).into(),
            is_default: *is_default,
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub supported_speed_tier_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelCatalog {
    pub default_model_id: String,
    pub models: Vec<ClaudeModelOption>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedClaudeModel {
    pub(crate) model_id: Option<String>,
    pub(crate) warning: Option<String>,
}

pub fn supported_claude_model_catalog() -> ClaudeModelCatalog {
    let models: Vec<_> = vertebrae_harness::curate_local_chat_models(
        vertebrae_core::BuiltinProvider::Anthropic,
        vertebrae_harness::builtin_claude_model_capabilities(),
    )
    .into_iter()
    .map(|model| ClaudeModelOption {
        id: model.id,
        label: model.label,
        supported_speed_tier_ids: (!model.supported_speed_tiers.is_empty()).then(|| {
            model
                .supported_speed_tiers
                .iter()
                .map(|tier| tier.as_str().to_string())
                .collect()
        }),
    })
    .collect();
    // Keep the default in the curated list as newer shared Sonnet IDs arrive.
    let default_model_id = models
        .iter()
        .find(|model| model.id.starts_with("claude-sonnet-"))
        .or_else(|| models.first())
        .map(|model| model.id.clone())
        .unwrap_or_default();
    ClaudeModelCatalog {
        default_model_id,
        models,
    }
}

fn is_supported_claude_model_id(model_id: &str) -> bool {
    vertebrae_harness::builtin_claude_model_capabilities()
        .iter()
        .any(|model| model.id == model_id)
}

fn safe_warning_model_id(model_id: &str) -> String {
    model_id
        .chars()
        .flat_map(|ch| ch.escape_default())
        .collect()
}

pub(crate) fn resolve_requested_claude_model(
    model_id: Option<String>,
    is_resume: bool,
) -> ResolvedClaudeModel {
    let Some(model_id) = model_id else {
        return ResolvedClaudeModel {
            model_id: None,
            warning: None,
        };
    };
    let normalized = model_id.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return ResolvedClaudeModel {
            model_id: None,
            warning: None,
        };
    }
    if is_supported_claude_model_id(&normalized) {
        return ResolvedClaudeModel {
            model_id: Some(normalized),
            warning: None,
        };
    }

    let safe_model_id = safe_warning_model_id(&normalized);
    if is_resume {
        return ResolvedClaudeModel {
            model_id: None,
            warning: Some(format!(
                "Unsupported Claude model '{}'; resuming with the conversation's original model.",
                safe_model_id
            )),
        };
    }

    ResolvedClaudeModel {
        model_id: Some(DEFAULT_CLAUDE_MODEL_ID.to_string()),
        warning: Some(format!(
            "Unsupported Claude model '{}'; falling back to default model '{}'.",
            safe_model_id, DEFAULT_CLAUDE_MODEL_ID
        )),
    }
}

#[cfg(test)]
mod tests;
