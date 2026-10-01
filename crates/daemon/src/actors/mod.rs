// Actor module organization for the workflow execution daemon.
//
// This module contains the actor hierarchy:
// - DaemonSupervisor: Top-level supervisor managing the enrolled daemon channel
// - ProjectSupervisor: Per-project actor with scoped SacrumClient and VertebraeServices
// - StepExecutor: Per-attempt actor for provider inference or bounded blocking Rhai work

pub mod daemon_supervisor;
pub mod project_supervisor;
pub mod step_executor;

pub use daemon_supervisor::{DaemonConfig, DaemonMessage, DaemonSupervisor};
pub use project_supervisor::{ProjectConfig, ProjectMessage, ProjectSupervisor};
pub use step_executor::{
    StepConfig, StepExecutor, StepExecutorConfig, StepExecutorMessage, StepMetrics, StepResult,
};
