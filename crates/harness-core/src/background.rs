//! Background work is provider-native activity that can outlive the turn that
//! launched it, such as a backgrounded shell command. Subagents are not
//! background work: their threads are tracked through thread lineage.
//!
//! Adapters emit these updates; the GUI chat store projects them.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ToolCallId;

macro_rules! background_id {
    ($name:ident) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self::new(value)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

background_id!(BackgroundWorkId);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundWorkKind {
    Command,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundWorkStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    /// No longer reported as running and no outcome was reported.
    #[serde(other)]
    Unknown,
}

impl BackgroundWorkStatus {
    pub fn is_terminal(self) -> bool {
        self != Self::Running
    }
}

/// The owning session, thread and turn come from the event correlation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackgroundWorkEvent {
    pub work_id: BackgroundWorkId,
    #[serde(default)]
    pub generation: u32,
    pub kind: BackgroundWorkKind,
    /// Native label, such as `local_bash` or `commandExecution`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_kind: Option<String>,
    pub status: BackgroundWorkStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
    /// The result of this call only acknowledges the launch; it is not the
    /// work's outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_tool_call_id: Option<ToolCallId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BackgroundWorkEvent {
    pub fn new(
        work_id: impl Into<String>,
        kind: BackgroundWorkKind,
        status: BackgroundWorkStatus,
    ) -> Self {
        Self {
            work_id: BackgroundWorkId::new(work_id.into()),
            generation: 0,
            kind,
            provider_kind: None,
            status,
            description: None,
            progress: None,
            launch_tool_call_id: None,
            started_at: None,
            finished_at: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackgroundRosterEntry {
    pub work_id: BackgroundWorkId,
    pub kind: BackgroundWorkKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Every piece of work the provider reports as running. It replaces the
/// previous roster rather than adding to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackgroundRosterEvent {
    pub work: Vec<BackgroundRosterEntry>,
}
