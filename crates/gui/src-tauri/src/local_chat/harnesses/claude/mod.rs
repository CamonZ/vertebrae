use async_trait::async_trait;

pub(crate) mod args;
pub(crate) mod jsonl;
pub(crate) mod live_jsonl;

use crate::claude_session::{ClaudeSessionError, ClaudeSessionManager};
use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatHarness, LocalChatHarnessInfo, LocalChatHarnessKind,
    LocalChatModelOption, LocalChatRuntime, LocalChatSessionError,
};
use crate::types::CreateClaudeSessionInput;

use self::args::supported_claude_model_catalog;

#[derive(Clone)]
pub(crate) struct ClaudeLocalChatHarness {
    manager: ClaudeSessionManager,
}

impl ClaudeLocalChatHarness {
    pub(crate) fn new(manager: ClaudeSessionManager) -> Self {
        Self { manager }
    }
}

pub(crate) fn claude_local_chat_harness_info() -> LocalChatHarnessInfo {
    let catalog = supported_claude_model_catalog();
    LocalChatHarnessInfo {
        harness: LocalChatHarnessKind::Claude,
        label: "Claude".to_string(),
        available: true,
        unavailable_reason: None,
        default_model_id: Some(catalog.default_model_id),
        models: catalog
            .models
            .into_iter()
            .map(|model| LocalChatModelOption {
                id: model.id,
                label: model.label,
            })
            .collect(),
        supports_resume: true,
    }
}

fn to_claude_input(input: HarnessCreateSessionInput) -> CreateClaudeSessionInput {
    CreateClaudeSessionInput {
        session_id: input.backend_session_id,
        working_dir: input.working_dir,
        initial_prompt: input.initial_prompt,
        resume_session_id: input.provider_resume_id,
        model_id: input.model_id,
        permission_mode: input.permission_mode,
    }
}

impl From<ClaudeSessionError> for LocalChatSessionError {
    fn from(error: ClaudeSessionError) -> Self {
        match error {
            ClaudeSessionError::SessionExists(session_id) => {
                LocalChatSessionError::SessionExists(session_id)
            }
            ClaudeSessionError::SessionNotFound(session_id) => {
                LocalChatSessionError::SessionNotFound(session_id)
            }
            ClaudeSessionError::SendFailed(error) => LocalChatSessionError::SendFailed(error),
            ClaudeSessionError::SpawnFailed(error) => LocalChatSessionError::SpawnFailed(error),
        }
    }
}

#[async_trait]
impl LocalChatHarness for ClaudeLocalChatHarness {
    fn kind(&self) -> LocalChatHarnessKind {
        LocalChatHarnessKind::Claude
    }

    fn info(&self) -> LocalChatHarnessInfo {
        claude_local_chat_harness_info()
    }

    async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        self.manager
            .create_session_with_runtime(to_claude_input(input), runtime)
            .await
            .map_err(LocalChatSessionError::from)
    }

    async fn send_message(
        &self,
        backend_session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError> {
        self.manager
            .send_message(backend_session_id, content)
            .await
            .map_err(LocalChatSessionError::from)
    }

    async fn close_session(&self, backend_session_id: &str) -> Result<(), LocalChatSessionError> {
        self.manager
            .close_session(backend_session_id)
            .await
            .map_err(LocalChatSessionError::from)
    }

    async fn has_session(&self, backend_session_id: &str) -> bool {
        self.manager.has_session(backend_session_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude_session::{ClaudeModelCatalog, ClaudeModelOption};

    #[test]
    fn neutral_claude_catalog_matches_supported_claude_models() {
        let info = claude_local_chat_harness_info();

        assert_eq!(info.harness, LocalChatHarnessKind::Claude);
        assert_eq!(info.label, "Claude");
        assert!(info.available);
        assert_eq!(info.unavailable_reason, None);
        assert_eq!(info.default_model_id, Some("sonnet".to_string()));
        assert!(info.supports_resume);
        assert_eq!(
            info.models,
            vec![
                LocalChatModelOption {
                    id: "sonnet".to_string(),
                    label: "Sonnet".to_string(),
                },
                LocalChatModelOption {
                    id: "opus".to_string(),
                    label: "Opus".to_string(),
                },
                LocalChatModelOption {
                    id: "haiku".to_string(),
                    label: "Haiku".to_string(),
                },
                LocalChatModelOption {
                    id: "fable".to_string(),
                    label: "Fable".to_string(),
                },
            ]
        );
        assert_eq!(
            supported_claude_model_catalog(),
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
    fn harness_create_input_maps_to_claude_compatibility_input() {
        let input = HarnessCreateSessionInput {
            backend_session_id: "backend-1".to_string(),
            working_dir: Some("/tmp/project".to_string()),
            initial_prompt: Some("start".to_string()),
            provider_resume_id: Some("claude-conversation-1".to_string()),
            model_id: Some("opus".to_string()),
            permission_mode: Some(crate::types::PermissionMode::Plan),
        };

        let claude_input = to_claude_input(input);

        assert_eq!(claude_input.session_id, "backend-1");
        assert_eq!(claude_input.working_dir, Some("/tmp/project".to_string()));
        assert_eq!(claude_input.initial_prompt, Some("start".to_string()));
        assert_eq!(
            claude_input.resume_session_id,
            Some("claude-conversation-1".to_string())
        );
        assert_eq!(claude_input.model_id, Some("opus".to_string()));
        assert_eq!(
            claude_input.permission_mode,
            Some(crate::types::PermissionMode::Plan)
        );
    }
}
