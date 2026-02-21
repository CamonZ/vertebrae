// Actor module organization for the workflow execution daemon.
//
// This module contains the actor hierarchy:
// - DaemonSupervisor: Top-level supervisor managing WebSocket connection and project channels
// - ProjectSupervisor: Per-project actor that handles channel messages (future)

pub mod daemon_supervisor;

pub use daemon_supervisor::{DaemonConfig, DaemonMessage, DaemonSupervisor};
