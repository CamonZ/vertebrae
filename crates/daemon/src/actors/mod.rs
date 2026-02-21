// Actor module organization for the workflow execution daemon.
//
// This module contains the actor hierarchy:
// - DaemonSupervisor: Top-level supervisor managing WebSocket connection and project channels
// - ProjectSupervisor: Per-project actor with scoped SacrumClient and VertebraeServices

pub mod daemon_supervisor;
pub mod project_supervisor;

pub use daemon_supervisor::{DaemonConfig, DaemonMessage, DaemonSupervisor};
pub use project_supervisor::{ProjectConfig, ProjectMessage, ProjectSupervisor};
