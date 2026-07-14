use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

use crate::types::PermissionMode;

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
            })
            .collect(),
    }
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

pub(crate) fn build_claude_args(
    mcp_config: &str,
    resume_session_id: Option<&str>,
    model_id: Option<&str>,
    permission_mode: Option<PermissionMode>,
    plugin_root: Option<&Path>,
) -> Vec<String> {
    let mut args = vec![
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--mcp-config".to_string(),
        mcp_config.to_string(),
        "--permission-prompt-tool".to_string(),
        "mcp__vtb-gate__permission_prompt".to_string(),
    ];

    if let Some(plugin_root) = plugin_root {
        args.push("--plugin-dir".to_string());
        args.push(plugin_root.to_string_lossy().into_owned());
    }

    if let Some(model_id) = model_id {
        args.push("--model".to_string());
        args.push(model_id.to_string());
    }

    if let Some(permission_mode) = permission_mode {
        args.push("--permission-mode".to_string());
        args.push(permission_mode.as_claude_arg().to_string());
    }

    if let Some(resume_id) = resume_session_id {
        args.push(format!("--resume={}", resume_id));
    }

    args
}

#[cfg(test)]
mod tests;
