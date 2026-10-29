pub(crate) mod annotations;
pub(crate) mod changes;
pub(crate) mod events;
pub(crate) mod gate;
pub(crate) mod harness;
pub(crate) mod harnesses;
pub(crate) mod manager;
pub(crate) mod permissions;
pub(crate) mod title_inference;
pub(crate) mod worktree_delta;

/// Shared local-chat rendering contract. Each harness maps this into its
/// native additive developer/system instruction mechanism.
pub(crate) const CHAT_REFERENCE_INSTRUCTIONS: &str = r#"When referring to Vertebrae entities—tasks, tickets, epics, workflows, or steps—use Markdown links with typed vtb:// URIs: [label](vtb://epic/<id>), [label](vtb://ticket/<id>), [label](vtb://task/<id>), [label](vtb://step/<id>), [label](vtb://workflow/<id>). Use the exact entity IDs available in context and do not invent IDs.

When referring to local files, put the exact path inside inline code, optionally followed by :line[:column] or #Lline[Ccolumn]. For a file in the current working directory, a repository-relative path is allowed. For a file in another worktree, use the absolute path including that worktree's root, for example `/Users/example/project-worktree/src/main.ts:12`; a relative path plus a parenthetical worktree name is not resolvable. Before linking a file in another worktree, use the exact path available in context or discover it with `git worktree list`; if the exact path is unavailable, do not make up a link. Do not use file://, vscode://, or arbitrary protocols for local files."#;

/// Developer instructions every new local chat session starts with: the
/// shared rendering contract plus the agent-context root index, whose links
/// point at the docs the GUI stages on startup. Doc bodies are never inlined.
pub(crate) fn chat_developer_instructions() -> String {
    match vertebrae_installer::installed_agent_context_dir() {
        Ok(docs_root) => chat_developer_instructions_for(&docs_root),
        Err(error) => {
            log::warn!("Omitting agent-context docs from chat instructions: {error}");
            CHAT_REFERENCE_INSTRUCTIONS.to_string()
        }
    }
}

/// Developer instructions for a new session: the shared chat instructions,
/// followed by the hidden gate protocol when the chat resolves a gate.
pub(crate) fn session_developer_instructions(gate: Option<&LocalChatGateBinding>) -> String {
    let instructions = chat_developer_instructions();
    match gate {
        Some(gate) => format!(
            "{instructions}\n\n{}",
            gate::gate_developer_instructions(gate)
        ),
        None => instructions,
    }
}

fn chat_developer_instructions_for(docs_root: &std::path::Path) -> String {
    format!(
        "{CHAT_REFERENCE_INSTRUCTIONS}\n\n{}",
        vertebrae_agent_context::developer_instructions(docs_root)
    )
}

pub use annotations::LocalChatAnnotationStore;
pub(crate) use annotations::{LocalChatAnnotation, LocalChatAnnotationEvent};
pub(crate) use events::{
    LocalChatCompactionEvent, LocalChatEvent, LocalChatEventSink, LocalChatFileChange,
    LocalChatFileChangeEvent, LocalChatSessionEndEvent, LocalChatSessionErrorEvent,
    LocalChatSessionInitEvent, LocalChatSessionTitleEvent, LocalChatSessionUsageEvent,
    LocalChatSessionWarningEvent, LocalChatSpeedTierStatus, LocalChatTextEvent,
    LocalChatToolCallEvent, LocalChatToolResultEvent, LocalChatTurnStartedEvent,
};
pub use gate::{LocalChatGateBinding, LocalChatGateRevision};
pub(crate) use harness::{
    CreateLocalChatSessionInput, HarnessCreateSessionInput, LocalChatHarness,
    LocalChatHarnessCatalog, LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatModelOption,
    LocalChatPermissionModeOption, LocalChatPersonalityOption, LocalChatProviderInfo,
    LocalChatProviderSelection, LocalChatReasoningEffortOption, LocalChatRuntime,
    LocalChatSessionError, LocalChatSpeedTierOption,
};
pub(crate) use harnesses::claude::ClaudeStartupCapabilities;
pub(crate) use manager::LocalChatSessionManager;
pub use title_inference::{
    infer_session_title, InferLocalChatSessionTitleInput, InferLocalChatSessionTitleOutput,
};

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn chat_developer_instructions_append_the_agent_context_index() {
        let instructions =
            chat_developer_instructions_for(Path::new("/tmp/vertebrae-docs/agent-context"));

        assert!(instructions.starts_with(CHAT_REFERENCE_INSTRUCTIONS));
        assert!(instructions.contains("# Vertebrae agent context"));
        assert!(instructions.contains("(</tmp/vertebrae-docs/agent-context/permissions.md>)"));
    }

    #[test]
    fn session_developer_instructions_append_the_gate_protocol_only_for_gate_chats() {
        let gate = LocalChatGateBinding {
            task_run_id: "run-1".into(),
            step_name: "approve".into(),
            execution_id: "exec-1".into(),
            artifact: "approval".into(),
            role: None,
            question: Some("Ship it?".into()),
            output_schema: None,
            revision: None,
            draftable: None,
            draft: None,
            fields: None,
        };

        let plain = session_developer_instructions(None);
        let gated = session_developer_instructions(Some(&gate));

        assert_eq!(plain, chat_developer_instructions());
        assert!(!plain.contains("# Human input gate"));
        assert!(gated.starts_with(&plain));
        assert!(gated.ends_with(&gate::gate_developer_instructions(&gate)));
    }
}
