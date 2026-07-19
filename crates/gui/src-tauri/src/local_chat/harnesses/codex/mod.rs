mod models;
#[cfg(not(test))]
mod shared;

#[cfg(not(test))]
pub(crate) use shared::CodexLocalChatHarness;

#[cfg(test)]
mod harness;
#[cfg(test)]
pub(crate) use harness::CodexLocalChatHarness;
#[cfg(test)]
mod launcher;
#[cfg(test)]
mod notifications;
#[cfg(test)]
mod permissions;
#[cfg(test)]
mod protocol;
#[cfg(test)]
mod rpc;
#[cfg(test)]
mod session;
#[cfg(test)]
mod thread_state;

#[cfg(test)]
use launcher::{CodexAppServerLauncher, LaunchedCodexAppServer};
#[cfg(test)]
use notifications::TurnNotificationHandler;
#[cfg(test)]
use protocol::*;
#[cfg(test)]
use thread_state::CodexThreadState;

#[cfg(test)]
mod tests;
