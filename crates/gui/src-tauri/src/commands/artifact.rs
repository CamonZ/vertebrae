use super::*;
use crate::types::Artifact;
use vertebrae_core::ListArtifactInput;

/// List artifact files in the active project.
#[tauri::command]
#[specta::specta]
pub async fn list_project_artifacts(
    state: State<'_, AppState>,
) -> Result<Vec<Artifact>, CommandError> {
    let services = state.services.read().await;
    let service = services
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .artifacts()
        .list_artifacts(ListArtifactInput::new())
        .await
        .map(|artifacts| artifacts.into_iter().map(Into::into).collect())
        .map_err(Into::into)
}

/// List artifact files attached to one task.
#[tauri::command]
#[specta::specta]
pub async fn list_task_artifacts(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Vec<Artifact>, CommandError> {
    let services = state.services.read().await;
    let service = services
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .artifacts()
        .list_task_artifacts(&task_id, ListArtifactInput::new())
        .await
        .map(|artifacts| artifacts.into_iter().map(Into::into).collect())
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{assert_no_project_error, build_app_without_services};
    use tauri::Manager;

    #[tokio::test]
    async fn project_artifacts_require_a_selected_project() {
        let app = build_app_without_services();
        assert_no_project_error(list_project_artifacts(app.state()).await);
    }

    #[tokio::test]
    async fn task_artifacts_require_a_selected_project() {
        let app = build_app_without_services();
        assert_no_project_error(list_task_artifacts(app.state(), "task-id".into()).await);
    }
}
