pub(crate) mod events;
pub(crate) mod harness;
pub(crate) mod harnesses;
pub(crate) mod manager;
pub(crate) mod permissions;
pub(crate) mod title_inference;

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
