pub(crate) mod events;
pub(crate) mod harness;
pub(crate) mod harnesses;
pub(crate) mod manager;
pub(crate) mod permissions;

pub(crate) use events::{
    LocalChatEvent, LocalChatEventSink, LocalChatSessionEndEvent, LocalChatSessionErrorEvent,
    LocalChatSessionInitEvent, LocalChatSessionUsageEvent, LocalChatSessionWarningEvent,
    LocalChatTextEvent, LocalChatToolCallEvent, LocalChatToolResultEvent,
};
pub(crate) use harness::{
    CreateLocalChatSessionInput, HarnessCreateSessionInput, LocalChatHarness,
    LocalChatHarnessCatalog, LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatModelOption,
    LocalChatReasoningEffortOption, LocalChatRuntime, LocalChatSessionError,
};
pub(crate) use manager::LocalChatSessionManager;
