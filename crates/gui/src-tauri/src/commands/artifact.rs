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

/// Promote a chat statechart fence to an artifact attached to its ticket.
#[tauri::command]
#[specta::specta]
pub async fn save_statechart_artifact(
    state: State<'_, AppState>,
    body: String,
    ticket_id: String,
) -> Result<Artifact, CommandError> {
    use vertebrae_core::{ArtifactLinkMetadata, CreateArtifactInput, Level};

    // Keep the service and attachment target in one project snapshot. Project
    // switching takes these locks in the same order.
    let services = state.services.read().await;
    let service = services
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;
    let client = state.sacrum_client.read().await;
    let client = client
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;
    let ticket = service.tasks().get_task_without_lookups(&ticket_id).await?;
    if ticket.level != Level::Ticket
        || ticket
            .project_id
            .as_deref()
            .is_some_and(|id| id != client.project_id())
    {
        return Err(CommandError {
            message: "Statecharts must be saved to a ticket in the active project.".into(),
        });
    }
    let metadata = ArtifactLinkMetadata::new("statechart", "json", "chat", "rendered")
        .with_extension("statechart_format", json!("xstate-v5"));
    let input = CreateArtifactInput::new("diagram.statechart.json", body)
        .with_subject("task", ticket_id)
        .with_metadata(metadata);

    service
        .artifacts()
        .create_artifact(input)
        .await
        .map(Into::into)
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

/// Read-only presentation projections for artifact entity links. Root artifact
/// reads have no attachment metadata, and Project.artifacts omits task links.
#[tauri::command]
#[specta::specta]
pub async fn list_artifact_presentations(
    state: State<'_, AppState>,
) -> Result<Vec<Artifact>, CommandError> {
    use std::collections::HashSet;
    use vertebrae_sacrum_client::api_types::ArtifactResponse;

    #[derive(Deserialize)]
    struct Subject {
        artifacts: Vec<ArtifactResponse>,
    }

    #[derive(Deserialize)]
    struct TaskSubject {
        id: String,
        artifacts: Vec<ArtifactResponse>,
    }

    #[derive(Deserialize)]
    struct Presentations {
        project: Subject,
        tasks: Vec<TaskSubject>,
    }

    // Capture one client/project before the await. The frontend independently
    // retires this result when its initiating project generation changes.
    let client = state
        .sacrum_client
        .read()
        .await
        .clone()
        .ok_or_else(CommandError::no_project_selected)?;
    let project_id = client.project_id();
    let variables = json!({ "project_id": project_id });

    let query = format!(
        r#"
        query ArtifactPresentations($project_id: Uuid4!) {{
            project(id: $project_id) {{ artifacts {{ ...ArtifactFields }} }}
            tasks(project_id: $project_id, include_archived: true) {{
                id artifacts {{ ...ArtifactFields }}
            }}
        }}
        {}"#,
        vertebrae_sacrum_client::queries::artifacts::ARTIFACT_FIELDS
    );

    let mut data: Presentations =
        client
            .execute_compound(&query, variables)
            .await
            .map_err(|error| CommandError {
                message: error.to_string(),
            })?;

    // Presentation belongs to an attachment. Prefer the explicit project
    // projection, then task UUID order, independent of backend list ordering.
    data.tasks.sort_by(|a, b| a.id.cmp(&b.id));
    let task_artifacts = data.tasks.into_iter().flat_map(|task| task.artifacts);
    let artifacts = data.project.artifacts.into_iter().chain(task_artifacts);
    let mut seen = HashSet::new();

    artifacts
        .filter(|artifact| {
            let artifact_id = artifact.id.clone();

            seen.insert(artifact_id)
        })
        .map(|mut artifact| {
            // Membership was established by the two project-scoped associations.
            let owning_project = project_id.to_string();
            artifact.project_id = Some(owning_project);

            let converted = artifact.into_artifact();

            converted.map(Into::into).map_err(Into::into)
        })
        .collect()
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
    async fn saving_statechart_requires_a_selected_project() {
        let app = build_app_without_services();
        assert_no_project_error(
            save_statechart_artifact(app.state(), "{}".into(), "ticket-id".into()).await,
        );
    }

    #[tokio::test]
    async fn saving_statechart_preserves_body_and_presentation_attachment() {
        let app = crate::commands::test_support::build_app_with_services();
        let project_id = "33333333-3333-4333-8333-333333333333";
        let config = vertebrae_sacrum_client::SacrumConfig::new(
            "http://localhost:4000".into(),
            "test-token".into(),
            project_id.into(),
        );
        let client = vertebrae_sacrum_client::GraphqlClient::new(config);
        *app.state::<AppState>().sacrum_client.write().await = Some(std::sync::Arc::new(client));
        let ticket_id = crate::commands::create_task(
            app.state(),
            "Chart ticket".into(),
            None,
            Some("ticket".into()),
            None,
        )
        .await
        .expect("create ticket");
        let body = "{\"id\":\"delivery\",\"initial\":\"Work\",\"states\":{\"Work\":{}}}";

        let artifact = save_statechart_artifact(app.state(), body.into(), ticket_id.clone())
            .await
            .expect("save chart");

        let attached = list_task_artifacts(app.state(), ticket_id)
            .await
            .expect("ticket artifacts");
        assert_eq!(attached.len(), 1);
        assert_eq!(attached[0].id, artifact.id);
        assert_eq!(artifact.body, body);
        assert_eq!(artifact.filename, "diagram.statechart.json");
        let metadata = artifact.metadata.expect("attachment metadata");
        assert_eq!(metadata.content_kind, "statechart");
        assert_eq!(metadata.format, "json");
        assert_eq!(metadata.presentation, "rendered");
        assert_eq!(metadata.extensions["statechart_format"], "xstate-v5");
    }

    #[tokio::test]
    async fn saving_statechart_rejects_missing_or_non_ticket_subjects() {
        let app = crate::commands::test_support::build_app_with_services();
        let config = vertebrae_sacrum_client::SacrumConfig::new(
            "http://localhost:4000".into(),
            "test-token".into(),
            "mock-project".into(),
        );
        *app.state::<AppState>().sacrum_client.write().await = Some(std::sync::Arc::new(
            vertebrae_sacrum_client::GraphqlClient::new(config),
        ));
        let task_id = crate::commands::create_task(
            app.state(),
            "Not a ticket".into(),
            None,
            Some("task".into()),
            None,
        )
        .await
        .unwrap();
        for id in [task_id, "missing-ticket".into(), "".into()] {
            assert!(save_statechart_artifact(app.state(), "{}".into(), id)
                .await
                .is_err());
        }
        assert!(list_project_artifacts(app.state())
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn project_artifacts_require_a_selected_project() {
        let app = build_app_without_services();
        assert_no_project_error(list_project_artifacts(app.state()).await);
    }

    #[tokio::test]
    async fn presentations_require_a_selected_project() {
        let app = build_app_without_services();
        let state = app.state();

        let result = list_artifact_presentations(state).await;

        assert_no_project_error(result);
    }

    #[tokio::test]
    async fn presentations_resolve_project_and_archived_task_attachments_in_one_scope() {
        use wiremock::matchers::{body_string_contains, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let project_id = "33333333-3333-4333-8333-333333333333";
        let project_artifact_id = "11111111-1111-4111-8111-111111111111";
        let task_artifact_id = "22222222-2222-4222-8222-222222222222";
        let item = |id: &str, body: &str| {
            let metadata = json!({
                "version": 1,
                "content_kind": "statechart",
                "format": "json",
                "origin": "test",
                "presentation": "rendered",
                "extensions": {}
            });

            json!({
                "id": id,
                "filename": "chart.json",
                "body": body,
                "metadata": metadata
            })
        };

        let project_artifact = item(project_artifact_id, "project");
        let later_task_artifact = item(task_artifact_id, "later task");
        let ignored_task_artifact = item(project_artifact_id, "ignored task");
        let first_task_artifact = item(task_artifact_id, "first task");
        let project = json!({ "artifacts": [project_artifact] });
        let later_task = json!({
            "id": "z",
            "artifacts": [later_task_artifact, ignored_task_artifact]
        });
        let first_task = json!({ "id": "a", "artifacts": [first_task_artifact] });
        let response = json!({
            "data": { "project": project, "tasks": [later_task, first_task] }
        });
        let response_template = ResponseTemplate::new(200).set_body_json(response);

        let post = method("POST");
        let graphql = path("/graphql");
        let archived_tasks = body_string_contains("include_archived: true");
        let operation = body_string_contains("ArtifactPresentations");

        Mock::given(post)
            .and(graphql)
            .and(archived_tasks)
            .and(operation)
            .respond_with(response_template)
            .expect(1)
            .mount(&server)
            .await;

        let app = build_app_without_services();
        let state = app.state::<AppState>();
        let endpoint = server.uri();
        let config = vertebrae_sacrum_client::SacrumConfig::new(
            endpoint,
            "test-token".into(),
            project_id.into(),
        );
        let client = vertebrae_sacrum_client::GraphqlClient::new(config);
        let shared_client = std::sync::Arc::new(client);

        *state.sacrum_client.write().await = Some(shared_client);

        let result = list_artifact_presentations(state).await.unwrap();
        let correct_project = result
            .iter()
            .all(|artifact| artifact.project_id.as_deref() == Some(project_id));
        let task_metadata = result[1].metadata.as_ref().unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].body, "project");
        assert_eq!(result[1].body, "first task");
        assert!(correct_project);
        assert_eq!(task_metadata.content_kind, "statechart");

        let requests = server.received_requests().await.unwrap();
        let request_body = &requests[0].body;
        let request: serde_json::Value = serde_json::from_slice(request_body).unwrap();
        let expected_variables = json!({ "project_id": project_id });

        assert_eq!(request["variables"], expected_variables);
        server.verify().await;
    }

    #[tokio::test]
    async fn presentations_surface_backend_failures_without_success_shaped_empty_data() {
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let post = wiremock::matchers::method("POST");
        let response = ResponseTemplate::new(500);

        Mock::given(post)
            .respond_with(response)
            .mount(&server)
            .await;

        let app = build_app_without_services();
        let state = app.state::<AppState>();
        let endpoint = server.uri();
        let config = vertebrae_sacrum_client::SacrumConfig::new(
            endpoint,
            "test-token".into(),
            "33333333-3333-4333-8333-333333333333".into(),
        );
        let client = vertebrae_sacrum_client::GraphqlClient::new(config);
        let shared_client = std::sync::Arc::new(client);

        *state.sacrum_client.write().await = Some(shared_client);

        let result = list_artifact_presentations(state).await;

        assert!(result.is_err());
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
