pub(crate) mod events;
pub(crate) mod harness;
pub(crate) mod harnesses;
pub(crate) mod manager;
pub(crate) mod permissions;
pub(crate) mod title_inference;

/// Shared local-chat rendering contract. Each harness maps this into its
/// native additive developer/system instruction mechanism.
pub(crate) const CHAT_REFERENCE_INSTRUCTIONS: &str = r#"When referring to Vertebrae entities—tasks, tickets, epics, workflows, or steps—use Markdown links with typed vtb:// URIs: [label](vtb://epic/<id>), [label](vtb://ticket/<id>), [label](vtb://task/<id>), [label](vtb://step/<id>), [label](vtb://workflow/<id>), or [label](vtb://project/<id>). Use the exact entity IDs available in context and do not invent IDs.

When referring to local files, put the exact path inside inline code, optionally followed by :line[:column] or #Lline[Ccolumn]. For a file in the current working directory, a repository-relative path is allowed. For a file in another worktree, use the complete absolute path including that worktree's root, for example `/Users/example/project-worktree/src/main.ts:12`; a relative path plus a parenthetical worktree name is not resolvable. Before linking a file in another worktree, use the exact path available in context or discover it with `git worktree list`; if the exact path is unavailable, do not make up a link. Do not use file://, vscode://, or arbitrary protocols for local files."#;

pub(crate) use events::{
    LocalChatCompactionEvent, LocalChatEvent, LocalChatEventSink, LocalChatFileChange,
    LocalChatFileChangeEvent, LocalChatSessionEndEvent, LocalChatSessionErrorEvent,
    LocalChatSessionInitEvent, LocalChatSessionUsageEvent, LocalChatSessionWarningEvent,
    LocalChatTextEvent, LocalChatToolCallEvent, LocalChatToolResultEvent,
    LocalChatTurnStartedEvent,
};
pub(crate) use harness::{
    CreateLocalChatSessionInput, HarnessCreateSessionInput, LocalChatHarness,
    LocalChatHarnessCatalog, LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatModelOption,
    LocalChatPermissionModeOption, LocalChatReasoningEffortOption, LocalChatRuntime,
    LocalChatSessionError,
};
pub(crate) use harnesses::claude::ClaudeStartupCapabilities;
pub(crate) use manager::LocalChatSessionManager;
pub use title_inference::{
    infer_session_title, InferLocalChatSessionTitleInput, InferLocalChatSessionTitleOutput,
};
