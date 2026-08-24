use serde::{Deserialize, Serialize};
use specta::Type;

const DEFAULT_CLAUDE_MODEL_ID: &str = "sonnet";
const SUPPORTED_CLAUDE_MODELS: &[ClaudeModelDefinition] = &[
    ClaudeModelDefinition {
        id: "sonnet",
        label: "Sonnet",
    },
    ClaudeModelDefinition {
        id: "opus",
        label: "Opus",
    },
    ClaudeModelDefinition {
        id: "haiku",
        label: "Haiku",
    },
    ClaudeModelDefinition {
        id: "fable",
        label: "Fable",
    },
    ClaudeModelDefinition {
        id: "claude-opus-5",
        label: "Claude Opus 5",
    },
    ClaudeModelDefinition {
        id: "claude-opus-4-8",
        label: "Claude Opus 4.8",
    },
];

#[derive(Debug, Clone, Copy)]
struct ClaudeModelDefinition {
    id: &'static str,
    label: &'static str,
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
    ClaudeModelCatalog {
        default_model_id: DEFAULT_CLAUDE_MODEL_ID.to_string(),
        models: SUPPORTED_CLAUDE_MODELS
            .iter()
            .map(|model| ClaudeModelOption {
                id: model.id.to_string(),
                label: model.label.to_string(),
                supported_speed_tier_ids: claude_model_speed_tier_ids(model.id),
            })
            .collect(),
    }
}

fn claude_model_speed_tier_ids(model_id: &str) -> Option<Vec<String>> {
    matches!(model_id, "opus" | "claude-opus-5" | "claude-opus-4-8")
        .then(|| vec!["default".into(), "fast".into()])
}

fn is_supported_claude_model_id(model_id: &str) -> bool {
    SUPPORTED_CLAUDE_MODELS
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
