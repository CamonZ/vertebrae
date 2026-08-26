use super::*;

// ============================================================================
// Step Commands (First-Class Workflow Steps)
// ============================================================================

/// List all steps for a workflow
///
/// Returns all first-class Step entities associated with the given workflow ID.
#[tauri::command]
#[specta::specta]
pub async fn list_steps_for_workflow(
    state: State<'_, AppState>,
    workflow_id: String,
) -> Result<Vec<Step>, CommandError> {
    log::info!(
        "list_steps_for_workflow called for workflow: {}",
        workflow_id
    );
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service.steps().list_steps_for_workflow(&workflow_id).await {
        Ok(steps) => {
            log::info!("list_steps_for_workflow returned {} steps", steps.len());
            Ok(steps.into_iter().map(Into::into).collect())
        }
        Err(e) => {
            log::error!("list_steps_for_workflow error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Get a single step by ID
///
/// Returns the Step entity with the given ID.
#[tauri::command]
#[specta::specta]
pub async fn get_step(
    state: State<'_, AppState>,
    step_id: String,
) -> Result<Option<Step>, CommandError> {
    log::info!("get_step called for step: {}", step_id);
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service.steps().get_step(&step_id).await {
        Ok(step) => {
            log::info!("get_step returned: {:?}", step.is_some());
            Ok(step.map(Into::into))
        }
        Err(e) => {
            log::error!("get_step error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Create a new step for a workflow
///
/// Creates a new first-class Step entity with the given properties.
#[tauri::command]
#[specta::specta]
pub async fn create_step(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    options: crate::types::CreateStepOptions,
) -> Result<Step, CommandError> {
    let created = create_step_inner(state, options).await?;
    let _ = app_handle.emit(
        "step-changed-event",
        crate::events::StepChangedEvent {
            step_id: created.id.clone().unwrap_or_default(),
            workflow_id: created.workflow_id.clone(),
            change_type: crate::events::StepChangeType::Created,
            step: Some(created.clone()),
        },
    );
    Ok(created)
}

pub(crate) async fn create_step_inner(
    state: State<'_, AppState>,
    options: crate::types::CreateStepOptions,
) -> Result<Step, CommandError> {
    log::info!(
        "create_step called: workflow={}, name={}, order={}",
        options.workflow_id,
        options.name,
        options.order
    );
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Build transitions_to list
    let transitions: Vec<String> = options
        .transitions_to
        .iter()
        .map(|id| id.to_lowercase())
        .collect();

    // Build the step
    let mut step = vertebrae_core::Step::new(&options.name, options.workflow_id)
        .with_agent_config(options.agent_config.unwrap_or_default().into())
        .with_agents(options.agents)
        .with_skills(options.skills)
        .with_order(options.order)
        .with_transitions_to(transitions)
        .with_step_type(options.step_type.into());

    if let Some(goal) = options.goal {
        step = step.with_goal(&goal);
    }

    if let Some(prompt) = options.prompt {
        step = step.with_prompt(&prompt);
    }

    if let Some(schema) = options.output_schema {
        step = step.with_output_schema(schema);
    }

    if let Some(persistence_options) = options.persistence_options {
        step = step.with_persistence_options(persistence_options);
    }

    match service.steps().create_step(&step).await {
        Ok(created) => {
            log::info!("create_step succeeded: {:?}", created.id);
            Ok(created.into())
        }
        Err(e) => {
            log::error!("create_step error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Update an existing step
///
/// Updates the step with the given ID. Only fields that are Some will be updated.
#[tauri::command]
#[specta::specta]
pub async fn update_step(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    options: crate::types::UpdateStepOptions,
) -> Result<(), CommandError> {
    log::info!(
        "update_step called with step_id: '{}', name: {:?}, goal: {:?}, prompt: {:?}",
        options.step_id,
        options.name,
        options.goal,
        options.prompt,
    );
    let step_id = options.step_id.clone();
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_id = update_step_inner(service, &step_id, options.into()).await?;
    let updated_step = service.steps().get_step(&step_id).await?.map(Into::into);

    // Emit step changed event for detail panel listeners
    let _ = app_handle.emit(
        "step-changed-event",
        crate::events::StepChangedEvent {
            step_id: step_id.clone(),
            workflow_id,
            change_type: crate::events::StepChangeType::Updated,
            step: updated_step,
        },
    );

    Ok(())
}

/// Inner logic for update_step, separated for testability.
/// Returns the step's workflow_id for event emission.
pub(crate) async fn update_step_inner(
    service: &VertebraeServices,
    step_id: &str,
    update: vertebrae_core::StepUpdate,
) -> Result<String, CommandError> {
    let workflow_id = service.steps().update_step(step_id, &update).await?;
    log::info!("update_step succeeded for step: {}", step_id);
    Ok(workflow_id)
}

/// Delete a step
///
/// Deletes the step with the given ID.
#[tauri::command]
#[specta::specta]
pub async fn delete_step(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    step_id: String,
) -> Result<(), CommandError> {
    log::info!("delete_step called for step: {}", step_id);
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let workflow_id = delete_step_inner(service, &step_id).await?;

    // Emit step changed event for detail panel listeners
    let _ = app_handle.emit(
        "step-changed-event",
        crate::events::StepChangedEvent {
            step_id: step_id.clone(),
            workflow_id,
            change_type: crate::events::StepChangeType::Deleted,
            step: None,
        },
    );

    Ok(())
}

/// Inner logic for delete_step, separated for testability.
/// Returns the workflow_id of the deleted step.
pub(crate) async fn delete_step_inner(
    service: &VertebraeServices,
    step_id: &str,
) -> Result<String, CommandError> {
    // Verify step exists and capture workflow_id before deletion
    let existing = service.steps().get_step(step_id).await?;
    let step = existing.ok_or_else(|| CommandError {
        message: format!("Step not found: {}", step_id),
    })?;
    let workflow_id = step.workflow_id.clone();

    service.steps().delete_step(step_id).await?;
    log::info!("delete_step succeeded for step: {}", step_id);
    Ok(workflow_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::build_app_with_services;
    use crate::mock::mock_services;
    use tauri::Manager;

    // ========================================================================
    // Step tests (first-class workflow steps)
    // ========================================================================

    #[tokio::test]
    async fn list_steps_for_workflow_empty() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let steps = list_steps_for_workflow(state, "wf-id".to_string())
            .await
            .unwrap();
        assert!(steps.is_empty());
    }

    #[tokio::test]
    async fn create_and_get_step() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let step = create_step_inner(
            state.clone(),
            crate::types::CreateStepOptions {
                workflow_id: "wf-1".to_string(),
                name: "Review".to_string(),
                goal: Some("Review the code".to_string()),
                prompt: Some("Review the code carefully".to_string()),
                agents: vec!["sonnet".to_string()],
                skills: vec![],
                agent_config: None,
                order: 0,
                transitions_to: vec![],
                step_type: Default::default(),
                output_schema: None,
                persistence_options: Some(serde_json::json!({
                    "artifact": { "logical_name": "review-result" }
                })),
            },
        )
        .await
        .unwrap();
        assert_eq!(step.name, "Review");
        assert!(step.id.is_some());
        assert_eq!(
            step.persistence_options,
            Some(serde_json::json!({ "artifact": { "logical_name": "review-result" } }))
        );

        let fetched = get_step(state, step.id.clone().unwrap()).await.unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().name, "Review");
    }

    #[tokio::test]
    async fn create_finish_step_preserves_terminal_type_without_legacy_final_flag() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let step = create_step_inner(
            state,
            crate::types::CreateStepOptions {
                workflow_id: "wf-finish".to_string(),
                name: "Finish".to_string(),
                goal: None,
                prompt: None,
                agents: vec![],
                skills: vec![],
                agent_config: None,
                order: 0,
                transitions_to: vec![],
                step_type: crate::types::StepType::Finish,
                output_schema: None,
                persistence_options: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(step.step_type, crate::types::StepType::Finish);
        assert!(step.transitions_to.is_empty());
    }

    #[tokio::test]
    async fn create_stop_step_preserves_boundary_fields() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let step = create_step_inner(
            state,
            crate::types::CreateStepOptions {
                workflow_id: "wf-stop".to_string(),
                name: "Pause run".to_string(),
                goal: Some("Pause this TaskRun".to_string()),
                prompt: Some("This prompt is not dispatched".to_string()),
                agents: vec!["reviewer".to_string()],
                skills: vec!["simplify".to_string()],
                agent_config: Some(crate::types::AgentConfig {
                    model: Some("gpt-5.5".to_string()),
                    provider: Some(crate::types::AgentProvider::Openai),
                    ..Default::default()
                }),
                order: 1,
                transitions_to: vec!["next-step".to_string()],
                step_type: crate::types::StepType::Stop,
                output_schema: Some(serde_json::json!({"type": "object"})),
                persistence_options: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(step.step_type, crate::types::StepType::Stop);
        assert_eq!(
            step.prompt.as_deref(),
            Some("This prompt is not dispatched")
        );
        assert_eq!(step.transitions_to, vec!["next-step"]);
        assert_eq!(step.agent_config.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(
            step.agent_config.provider,
            Some(crate::types::AgentProvider::Openai)
        );
    }

    #[tokio::test]
    async fn get_step_nonexistent_returns_none() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let step = get_step(state, "nonexistent".to_string()).await.unwrap();
        assert!(step.is_none());
    }

    #[tokio::test]
    async fn list_steps_for_workflow_returns_created_steps() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        create_step_inner(
            state.clone(),
            crate::types::CreateStepOptions {
                workflow_id: "wf-x".to_string(),
                name: "Step1".to_string(),
                goal: None,
                prompt: None,
                agents: vec![],
                skills: vec![],
                agent_config: None,
                order: 0,
                transitions_to: vec![],
                step_type: Default::default(),
                output_schema: None,
                persistence_options: None,
            },
        )
        .await
        .unwrap();
        create_step_inner(
            state.clone(),
            crate::types::CreateStepOptions {
                workflow_id: "wf-x".to_string(),
                name: "Step2".to_string(),
                goal: None,
                prompt: None,
                agents: vec![],
                skills: vec![],
                agent_config: None,
                order: 1,
                transitions_to: vec![],
                step_type: Default::default(),
                output_schema: None,
                persistence_options: None,
            },
        )
        .await
        .unwrap();
        let steps = list_steps_for_workflow(state, "wf-x".to_string())
            .await
            .unwrap();
        assert_eq!(steps.len(), 2);
    }

    // ========================================================================
    // update_step_inner / delete_step_inner tests
    // ========================================================================

    #[tokio::test]
    async fn update_step_inner_succeeds() {
        let services = mock_services();
        let step = vertebrae_core::Step::new("Original", "wf-1".to_string());
        let created = services.steps().create_step(&step).await.unwrap();
        let step_id = created.id.unwrap();

        let update = vertebrae_core::StepUpdate::new()
            .with_name("Updated")
            .with_goal("New goal");
        let wf_id = update_step_inner(&services, &step_id, update)
            .await
            .unwrap();
        assert_eq!(wf_id, "wf-1");
    }

    #[tokio::test]
    async fn update_step_inner_sets_and_clears_persistence_options() {
        let services = mock_services();
        let step = vertebrae_core::Step::new("Persisted", "wf-1".to_string());
        let created = services.steps().create_step(&step).await.unwrap();
        let step_id = created.id.unwrap();

        update_step_inner(
            &services,
            &step_id,
            vertebrae_core::StepUpdate::new().with_persistence_options(Some(
                serde_json::json!({ "artifact": { "logical_name": "result" } }),
            )),
        )
        .await
        .unwrap();
        assert_eq!(
            services
                .steps()
                .get_step(&step_id)
                .await
                .unwrap()
                .unwrap()
                .persistence_options,
            Some(serde_json::json!({ "artifact": { "logical_name": "result" } }))
        );

        update_step_inner(
            &services,
            &step_id,
            vertebrae_core::StepUpdate::new().with_persistence_options(None),
        )
        .await
        .unwrap();
        assert!(services
            .steps()
            .get_step(&step_id)
            .await
            .unwrap()
            .unwrap()
            .persistence_options
            .is_none());
    }

    #[tokio::test]
    async fn update_step_inner_nonexistent_returns_error() {
        let services = mock_services();
        let update = vertebrae_core::StepUpdate::new().with_name("Name");
        let result = update_step_inner(&services, "nonexistent", update).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Step not found"));
    }

    #[tokio::test]
    async fn delete_step_inner_succeeds() {
        let services = mock_services();
        let step = vertebrae_core::Step::new("Doomed", "wf-1".to_string());
        let created = services.steps().create_step(&step).await.unwrap();
        let step_id = created.id.unwrap();

        let wf_id = delete_step_inner(&services, &step_id).await.unwrap();
        assert_eq!(wf_id, "wf-1");

        let fetched = services.steps().get_step(&step_id).await.unwrap();
        assert!(fetched.is_none());
    }

    #[tokio::test]
    async fn delete_step_inner_nonexistent_returns_error() {
        let services = mock_services();
        let result = delete_step_inner(&services, "nonexistent").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Step not found"));
    }
}
