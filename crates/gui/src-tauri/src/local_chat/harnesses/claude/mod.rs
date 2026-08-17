use async_trait::async_trait;

pub(crate) mod args;
pub(crate) mod session;

use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatHarness, LocalChatHarnessInfo, LocalChatHarnessKind,
    LocalChatModelOption, LocalChatPermissionModeOption, LocalChatRuntime, LocalChatSessionError,
};
use crate::types::PermissionMode;

pub(crate) use session::{ClaudeSessionRuntime, ClaudeStartupCapabilities};

use self::args::supported_claude_model_catalog;

// Re-export public catalog types for tests.
#[cfg(test)]
pub(crate) use self::args::{ClaudeModelCatalog, ClaudeModelOption};

#[derive(Clone)]
pub(crate) struct ClaudeLocalChatHarness {
    runtime: ClaudeSessionRuntime,
}

impl ClaudeLocalChatHarness {
    pub(crate) fn new() -> Self {
        Self {
            runtime: ClaudeSessionRuntime::new(),
        }
    }

    pub(crate) fn with_startup_capabilities(
        startup_capabilities: ClaudeStartupCapabilities,
    ) -> Self {
        Self {
            runtime: ClaudeSessionRuntime::with_startup_capabilities(startup_capabilities),
        }
    }
}

impl Default for ClaudeLocalChatHarness {
    fn default() -> Self {
        Self::new()
    }
}

fn claude_local_chat_harness_info_from_resolution(
    resolution: Result<(), String>,
) -> LocalChatHarnessInfo {
    let catalog = supported_claude_model_catalog();
    let (available, unavailable_reason) = match resolution {
        Ok(()) => (true, None),
        Err(error) => (false, Some(error)),
    };
    LocalChatHarnessInfo {
        harness: LocalChatHarnessKind::Claude,
        label: "Claude".to_string(),
        available,
        unavailable_reason,
        default_model_id: Some(catalog.default_model_id),
        models: catalog
            .models
            .into_iter()
            .map(|model| LocalChatModelOption {
                id: model.id,
                label: model.label,
                supported_reasoning_effort_ids: None,
            })
            .collect(),
        default_reasoning_effort: None,
        reasoning_efforts: Vec::new(),
        permission_modes: Some(vec![
            LocalChatPermissionModeOption {
                id: PermissionMode::Default,
                label: "Ask before edits".to_string(),
                is_default: true,
            },
            LocalChatPermissionModeOption {
                id: PermissionMode::AcceptEdits,
                label: "Edit automatically".to_string(),
                is_default: false,
            },
            LocalChatPermissionModeOption {
                id: PermissionMode::Plan,
                label: "Plan mode".to_string(),
                is_default: false,
            },
            LocalChatPermissionModeOption {
                id: PermissionMode::Auto,
                label: "Auto mode".to_string(),
                is_default: false,
            },
            LocalChatPermissionModeOption {
                id: PermissionMode::DontAsk,
                label: "Don't ask".to_string(),
                is_default: false,
            },
            LocalChatPermissionModeOption {
                id: PermissionMode::BypassPermissions,
                label: "Bypass permissions".to_string(),
                is_default: false,
            },
        ]),
        supports_resume: true,
    }
}

#[async_trait]
impl LocalChatHarness for ClaudeLocalChatHarness {
    fn kind(&self) -> LocalChatHarnessKind {
        LocalChatHarnessKind::Claude
    }

    async fn info(&self) -> LocalChatHarnessInfo {
        claude_local_chat_harness_info_from_resolution(self.runtime.startup_binary_resolution())
    }

    async fn create_session(
        &self,
        input: HarnessCreateSessionInput,
        runtime: LocalChatRuntime,
    ) -> Result<(), LocalChatSessionError> {
        self.runtime.create_session(input, runtime).await
    }

    async fn send_message(
        &self,
        backend_session_id: &str,
        content: &str,
    ) -> Result<(), LocalChatSessionError> {
        self.runtime.send_message(backend_session_id, content).await
    }

    async fn close_session(&self, backend_session_id: &str) -> Result<(), LocalChatSessionError> {
        self.runtime.close_session(backend_session_id).await
    }

    async fn shutdown(&self) {
        self.runtime.shutdown().await;
    }

    async fn has_session(&self, backend_session_id: &str) -> bool {
        self.runtime.has_session(backend_session_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_chat::HarnessCreateSessionInput;
    use crate::types::PermissionMode;

    #[test]
    fn neutral_claude_catalog_matches_supported_claude_models() {
        let info = claude_local_chat_harness_info_from_resolution(Ok(()));

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
                    supported_reasoning_effort_ids: None,
                },
                LocalChatModelOption {
                    id: "opus".to_string(),
                    label: "Opus".to_string(),
                    supported_reasoning_effort_ids: None,
                },
                LocalChatModelOption {
                    id: "haiku".to_string(),
                    label: "Haiku".to_string(),
                    supported_reasoning_effort_ids: None,
                },
                LocalChatModelOption {
                    id: "fable".to_string(),
                    label: "Fable".to_string(),
                    supported_reasoning_effort_ids: None,
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
    fn neutral_claude_catalog_retains_cli_resolution_error() {
        let info = claude_local_chat_harness_info_from_resolution(Err(
            "Claude Code CLI not found".to_string()
        ));

        assert!(!info.available);
        assert_eq!(
            info.unavailable_reason,
            Some("Claude Code CLI not found".to_string())
        );
        assert_eq!(info.default_model_id, Some("sonnet".to_string()));
    }

    #[test]
    fn harness_create_input_is_passed_directly_to_runtime() {
        let input = HarnessCreateSessionInput {
            backend_session_id: "backend-1".to_string(),
            working_dir: Some("/tmp/project".to_string()),
            initial_prompt: Some("start".to_string()),
            provider_resume_id: Some("claude-conversation-1".to_string()),
            model_id: Some("opus".to_string()),
            reasoning_effort: Some("high".to_string()),
            permission_mode: Some(PermissionMode::Plan),
        };

        assert_eq!(input.backend_session_id, "backend-1");
        assert_eq!(input.working_dir, Some("/tmp/project".to_string()));
        assert_eq!(input.initial_prompt, Some("start".to_string()));
        assert_eq!(
            input.provider_resume_id,
            Some("claude-conversation-1".to_string())
        );
        assert_eq!(input.model_id, Some("opus".to_string()));
        assert_eq!(input.permission_mode, Some(PermissionMode::Plan));
    }
}
