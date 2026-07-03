//! Tauri command gateway for the GUI backend.
//!
//! Shared command state and errors live here; responsibility-specific command
//! implementations live in the sibling modules re-exported below.

use crate::local_chat::permissions::LocalPermissionDecision;
use crate::local_chat::{
    infer_session_title, CreateLocalChatSessionInput, InferLocalChatSessionTitleInput,
    InferLocalChatSessionTitleOutput, LocalChatHarnessCatalog, LocalChatSessionError,
    LocalChatSessionManager,
};
use crate::project_config::{ProjectConfig, SavedProject};
use crate::types::{
    InitializeProjectResult, PermissionDecisionBehavior, ResolvePermissionRequestInput,
    SacrumConfigStatus, Section, SessionLog, Step, StepExecution, StopRunRequest, Task,
    TaskFilterOptions, TaskRun, TaskRunTrace, Workflow, WorkflowWithTasks,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};
use tokio::sync::RwLock;
use vertebrae_core::{StopRunTarget, VertebraeServices};

/// Application state holding the services
pub struct AppState {
    /// Unified services container (None until a project is selected)
    pub services: RwLock<Option<VertebraeServices>>,
    /// Raw Sacrum GraphQL client used for queries that bypass the service
    /// trait abstractions (e.g. `pipeline_summary`, which is GUI-specific).
    pub sacrum_client: RwLock<Option<std::sync::Arc<vertebrae_sacrum_client::GraphqlClient>>>,
    /// Project configuration manager
    pub project_config: ProjectConfig,
}

/// Error response type for commands - simple string wrapper with specta support
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CommandError {
    pub message: String,
}

impl From<vertebrae_core::ServiceError> for CommandError {
    fn from(err: vertebrae_core::ServiceError) -> Self {
        CommandError {
            message: err.to_string(),
        }
    }
}

impl CommandError {
    pub fn task_not_found(id: &str) -> Self {
        CommandError {
            message: format!("Task not found: {}", id),
        }
    }

    pub fn workflow_not_found(id: &str) -> Self {
        CommandError {
            message: format!("Workflow not found: {}", id),
        }
    }

    pub fn no_project_selected() -> Self {
        CommandError {
            message: "No project selected. Please select a project first.".to_string(),
        }
    }
}

mod execution;
mod local_chat;
mod project;
mod runs;
mod runtime;
mod steps;
mod task;
mod workflow;

pub use execution::*;
pub use local_chat::*;
pub use project::*;
pub use runs::*;
pub use runtime::*;
pub use steps::*;
pub use task::*;
pub use workflow::*;

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::mock::mock_services;
    use crate::project_config::ProjectConfig;
    use tauri::Manager;
    use tokio::sync::RwLock;

    /// Helper: build a mock Tauri app with services loaded.
    pub(crate) fn build_app_with_services() -> tauri::App<tauri::test::MockRuntime> {
        let services = mock_services();
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let project_config = ProjectConfig::with_path(tmp.path().to_path_buf());

        tauri::test::mock_builder()
            .manage(AppState {
                services: RwLock::new(Some(services)),
                sacrum_client: RwLock::new(None),
                project_config,
            })
            .manage(tokio::sync::Mutex::new(
                crate::websocket_client::SacrumSocket::disconnected(),
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    /// Helper: build a mock Tauri app with NO project selected (services = None).
    pub(crate) fn build_app_without_services() -> tauri::App<tauri::test::MockRuntime> {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let project_config = ProjectConfig::with_path(tmp.path().to_path_buf());

        tauri::test::mock_builder()
            .manage(AppState {
                services: RwLock::new(None),
                sacrum_client: RwLock::new(None),
                project_config,
            })
            .manage(tokio::sync::Mutex::new(
                crate::websocket_client::SacrumSocket::disconnected(),
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    pub(crate) fn assert_no_project_error<T: std::fmt::Debug>(result: Result<T, CommandError>) {
        let err = result.expect_err("expected command to fail without a selected project");
        assert!(err.message.contains("No project selected"));
    }

    pub(crate) async fn create_task_with_workflow(
        app: &tauri::App<tauri::test::MockRuntime>,
    ) -> String {
        let app_state = app.state::<AppState>();
        let (tasks, workflows) = {
            let services_guard = app_state.services.read().await;
            let services = services_guard.as_ref().expect("services initialized");
            (services.tasks_arc(), services.workflows_arc())
        };

        let task_id = tasks
            .create_task(vertebrae_core::CreateTaskOptions::new(
                "TaskRun command task",
            ))
            .await
            .expect("create task");
        let workflow_id = workflows
            .create_workflow(vertebrae_core::CreateWorkflowOptions::new(
                "TaskRun command workflow",
                vec![],
            ))
            .await
            .expect("create workflow");
        tasks
            .assign_workflow(&task_id, &workflow_id)
            .await
            .expect("assign workflow");

        task_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ========================================================================
    // CommandError tests
    // ========================================================================

    #[test]
    fn command_error_from_service_error() {
        let err = vertebrae_core::ServiceError::task_not_found("abc");
        let cmd_err: CommandError = err.into();
        assert!(cmd_err.message.contains("abc"));
    }

    #[test]
    fn command_error_helpers() {
        let err = CommandError::task_not_found("t1");
        assert!(err.message.contains("t1"));

        let err = CommandError::workflow_not_found("w1");
        assert!(err.message.contains("w1"));

        let err = CommandError::no_project_selected();
        assert!(err.message.contains("No project selected"));
    }
}
