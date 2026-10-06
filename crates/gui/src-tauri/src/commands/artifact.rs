use super::*;
use crate::types::Artifact;

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
        .list_artifacts()
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
        .list_task_artifacts(&task_id)
        .await
        .map(|artifacts| artifacts.into_iter().map(Into::into).collect())
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{assert_no_project_error, build_app_without_services};
    use tauri::Manager;
    use vertebrae_core::CreateArtifactInput;

    async fn create_artifacts(
        app: &tauri::App<tauri::test::MockRuntime>,
        count: usize,
        task_id: Option<&str>,
    ) {
        let artifact_service = {
            let app_state = app.state::<AppState>();
            let services = app_state.services.read().await;
            services
                .as_ref()
                .expect("services initialized")
                .artifacts_arc()
        };

        for index in 0..count {
            let mut input = CreateArtifactInput::new(format!("artifact-{index}.txt"), "body");
            if let Some(task_id) = task_id {
                input = input.with_subject("task", task_id);
            }
            artifact_service
                .create_artifact(input)
                .await
                .expect("create artifact");
        }
    }

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

    #[tokio::test]
    async fn project_artifact_list_returns_all_items_beyond_1000() {
        let app = crate::commands::test_support::build_app_with_services();
        create_artifacts(&app, 1_001, None).await;

        let artifacts = list_project_artifacts(app.state())
            .await
            .expect("list project artifacts");

        assert_eq!(artifacts.len(), 1_001);
        assert_eq!(artifacts.first().unwrap().filename, "artifact-0.txt");
        assert_eq!(artifacts.last().unwrap().filename, "artifact-1000.txt");
    }

    #[tokio::test]
    async fn task_artifact_list_returns_all_items_beyond_1000() {
        let app = crate::commands::test_support::build_app_with_services();
        create_artifacts(&app, 1_001, Some("task-id")).await;

        let artifacts = list_task_artifacts(app.state(), "task-id".into())
            .await
            .expect("list task artifacts");

        assert_eq!(artifacts.len(), 1_001);
        assert_eq!(artifacts.first().unwrap().filename, "artifact-0.txt");
        assert_eq!(artifacts.last().unwrap().filename, "artifact-1000.txt");
    }
}
