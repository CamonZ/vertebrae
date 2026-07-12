use std::collections::HashSet;

use serde::Deserialize;

use crate::local_chat::{LocalChatModelOption, LocalChatReasoningEffortOption};

pub(super) const CODEX_DEFAULT_MODEL_ID: &str = "default";
pub(super) const CODEX_DEFAULT_MODEL_LABEL: &str = "Codex default";
pub(super) const CODEX_DEFAULT_REASONING_EFFORT: &str = "default";

#[derive(Debug, Clone, Deserialize)]
pub(super) struct CodexModelCatalog {
    models: Vec<CodexCatalogModel>,
}

#[derive(Debug, Clone, Deserialize)]
struct CodexCatalogModel {
    slug: String,
    display_name: String,
    visibility: String,
    priority: u32,
    #[serde(default)]
    supported_reasoning_levels: Vec<CodexReasoningLevel>,
}

#[derive(Debug, Clone, Deserialize)]
struct CodexReasoningLevel {
    effort: String,
}

pub(super) fn parse_codex_model_catalog(output: &str) -> Result<CodexModelCatalog, String> {
    serde_json::from_str(output).map_err(|error| format!("Invalid Codex model catalog: {error}"))
}

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

pub(super) fn codex_model_options(
    catalog: Option<&CodexModelCatalog>,
) -> Vec<LocalChatModelOption> {
    let mut options = vec![LocalChatModelOption {
        id: CODEX_DEFAULT_MODEL_ID.to_string(),
        label: CODEX_DEFAULT_MODEL_LABEL.to_string(),
        supported_reasoning_effort_ids: None,
    }];

    match catalog {
        Some(catalog) => {
            let mut models: Vec<_> = catalog
                .models
                .iter()
                .filter(|model| model.visibility == "list")
                .collect();
            models.sort_by_key(|model| model.priority);
            options.extend(models.into_iter().map(|model| {
                LocalChatModelOption {
                    id: model.slug.clone(),
                    label: model.display_name.clone(),
                    supported_reasoning_effort_ids: Some(
                        model
                            .supported_reasoning_levels
                            .iter()
                            .map(|level| level.effort.clone())
                            .collect(),
                    ),
                }
            }));
        }
        None => {
            options.extend(
                [
                    ("gpt-5.5", "GPT-5.5"),
                    ("gpt-5.4", "GPT-5.4"),
                    ("gpt-5.4-mini", "GPT-5.4 Mini"),
                    ("gpt-5.3-codex", "GPT-5.3 Codex"),
                ]
                .into_iter()
                .map(|(id, label)| LocalChatModelOption {
                    id: id.to_string(),
                    label: label.to_string(),
                    supported_reasoning_effort_ids: None,
                }),
            );
        }
    }

    options
}

pub(super) fn codex_reasoning_effort_options(
    catalog: Option<&CodexModelCatalog>,
) -> Vec<LocalChatReasoningEffortOption> {
    let Some(catalog) = catalog else {
        return static_reasoning_effort_options();
    };

    let mut models: Vec<_> = catalog
        .models
        .iter()
        .filter(|model| model.visibility == "list")
        .collect();
    models.sort_by_key(|model| model.priority);

    let mut effort_ids = HashSet::new();
    models
        .into_iter()
        .flat_map(|model| &model.supported_reasoning_levels)
        .filter(|level| effort_ids.insert(level.effort.clone()))
        .map(|level| LocalChatReasoningEffortOption {
            label: reasoning_effort_label(&level.effort),
            id: level.effort.clone(),
        })
        .collect()
}

fn static_reasoning_effort_options() -> Vec<LocalChatReasoningEffortOption> {
    [
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "Extra high"),
    ]
    .into_iter()
    .map(|(id, label)| LocalChatReasoningEffortOption {
        id: id.to_string(),
        label: label.to_string(),
    })
    .collect()
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
