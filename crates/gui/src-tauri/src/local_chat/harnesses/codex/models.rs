use crate::local_chat::{LocalChatModelOption, LocalChatReasoningEffortOption};

pub(super) const CODEX_DEFAULT_MODEL_ID: &str = "default";
pub(super) const CODEX_DEFAULT_MODEL_LABEL: &str = "Codex default";
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

pub(super) fn codex_model_options() -> Vec<LocalChatModelOption> {
    std::iter::once(LocalChatModelOption {
        id: CODEX_DEFAULT_MODEL_ID.to_string(),
        label: CODEX_DEFAULT_MODEL_LABEL.to_string(),
        supported_reasoning_effort_ids: None,
    })
    .chain(
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
    )
    .collect()
}

pub(super) fn codex_reasoning_effort_options() -> Vec<LocalChatReasoningEffortOption> {
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
