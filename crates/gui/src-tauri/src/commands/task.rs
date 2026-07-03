use super::*;

// ============================================================================
// Task Query Commands
// ============================================================================

/// List tasks with optional filters
///
/// Returns a list of task summaries matching the filter criteria.
#[tauri::command]
#[specta::specta]
pub async fn list_tasks(
    state: State<'_, AppState>,
    filter: Option<TaskFilterOptions>,
) -> Result<Vec<Task>, CommandError> {
    log::info!("list_tasks called with filter: {:?}", filter);
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let db_filter: vertebrae_core::TaskFilter = filter.unwrap_or_default().into();
    match service.tasks().list_tasks(&db_filter).await {
        Ok(summaries) => {
            log::info!("list_tasks returned {} tasks", summaries.len());
            Ok(summaries.into_iter().map(Into::into).collect())
        }
        Err(e) => {
            log::error!("list_tasks error: {:?}", e);
            Err(e.into())
        }
    }
}

/// List tasks that are ready to be worked on.
///
/// Mirrors `vtb ready`: the backend `list_ready` query returns tasks that are
/// not completed and have no incomplete blockers; archived tasks are filtered
/// out here, exactly as the CLI does.
#[tauri::command]
#[specta::specta]
pub async fn list_ready(state: State<'_, AppState>) -> Result<Vec<Task>, CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    match service.tasks().list_ready().await {
        Ok(mut tasks) => {
            tasks.retain(|t| !t.archived);
            log::info!("list_ready returned {} tasks", tasks.len());
            Ok(tasks.into_iter().map(Into::into).collect())
        }
        Err(e) => {
            log::error!("list_ready error: {:?}", e);
            Err(e.into())
        }
    }
}

/// Get a single task by ID with its relations
///
/// Returns the full task details.
#[tauri::command]
#[specta::specta]
pub async fn get_task(state: State<'_, AppState>, id: String) -> Result<Task, CommandError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let task = service.tasks().get_task(&id).await?;

    Ok(task.into())
}

// ============================================================================
// Task Relationship Commands
// ============================================================================

/// Set the parent task
///
/// Sets the parent of the given task. If the task already has a parent, it will be replaced.
/// Validates that both tasks exist.
#[tauri::command]
#[specta::specta]
pub async fn set_parent(
    state: State<'_, AppState>,
    task_id: String,
    parent_id: String,
) -> Result<(), CommandError> {
    log::info!(
        "set_parent called with task_id: {}, parent_id: {}",
        task_id,
        parent_id
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.tasks().set_parent(&task_id, &parent_id).await?;

    log::info!("Successfully set parent for task {}", task_id);
    Ok(())
}

/// Remove the parent task
///
/// Removes the parent relationship from the given task, making it a root task.
#[tauri::command]
#[specta::specta]
pub async fn remove_parent(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), CommandError> {
    log::info!("remove_parent called with task_id: {}", task_id);

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.tasks().remove_parent(&task_id).await?;

    log::info!("Successfully removed parent for task {}", task_id);
    Ok(())
}

/// Add a dependency relationship
///
/// Makes the given task depend on another task (the task is blocked by the dependency).
/// Validates that both tasks exist and that adding the dependency won't create a cycle.
#[tauri::command]
#[specta::specta]
pub async fn add_dependency(
    state: State<'_, AppState>,
    task_id: String,
    depends_on_id: String,
) -> Result<(), CommandError> {
    log::info!(
        "add_dependency called with task_id: {}, depends_on_id: {}",
        task_id,
        depends_on_id
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .tasks()
        .add_dependency(&task_id, &depends_on_id)
        .await?;

    log::info!("Successfully added dependency for task {}", task_id);
    Ok(())
}

/// Remove a dependency relationship
///
/// Removes a dependency from the given task (the task is no longer blocked by this dependency).
#[tauri::command]
#[specta::specta]
pub async fn remove_dependency(
    state: State<'_, AppState>,
    task_id: String,
    depends_on_id: String,
) -> Result<(), CommandError> {
    log::info!(
        "remove_dependency called with task_id: {}, depends_on_id: {}",
        task_id,
        depends_on_id
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .tasks()
        .remove_dependency(&task_id, &depends_on_id)
        .await?;

    log::info!("Successfully removed dependency for task {}", task_id);
    Ok(())
}

/// Replace the full dependency set for a task
///
/// Saves picker changes atomically instead of issuing one mutation per add/remove.
#[tauri::command]
#[specta::specta]
pub async fn sync_dependencies(
    state: State<'_, AppState>,
    task_id: String,
    depends_on_ids: Vec<String>,
) -> Result<(), CommandError> {
    log::info!(
        "sync_dependencies called with task_id: {}, {} dependencies",
        task_id,
        depends_on_ids.len()
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service
        .tasks()
        .sync_dependencies(&task_id, &depends_on_ids)
        .await?;

    log::info!("Successfully synced dependencies for task {}", task_id);
    Ok(())
}

// ============================================================================
// Task Mutation Commands (Create, Update, Assign Workflow)
// ============================================================================

/// Create a new task with the given title, optional description, level, and parent task
///
/// Returns the ID of the newly created task.
/// Validates that parent task exists if specified.
#[tauri::command]
#[specta::specta]
pub async fn create_task(
    state: State<'_, AppState>,
    title: String,
    description: Option<String>,
    level: Option<String>,
    parent_id: Option<String>,
) -> Result<String, CommandError> {
    log::info!(
        "create_task called with title: '{}', parent: {:?}",
        title,
        parent_id
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse level if provided
    let parsed_level = if let Some(level_str) = level {
        match level_str.to_lowercase().as_str() {
            "epic" => Some(vertebrae_core::Level::Epic),
            "ticket" => Some(vertebrae_core::Level::Ticket),
            "task" => Some(vertebrae_core::Level::Task),
            _ => {
                return Err(CommandError {
                    message: format!("Invalid level: {}", level_str),
                })
            }
        }
    } else {
        None
    };

    // Build creation options
    let mut options = vertebrae_core::CreateTaskOptions::new(title);
    if let Some(desc) = description {
        options = options.with_description(desc);
    }
    if let Some(lv) = parsed_level {
        options = options.with_level(lv);
    }
    if let Some(parent) = parent_id {
        options.parent_id = Some(parent);
    }

    let task_id = service.tasks().create_task(options).await?;
    log::info!("Successfully created task with ID: {}", task_id);
    Ok(task_id)
}

/// Update a task with multiple fields
///
/// Specify only the fields you want to update. Omitted fields remain unchanged.
#[tauri::command]
#[specta::specta]
pub async fn update_task(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    task_id: String,
    options: crate::types::UpdateTaskOptions,
) -> Result<(), CommandError> {
    log::info!(
        "update_task called with task_id: '{}', options: {:?}",
        task_id,
        options
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    update_task_inner(service, &task_id, options).await?;

    // Emit task changed event so UI listeners can update
    let _ = app_handle.emit(
        "task-changed-event",
        crate::events::TaskChangedEvent {
            task_id: task_id.clone(),
            change_type: crate::events::TaskChangeType::Updated,
            task: None,
            current_step_id: None,
            workflow_id: None,
            level: None,
            archived: None,
        },
    );

    Ok(())
}

/// Inner logic for update_task, separated for testability.
pub(crate) async fn update_task_inner(
    service: &VertebraeServices,
    task_id: &str,
    options: crate::types::UpdateTaskOptions,
) -> Result<(), CommandError> {
    // Build update options
    let mut update_opts = vertebrae_core::UpdateTaskOptions::new();

    if let Some(new_title) = options.title {
        update_opts = update_opts.with_title(new_title);
    }

    if let Some(new_desc) = options.description {
        update_opts.description = Some(new_desc);
    }

    if let Some(new_priority) = options.priority {
        update_opts.priority = Some(new_priority.map(|p| {
            match p.to_lowercase().as_str() {
                "high" => vertebrae_core::Priority::High,
                "medium" => vertebrae_core::Priority::Medium,
                "low" => vertebrae_core::Priority::Low,
                "critical" => vertebrae_core::Priority::Critical,
                _ => vertebrae_core::Priority::Medium, // Default to medium if invalid
            }
        }));
    }

    if let Some(new_level) = options.level {
        update_opts.level = Some(new_level);
    }

    if let Some(archived) = options.archived {
        update_opts.archived = Some(archived);
    }

    if let Some(new_worktree) = options.worktree {
        update_opts.worktree = Some(new_worktree);
    }

    service.tasks().update_task(task_id, update_opts).await?;
    log::info!("Successfully updated task: {}", task_id);
    Ok(())
}

/// Assign a workflow to a task
///
/// Associates the given workflow with the task for workflow state management.
#[tauri::command]
#[specta::specta]
pub async fn assign_workflow(
    state: State<'_, AppState>,
    task_id: String,
    workflow_id: String,
) -> Result<(), CommandError> {
    log::info!(
        "assign_workflow called with task_id: '{}', workflow_id: '{}'",
        task_id,
        workflow_id
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Assign the workflow to the task
    service
        .tasks()
        .assign_workflow(&task_id, &workflow_id)
        .await?;
    log::info!("Successfully assigned workflow to task: {}", task_id);
    Ok(())
}

/// Delete a task with optional cascade delete for child tasks
///
/// When cascade is true, deletes the task and all its descendants.
/// When cascade is false, deletes the task but orphans its children (they lose their parent).
///
/// This operation is atomic - either fully succeeds or fully fails.
#[tauri::command]
#[specta::specta]
pub async fn delete_task(
    state: State<'_, AppState>,
    task_id: String,
    cascade: bool,
) -> Result<(), CommandError> {
    log::info!(
        "delete_task called with task_id: {}, cascade: {}",
        task_id,
        cascade
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    service.tasks().delete_task(&task_id, cascade).await?;

    log::info!("Successfully deleted task: {}", task_id);
    Ok(())
}

// ============================================================================
// Section Mutation Commands
// ============================================================================

/// Add a section to a task
///
/// Creates a new section with the given type and content.
/// For step and testing_criterion types, content can be optional.
/// The order is assigned by Sacrum.
#[tauri::command]
#[specta::specta]
pub async fn add_section(
    state: State<'_, AppState>,
    task_id: String,
    section_type: String,
    content: Option<String>,
) -> Result<Section, CommandError> {
    log::info!(
        "add_section called with task_id: {}, section_type: {}",
        task_id,
        section_type
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse section type
    let parsed_type = section_type
        .parse::<vertebrae_core::SectionType>()
        .map_err(|e| CommandError { message: e })?;
    let is_single_instance = parsed_type.is_single_instance();

    // Use provided content or empty string
    let section_content = content.unwrap_or_default();

    let section = vertebrae_core::Section {
        section_type: parsed_type,
        content: section_content,
        order: None,
        done: None,
        done_at: None,
        refs: Vec::new(),
    };

    let created = if is_single_instance {
        service.tasks().upsert_section(&task_id, section).await?
    } else {
        service.tasks().add_section(&task_id, section).await?
    };

    log::info!("Successfully added section to task: {}", task_id);
    Ok(created.into())
}

/// Edit a section's content by its ordinal (position)
///
/// Updates the content of an existing section identified by its type and ordinal.
#[tauri::command]
#[specta::specta]
pub async fn edit_section(
    state: State<'_, AppState>,
    task_id: String,
    section_type: String,
    ordinal: u32,
    new_content: String,
) -> Result<Section, CommandError> {
    log::info!(
        "edit_section called with task_id: {}, section_type: {}, ordinal: {}",
        task_id,
        section_type,
        ordinal
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse section type
    let parsed_type = section_type
        .parse::<vertebrae_core::SectionType>()
        .map_err(|e| CommandError { message: e })?;

    let updated = service
        .tasks()
        .edit_section_by_ordinal(&task_id, parsed_type, ordinal, &new_content)
        .await?;

    log::info!("Successfully edited section in task: {}", task_id);
    Ok(updated.into())
}

/// Toggle the completion status of a checklist item
///
/// Marks a checklist item as done or not done by toggling its done flag.
/// For checklist item sections only (other types will return an error).
#[tauri::command]
#[specta::specta]
pub async fn toggle_checklist_item_done(
    state: State<'_, AppState>,
    task_id: String,
    ordinal: u32,
) -> Result<Section, CommandError> {
    log::info!(
        "toggle_checklist_item_done called with task_id: {}, ordinal: {}",
        task_id,
        ordinal
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Use service method to toggle the checklist item done status
    let updated = service
        .tasks()
        .toggle_checklist_item_done(&task_id, ordinal)
        .await?;

    log::info!(
        "Successfully toggled checklist item done status for task: {}",
        task_id
    );
    Ok(updated.into())
}

/// Remove a section from a task by its ordinal (position)
///
/// Deletes a section identified by its type and ordinal.
/// Remaining sections of the same type are renumbered.
#[tauri::command]
#[specta::specta]
pub async fn remove_section(
    state: State<'_, AppState>,
    task_id: String,
    section_type: String,
    ordinal: u32,
) -> Result<Section, CommandError> {
    log::info!(
        "remove_section called with task_id: {}, section_type: {}, ordinal: {}",
        task_id,
        section_type,
        ordinal
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Parse section type
    let parsed_type = section_type
        .parse::<vertebrae_core::SectionType>()
        .map_err(|e| CommandError { message: e })?;

    let removed = service
        .tasks()
        .remove_section_by_ordinal(&task_id, parsed_type, ordinal)
        .await?;

    log::info!("Successfully removed section from task: {}", task_id);
    Ok(removed.into())
}

/// Add a code reference to a testing criterion section
///
/// Appends a code reference to an existing testing criterion section.
#[tauri::command]
#[specta::specta]
pub async fn add_criterion_ref(
    state: State<'_, AppState>,
    task_id: String,
    section_ordinal: u32,
    file_path: String,
    line_number: Option<u32>,
    name: Option<String>,
) -> Result<(), CommandError> {
    log::info!(
        "add_criterion_ref called with task_id: {}, section_ordinal: {}, file_path: {}",
        task_id,
        section_ordinal,
        file_path
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Get the task to find the section index (0-based) from ordinal
    let task = service.tasks().get_task(&task_id).await?;

    // Find the section index (0-based) by ordinal within testing_criterion sections
    let section_index = task
        .sections
        .iter()
        .enumerate()
        .find(|(_, s)| {
            s.section_type == vertebrae_core::SectionType::TestingCriterion
                && s.order == Some(section_ordinal)
        })
        .map(|(idx, _)| idx)
        .ok_or_else(|| CommandError {
            message: format!(
                "Testing criterion section with ordinal {} not found in task {}",
                section_ordinal, task_id
            ),
        })?;

    // Create the code reference
    let code_ref = vertebrae_core::CodeRef {
        path: file_path,
        line_start: line_number,
        line_end: None,
        name,
        description: None,
    };

    service
        .tasks()
        .append_section_ref(&task_id, section_index, &code_ref)
        .await?;

    log::info!(
        "Successfully added code reference to testing criterion in task: {}",
        task_id
    );
    Ok(())
}

// ============================================================================
// Code Reference Commands
// ============================================================================

/// Add a code reference to a task
///
/// Appends a code reference with optional line numbers and description.
#[tauri::command]
#[specta::specta]
pub async fn add_code_ref(
    state: State<'_, AppState>,
    task_id: String,
    path: String,
    line_start: Option<u32>,
    line_end: Option<u32>,
    name: Option<String>,
    description: Option<String>,
) -> Result<(), CommandError> {
    log::info!(
        "add_code_ref called with task_id: {}, path: {}",
        task_id,
        path
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let code_ref = vertebrae_core::CodeRef {
        path,
        line_start,
        line_end,
        name,
        description,
    };

    service.tasks().add_code_ref(&task_id, code_ref).await?;
    log::info!("Successfully added code_ref to task: {}", task_id);
    Ok(())
}

/// Remove code references from a task
///
/// Deletes one or more code references from the given task.
///
/// * `indices` - If provided, only these 0-based indices will be removed. Otherwise all are removed.
#[tauri::command]
#[specta::specta]
pub async fn remove_code_refs(
    state: State<'_, AppState>,
    task_id: String,
    indices: Option<Vec<u32>>,
) -> Result<(), CommandError> {
    log::info!(
        "remove_code_refs called with task_id: {}, indices: {:?}",
        task_id,
        indices
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    // Convert u32 indices to usize for internal use
    let indices_usize = indices.map(|v| v.into_iter().map(|i| i as usize).collect::<Vec<usize>>());

    let removed_count = indices_usize.as_ref().map_or(0, Vec::len);
    service
        .tasks()
        .remove_code_refs(&task_id, indices_usize)
        .await?;

    log::info!(
        "Successfully removed {} code_refs from task: {}",
        removed_count,
        task_id
    );
    Ok(())
}

/// Replace all code references for a task
///
/// Removes all existing code references and adds the provided ones.
#[tauri::command]
#[specta::specta]
pub async fn replace_code_refs(
    state: State<'_, AppState>,
    task_id: String,
    refs: Vec<crate::types::CodeRef>,
) -> Result<(), CommandError> {
    log::info!(
        "replace_code_refs called with task_id: {}, {} refs",
        task_id,
        refs.len()
    );

    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or_else(CommandError::no_project_selected)?;

    let db_refs = refs
        .into_iter()
        .map(|code_ref| vertebrae_core::CodeRef {
            path: code_ref.path,
            line_start: code_ref.line_start,
            line_end: code_ref.line_end,
            name: code_ref.name,
            description: code_ref.description,
        })
        .collect::<Vec<_>>();

    service.tasks().set_code_refs(&task_id, &db_refs).await?;

    log::info!("Successfully replaced code refs for task: {}", task_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::build_app_with_services;
    use crate::commands::test_support::build_app_without_services;
    use crate::mock::mock_services;
    use tauri::Manager;

    #[tokio::test]
    async fn list_tasks_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = list_tasks(state, None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("No project selected"));
    }

    #[tokio::test]
    async fn get_task_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_task(state, "id".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn create_task_no_project_returns_error() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = create_task(state, "Test".to_string(), None, None, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn create_task_returns_id() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state, "My Task".to_string(), None, None, None)
            .await
            .unwrap();
        assert!(!id.is_empty());
    }

    #[tokio::test]
    async fn create_task_with_description_and_level() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(
            state.clone(),
            "Epic Task".to_string(),
            Some("Description".to_string()),
            Some("epic".to_string()),
            None,
        )
        .await
        .unwrap();
        assert!(!id.is_empty());
    }

    #[tokio::test]
    async fn create_task_invalid_level_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = create_task(
            state,
            "Bad".to_string(),
            None,
            Some("invalid_level".to_string()),
            None,
        )
        .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("Invalid level"));
    }

    #[tokio::test]
    async fn create_task_with_parent() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(state.clone(), "Parent".to_string(), None, None, None)
            .await
            .unwrap();
        let child_id = create_task(
            state.clone(),
            "Child".to_string(),
            None,
            None,
            Some(parent_id.clone()),
        )
        .await
        .unwrap();
        assert!(!child_id.is_empty());
    }

    #[tokio::test]
    async fn create_task_with_nonexistent_parent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = create_task(
            state,
            "Orphan".to_string(),
            None,
            Some("nonexistent".to_string()),
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn get_task_returns_task_details() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(
            state.clone(),
            "Detail Task".to_string(),
            Some("desc".to_string()),
            None,
            None,
        )
        .await
        .unwrap();
        let task = get_task(state, id.clone()).await.unwrap();
        assert_eq!(task.title, "Detail Task");
        assert_eq!(task.id, id);
    }

    #[tokio::test]
    async fn get_task_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = get_task(state, "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn list_tasks_returns_created_tasks() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        create_task(state.clone(), "Task 1".to_string(), None, None, None)
            .await
            .unwrap();
        create_task(state.clone(), "Task 2".to_string(), None, None, None)
            .await
            .unwrap();
        let tasks = list_tasks(state, None).await.unwrap();
        assert_eq!(tasks.len(), 2);
    }

    #[tokio::test]
    async fn list_tasks_with_filter() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        create_task(
            state.clone(),
            "An Epic".to_string(),
            None,
            Some("epic".to_string()),
            None,
        )
        .await
        .unwrap();
        create_task(
            state.clone(),
            "A Task".to_string(),
            None,
            Some("task".to_string()),
            None,
        )
        .await
        .unwrap();
        let filter = crate::types::TaskFilterOptions {
            levels: Some(vec![crate::types::TaskLevel::Epic]),
            ..Default::default()
        };
        let tasks = list_tasks(state, Some(filter)).await.unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "An Epic");
    }

    #[tokio::test]
    async fn delete_task_removes_task() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Doomed".to_string(), None, None, None)
            .await
            .unwrap();
        delete_task(state.clone(), id.clone(), false).await.unwrap();
        let result = get_task(state, id).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn delete_task_cascade() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(state.clone(), "Parent".to_string(), None, None, None)
            .await
            .unwrap();
        let _child_id = create_task(
            state.clone(),
            "Child".to_string(),
            None,
            None,
            Some(parent_id.clone()),
        )
        .await
        .unwrap();
        delete_task(state.clone(), parent_id, true).await.unwrap();
        let tasks = list_tasks(state, None).await.unwrap();
        assert!(tasks.is_empty());
    }

    #[tokio::test]
    async fn delete_nonexistent_task_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = delete_task(state, "nonexistent".to_string(), false).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // update_task_inner tests
    // ========================================================================

    #[tokio::test]
    async fn update_task_inner_changes_title() {
        let services = mock_services();
        let id = services
            .tasks()
            .create_task(vertebrae_core::CreateTaskOptions::new(
                "Original".to_string(),
            ))
            .await
            .unwrap();

        let opts = crate::types::UpdateTaskOptions {
            title: Some("New".to_string()),
            ..Default::default()
        };
        update_task_inner(&services, &id, opts).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.title, "New");
    }

    #[tokio::test]
    async fn update_task_inner_changes_priority() {
        let services = mock_services();
        let id = services
            .tasks()
            .create_task(vertebrae_core::CreateTaskOptions::new("Task".to_string()))
            .await
            .unwrap();

        let opts = crate::types::UpdateTaskOptions {
            priority: Some(Some("high".to_string())),
            ..Default::default()
        };
        update_task_inner(&services, &id, opts).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.priority, Some(vertebrae_core::Priority::High));
    }

    #[tokio::test]
    async fn update_task_inner_clears_priority() {
        let services = mock_services();
        let id = services
            .tasks()
            .create_task(vertebrae_core::CreateTaskOptions::new("Task".to_string()))
            .await
            .unwrap();

        let opts = crate::types::UpdateTaskOptions {
            priority: Some(None),
            ..Default::default()
        };
        update_task_inner(&services, &id, opts).await.unwrap();

        let task = services.tasks().get_task(&id).await.unwrap();
        assert_eq!(task.priority, None);
    }

    #[tokio::test]
    async fn update_task_inner_nonexistent_returns_error() {
        let services = mock_services();
        let opts = crate::types::UpdateTaskOptions {
            title: Some("New".to_string()),
            ..Default::default()
        };
        let result = update_task_inner(&services, "nonexistent", opts).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // Relationship tests
    // ========================================================================

    #[tokio::test]
    async fn set_parent_and_get_relations() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(state.clone(), "Parent".to_string(), None, None, None)
            .await
            .unwrap();
        let child_id = create_task(state.clone(), "Child".to_string(), None, None, None)
            .await
            .unwrap();

        set_parent(state.clone(), child_id.clone(), parent_id.clone())
            .await
            .unwrap();

        let child = get_task(state, child_id).await.unwrap();
        assert_eq!(child.parent_id.as_deref(), Some(parent_id.as_str()));
    }

    #[tokio::test]
    async fn remove_parent_clears_relation() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let parent_id = create_task(state.clone(), "Parent".to_string(), None, None, None)
            .await
            .unwrap();
        let child_id = create_task(state.clone(), "Child".to_string(), None, None, None)
            .await
            .unwrap();
        set_parent(state.clone(), child_id.clone(), parent_id)
            .await
            .unwrap();
        remove_parent(state.clone(), child_id.clone())
            .await
            .unwrap();

        let child = get_task(state, child_id).await.unwrap();
        assert_eq!(child.parent_id, None);
    }

    #[tokio::test]
    async fn add_and_remove_dependency() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_a = create_task(state.clone(), "A".to_string(), None, None, None)
            .await
            .unwrap();
        let task_b = create_task(state.clone(), "B".to_string(), None, None, None)
            .await
            .unwrap();

        add_dependency(state.clone(), task_a.clone(), task_b.clone())
            .await
            .unwrap();
        let task = get_task(state.clone(), task_a.clone()).await.unwrap();
        assert!(task.dependency_ids.contains(&task_b));

        remove_dependency(state.clone(), task_a.clone(), task_b.clone())
            .await
            .unwrap();
        let task = get_task(state, task_a).await.unwrap();
        assert!(!task.dependency_ids.contains(&task_b));
    }

    #[tokio::test]
    async fn sync_dependencies_replaces_dependency_set() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_a = create_task(state.clone(), "A".to_string(), None, None, None)
            .await
            .unwrap();
        let task_b = create_task(state.clone(), "B".to_string(), None, None, None)
            .await
            .unwrap();

        sync_dependencies(state.clone(), task_a.clone(), vec![task_b.clone()])
            .await
            .unwrap();
        let task = get_task(state.clone(), task_a.clone()).await.unwrap();
        assert_eq!(task.dependency_ids, vec![task_b.clone()]);

        sync_dependencies(state.clone(), task_a.clone(), vec![])
            .await
            .unwrap();
        let task = get_task(state, task_a).await.unwrap();
        assert!(task.dependency_ids.is_empty());
    }

    #[tokio::test]
    async fn sync_dependencies_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        let result = sync_dependencies(state, task_id, vec!["nonexistent".to_string()]).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn set_parent_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = set_parent(state, task_id, "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn add_dependency_nonexistent_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let task_id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = add_dependency(state, task_id, "nonexistent".to_string()).await;
        assert!(result.is_err());
    }

    // ========================================================================
    // Section tests
    // ========================================================================

    #[tokio::test]
    async fn add_section_to_task() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "checklist_item".to_string(),
            Some("Do the thing".to_string()),
        )
        .await
        .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].content, "Do the thing");
    }

    #[tokio::test]
    async fn add_section_invalid_type_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = add_section(state, id, "bad_type".to_string(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("invalid section type"));
    }

    #[tokio::test]
    async fn add_section_all_valid_types() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        let types = vec![
            "goal",
            "context",
            "current_behavior",
            "desired_behavior",
            "checklist_item",
            "testing_criterion",
            "anti_pattern",
            "failure_test",
            "constraint",
        ];
        for section_type in types {
            add_section(
                state.clone(),
                id.clone(),
                section_type.to_string(),
                Some("content".to_string()),
            )
            .await
            .unwrap();
        }

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections.len(), 9);
    }

    #[tokio::test]
    async fn edit_section_changes_content() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "checklist_item".to_string(),
            Some("Original".to_string()),
        )
        .await
        .unwrap();

        edit_section(
            state.clone(),
            id.clone(),
            "checklist_item".to_string(),
            0,
            "Updated content".to_string(),
        )
        .await
        .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections[0].content, "Updated content");
    }

    #[tokio::test]
    async fn edit_section_invalid_type_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = edit_section(state, id, "bad_type".to_string(), 0, "x".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn remove_section_removes_it() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "checklist_item".to_string(),
            Some("Step 1".to_string()),
        )
        .await
        .unwrap();

        remove_section(state.clone(), id.clone(), "checklist_item".to_string(), 0)
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert!(task.sections.is_empty());
    }

    #[tokio::test]
    async fn remove_section_invalid_type_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = remove_section(state, id, "bad_type".to_string(), 0).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn toggle_checklist_item_done_toggles_item() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_section(
            state.clone(),
            id.clone(),
            "checklist_item".to_string(),
            Some("Do it".to_string()),
        )
        .await
        .unwrap();

        toggle_checklist_item_done(state.clone(), id.clone(), 0)
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections[0].done, Some(true));
    }

    // ========================================================================
    // Code reference tests
    // ========================================================================

    #[tokio::test]
    async fn add_and_replace_code_refs() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_code_ref(
            state.clone(),
            id.clone(),
            "src/main.rs".to_string(),
            None,
            None,
            Some("main fn".to_string()),
            None,
        )
        .await
        .unwrap();

        let task = get_task(state.clone(), id.clone()).await.unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");

        // Replace with new refs
        let new_refs = vec![crate::types::CodeRef {
            path: "src/lib.rs".to_string(),
            line_start: Some(10),
            line_end: Some(20),
            name: Some("lib".to_string()),
            description: None,
        }];
        replace_code_refs(state.clone(), id.clone(), new_refs)
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/lib.rs");
    }

    #[tokio::test]
    async fn remove_code_refs_all() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        add_code_ref(
            state.clone(),
            id.clone(),
            "a.rs".to_string(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        add_code_ref(
            state.clone(),
            id.clone(),
            "b.rs".to_string(),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        remove_code_refs(state.clone(), id.clone(), None)
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert!(task.code_refs.is_empty());
    }

    #[tokio::test]
    async fn remove_code_refs_selective_keeps_survivors() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        for path in ["a.rs", "b.rs", "c.rs"] {
            add_code_ref(
                state.clone(),
                id.clone(),
                path.to_string(),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        }

        remove_code_refs(state.clone(), id.clone(), Some(vec![1]))
            .await
            .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(
            task.code_refs
                .iter()
                .map(|code_ref| code_ref.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.rs", "c.rs"]
        );
    }

    #[tokio::test]
    async fn add_criterion_ref_to_testing_criterion() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();

        // Add a testing criterion section
        add_section(
            state.clone(),
            id.clone(),
            "testing_criterion".to_string(),
            Some("It should work".to_string()),
        )
        .await
        .unwrap();

        // Add a code ref to the criterion
        add_criterion_ref(
            state.clone(),
            id.clone(),
            0,
            "tests/test.rs".to_string(),
            Some(10),
            Some("test_fn".to_string()),
        )
        .await
        .unwrap();

        let task = get_task(state, id).await.unwrap();
        assert_eq!(task.sections[0].refs.len(), 1);
        assert_eq!(task.sections[0].refs[0].path, "tests/test.rs");
    }

    #[tokio::test]
    async fn add_criterion_ref_nonexistent_section_returns_error() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let id = create_task(state.clone(), "Task".to_string(), None, None, None)
            .await
            .unwrap();
        let result = add_criterion_ref(state, id, 0, "test.rs".to_string(), None, None).await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .message
            .contains("Testing criterion section"));
    }
}
