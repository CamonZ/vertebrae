use super::*;
use crate::local_chat::LocalChatHarnessKind;
use crate::types::PermissionMode;
use std::fs;
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use vertebrae_core::StepHarness;
use vertebrae_harness::{HarnessFactoryConfig, HarnessRuntimeFactory};
use vertebrae_harness_core::{
    HarnessEventPayloadV1, ProviderResumeId, StreamId, TranscriptReplayPageRequest,
    TranscriptReplayRequest, TurnInputProvenance,
};

/// Open a validated local-chat file reference with the operating system's
/// external file handler. The frontend supplies the captured project root and
/// the raw reference path; canonicalization here closes symlink and traversal
/// gaps before invoking the opener plugin.
#[tauri::command]
#[specta::specta]
pub fn open_local_file(
    app_handle: tauri::AppHandle,
    project_root: String,
    path: String,
    line: Option<u32>,
    column: Option<u32>,
    editor: Option<String>,
) -> Result<(), CommandError> {
    let file = match resolve_local_file(&project_root, &path) {
        Ok(file) => file,
        Err(error) => {
            log::error!("[LOCAL_FILE] file resolution failed: {}", error.message);
            return Err(error);
        }
    };
    let editor = editor.and_then(|editor| {
        let editor = editor.trim();
        (!editor.is_empty()).then(|| editor.to_string())
    });

    let result =
        super::open_local_file_with_editor(&app_handle, &file, line, column, editor.as_deref());
    if let Err(error) = &result {
        log::error!("[LOCAL_FILE] launch failed: {}", error.message);
    }
    result
}

/// Return the canonical project and Git worktree roots that local-chat file
/// references may target.
#[tauri::command]
#[specta::specta]
pub fn get_local_file_roots(project_root: String) -> Result<Vec<String>, CommandError> {
    let root = fs::canonicalize(project_root).map_err(|error| CommandError {
        message: format!("Could not resolve project root: {error}"),
    })?;
    if !root.is_dir() {
        return Err(CommandError {
            message: "The captured project root is not a directory".to_string(),
        });
    }

    Ok(local_file_roots(&root)
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

fn resolve_local_file(project_root: &str, path: &str) -> Result<PathBuf, CommandError> {
    let root = fs::canonicalize(project_root).map_err(|error| CommandError {
        message: format!("Could not resolve project root: {error}"),
    })?;
    if !root.is_dir() {
        return Err(CommandError {
            message: "The captured project root is not a directory".to_string(),
        });
    }

    let requested = PathBuf::from(path);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let file = fs::canonicalize(&candidate).map_err(|error| CommandError {
        message: format!("Could not resolve local file reference: {error}"),
    })?;
    let allowed_roots = local_file_roots(&root);
    if !allowed_roots
        .iter()
        .any(|allowed_root| file.starts_with(allowed_root))
        || !file.is_file()
    {
        return Err(CommandError {
            message: "Local file reference is outside the captured project or its Git worktrees"
                .to_string(),
        });
    }
    Ok(file)
}

fn local_file_roots(project_root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![project_root.to_path_buf()];
    let output = Command::new("git")
        .args([
            "-C",
            &project_root.to_string_lossy(),
            "worktree",
            "list",
            "--porcelain",
        ])
        .output();

    let Ok(output) = output else {
        return roots;
    };
    if !output.status.success() {
        return roots;
    }

    for worktree in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
    {
        if let Ok(worktree) = fs::canonicalize(worktree) {
            if worktree.is_dir() && !roots.contains(&worktree) {
                roots.push(worktree);
            }
        }
    }
    roots
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalChatSessionIndexEntry {
    pub id: String,
    pub label: String,
    pub title: Option<String>,
    pub title_status: Option<String>,
    pub title_confidence: Option<f64>,
    pub title_user_message_count: u32,
    pub harness: LocalChatHarnessKind,
    /// Provider the session was started with; absent means the harness's
    /// built-in provider.
    #[serde(default)]
    #[specta(optional)]
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub selected_model_id: Option<String>,
    pub selected_reasoning_effort: Option<String>,
    pub selected_personality: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub created_at: String,
    pub updated_at: String,
    pub project_path: Option<String>,
    pub provider_resume_id: Option<String>,
    pub thread_total_tokens: Option<u32>,
    pub message_count: u32,
    pub lifecycle: String,
    pub status: String,
    /// Waiting `human_input` gate the chat resolves; Resolve reopens the chat
    /// bound to the same run and step.
    #[serde(default)]
    #[specta(optional)]
    pub gate: Option<crate::local_chat::LocalChatGateBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveLocalChatSessionIndexInput {
    pub sessions: Vec<LocalChatSessionIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LoadLocalChatSessionReplayInput {
    pub session_id: String,
    pub harness: LocalChatHarnessKind,
    pub provider_resume_id: Option<String>,
    pub project_path: Option<String>,
    pub created_at: Option<String>,
    /// Opaque cursor returned by the previous (newer) replay page.
    pub cursor: Option<String>,
    /// Requested normalized event count; the harness applies a safe maximum.
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LoadLocalChatSessionReplayOutput {
    /// Each entry is one serialized, normalized HarnessEventV1 JSON object.
    pub events: Vec<String>,
    pub cache_key: Option<String>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalChatSessionIndexFile {
    version: u32,
    sessions: Vec<LocalChatSessionIndexEntry>,
}

fn local_chat_session_index_path() -> Result<PathBuf, CommandError> {
    let data_dir = vertebrae_installer::data_dir().map_err(|error| CommandError {
        message: format!("Could not determine app data directory: {}", error),
    })?;
    fs::create_dir_all(&data_dir).map_err(|error| CommandError {
        message: format!("Failed to create app data directory: {}", error),
    })?;
    Ok(data_dir.join("local-chat-session-index.json"))
}

// ============================================================================
// Local Chat Commands
// ============================================================================

/// List supported local chat harnesses for provider-neutral local sessions.
#[tauri::command]
#[specta::specta]
pub async fn get_supported_local_chat_harnesses(
    local_chat_manager: State<'_, LocalChatSessionManager>,
) -> Result<LocalChatHarnessCatalog, CommandError> {
    Ok(local_chat_manager.catalog().await)
}

/// Create a provider-neutral local chat session.
#[tauri::command]
#[specta::specta]
pub async fn create_local_chat_session(
    state: State<'_, AppState>,
    local_chat_manager: State<'_, LocalChatSessionManager>,
    app_handle: tauri::AppHandle,
    mut input: CreateLocalChatSessionInput,
) -> Result<(), LocalChatSessionError> {
    log::info!(
        "create_local_chat_session called: harness={:?}, backend_session_id={}, working_dir={:?}, resume={:?}, model={:?}, permission_mode={:?}",
        input.harness,
        input.backend_session_id,
        input.working_dir,
        input.provider_resume_id,
        input.model_id,
        input.permission_mode
    );

    let input = match input.gate {
        Some(gate) => {
            let service_guard = state.services.read().await;
            let service = service_guard
                .as_ref()
                .ok_or(LocalChatSessionError::StartFailed(
                    "No project selected. Please select a project first.".into(),
                ))?;
            let gate = validate_gate_binding(service, gate).await?;
            drop(service_guard);
            input.gate = Some(gate);
            input
        }
        None => input,
    };

    local_chat_manager.create_session(input, app_handle).await
}

/// Rebind a live gate chat to the currently waiting execution and send the
/// updated hidden protocol as a turn. Returns whether a turn was sent; the
/// chat already bound to that execution receives nothing.
#[tauri::command]
#[specta::specta]
pub async fn refresh_local_chat_session_gate(
    state: State<'_, AppState>,
    local_chat_manager: State<'_, LocalChatSessionManager>,
    backend_session_id: String,
    gate: crate::local_chat::LocalChatGateBinding,
) -> Result<bool, LocalChatSessionError> {
    let service_guard = state.services.read().await;
    let service = service_guard
        .as_ref()
        .ok_or(LocalChatSessionError::StartFailed(
            "No project selected. Please select a project first.".into(),
        ))?;
    let gate = validate_gate_binding(service, gate).await?;
    drop(service_guard);

    local_chat_manager
        .refresh_gate(&backend_session_id, gate)
        .await
}

async fn validate_gate_binding(
    service: &vertebrae_core::VertebraeServices,
    supplied: crate::local_chat::LocalChatGateBinding,
) -> Result<crate::local_chat::LocalChatGateBinding, LocalChatSessionError> {
    let trace = service
        .executions()
        .task_run_trace(&supplied.task_run_id)
        .await
        .map_err(|error| {
            LocalChatSessionError::StartFailed(format!("Failed to validate gate chat: {error}"))
        })?;
    canonical_gate_binding(trace, supplied)
}

fn canonical_gate_binding(
    trace: vertebrae_core::TaskRunTrace,
    supplied: crate::local_chat::LocalChatGateBinding,
) -> Result<crate::local_chat::LocalChatGateBinding, LocalChatSessionError> {
    let run_is_waiting = trace.task_runs.iter().any(|run| {
        run.id == supplied.task_run_id && run.status == vertebrae_core::TaskRunStatus::Waiting
    });
    if !run_is_waiting {
        return Err(LocalChatSessionError::StartFailed(
            "The human input gate is no longer waiting".into(),
        ));
    }

    let mut attempts = trace
        .step_executions
        .iter()
        .filter(|execution| {
            execution.id.as_deref() == Some(supplied.execution_id.as_str())
                && execution.task_run_id.as_deref() == Some(supplied.task_run_id.as_str())
                && execution.step_name == supplied.step_name
                && execution.step_type.as_deref() == Some("human_input")
        })
        .collect::<Vec<_>>();
    if attempts.len() != 1 {
        return Err(LocalChatSessionError::StartFailed(
            "The gate chat does not match a human input execution".into(),
        ));
    }

    let gate_attempts = trace
        .step_executions
        .iter()
        .filter(|execution| {
            execution.task_run_id.as_deref() == Some(supplied.task_run_id.as_str())
                && execution.step_name == supplied.step_name
                && execution.step_type.as_deref() == Some("human_input")
        })
        .collect::<Vec<_>>();
    let latest_attempt = gate_attempts
        .iter()
        .max_by_key(|execution| execution.started_at);
    if latest_attempt.and_then(|execution| execution.id.as_deref())
        != Some(supplied.execution_id.as_str())
    {
        return Err(LocalChatSessionError::StartFailed(
            "The gate chat refers to an earlier execution of this step".into(),
        ));
    }

    let execution = attempts.remove(0);
    let config = execution.config.as_ref().ok_or_else(|| {
        LocalChatSessionError::StartFailed("The human input execution has no config".into())
    })?;
    let vertebrae_core::StepConfig::HumanInput(config) = config else {
        return Err(LocalChatSessionError::StartFailed(
            "The human input execution has a non-human-input config".into(),
        ));
    };
    let artifact = config
        .artifact
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            LocalChatSessionError::StartFailed("The human input step has no artifact".into())
        })?;

    Ok(crate::local_chat::LocalChatGateBinding {
        task_run_id: supplied.task_run_id,
        step_name: supplied.step_name,
        execution_id: supplied.execution_id,
        artifact: artifact.to_string(),
        role: config.role.clone(),
        question: config.question.clone(),
        output_schema: config.output_schema.clone(),
        revision: gate_revision(gate_attempts.len(), execution.handoff.as_deref()),
        draftable: Some(config.draftable),
        // The trace read carries the draft, so a (re)started chat picks up
        // from the persisted answers instead of re-asking them.
        draft: config
            .draftable
            .then(|| execution.draft.clone().map(Into::into))
            .flatten(),
        fields: config
            .output_schema
            .as_ref()
            .map(crate::local_chat::gate::gate_fields),
    })
}

/// A gate visited more than once in its run is a revision; the waiting
/// execution's handoff carries the review's verdict.
fn gate_revision(
    attempts: usize,
    handoff: Option<&str>,
) -> Option<crate::local_chat::LocalChatGateRevision> {
    if attempts < 2 {
        return None;
    }
    let verdict = handoff
        .map(str::trim)
        .filter(|handoff| !handoff.is_empty())
        .map(|handoff| {
            serde_json::from_str(handoff)
                .unwrap_or_else(|_| serde_json::Value::String(handoff.to_string()))
        });
    Some(crate::local_chat::LocalChatGateRevision {
        attempt: u32::try_from(attempts).unwrap_or(u32::MAX),
        verdict,
    })
}

/// Send a message to a provider-neutral local chat session.
#[tauri::command]
#[specta::specta]
pub async fn send_local_chat_message(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    backend_session_id: String,
    content: String,
) -> Result<(), LocalChatSessionError> {
    log::info!(
        "send_local_chat_message called: backend_session_id={}, content_len={}",
        backend_session_id,
        content.len()
    );

    local_chat_manager
        .send_message(&backend_session_id, &content)
        .await
}

/// Compact an idle local conversation, waiting for provider completion.
#[tauri::command]
#[specta::specta]
pub async fn compact_local_chat_session(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    backend_session_id: String,
) -> Result<(), LocalChatSessionError> {
    local_chat_manager
        .compact_session(&backend_session_id)
        .await
}

/// Close a provider-neutral local chat session.
#[tauri::command]
#[specta::specta]
pub async fn close_local_chat_session(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    backend_session_id: String,
) -> Result<(), LocalChatSessionError> {
    log::info!(
        "close_local_chat_session called: backend_session_id={}",
        backend_session_id
    );
    local_chat_manager.close_session(&backend_session_id).await
}

/// Infer a concise display title for a local chat from its initial prompt.
#[tauri::command]
#[specta::specta]
pub async fn infer_local_chat_session_title(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    input: InferLocalChatSessionTitleInput,
) -> Result<InferLocalChatSessionTitleOutput, CommandError> {
    let harness = input.harness;
    let prompt_count = input.initial_prompts.len();
    let working_dir = input.working_dir.clone();
    log::info!(
        "infer_local_chat_session_title called: harness={:?}, prompt_count={}, working_dir={:?}",
        harness,
        prompt_count,
        working_dir
    );

    let custom_provider = match custom_title_provider(
        local_chat_manager.provider_profiles(),
        input.provider_id.as_deref(),
    ) {
        Ok(custom_provider) => custom_provider,
        Err(message) => {
            log::warn!("infer_local_chat_session_title failed: {message}");
            return Err(CommandError { message });
        }
    };

    match infer_session_title(input, custom_provider).await {
        Ok(output) => {
            log::info!(
                "infer_local_chat_session_title succeeded: harness={:?}, title_present={}, confidence={:.2}, sufficient_signal={}",
                harness,
                output.title.as_ref().is_some_and(|title| !title.trim().is_empty()),
                output.confidence,
                output.sufficient_signal
            );
            Ok(output)
        }
        Err(message) => {
            log::warn!(
                "infer_local_chat_session_title failed: harness={:?}, error={}",
                harness,
                message
            );
            Err(CommandError { message })
        }
    }
}

/// Load the app-managed local chat metadata index.
#[tauri::command]
#[specta::specta]
pub async fn load_local_chat_session_index() -> Result<Vec<LocalChatSessionIndexEntry>, CommandError>
{
    let path = local_chat_session_index_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|error| CommandError {
        message: format!("Failed to read local chat session index: {}", error),
    })?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value = serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| CommandError {
        message: format!("Failed to parse local chat session index: {}", error),
    })?;
    if value.is_array() {
        return serde_json::from_value::<Vec<LocalChatSessionIndexEntry>>(value).map_err(|error| {
            CommandError {
                message: format!("Failed to decode local chat session index: {}", error),
            }
        });
    }
    let index = serde_json::from_value::<LocalChatSessionIndexFile>(value).map_err(|error| {
        CommandError {
            message: format!("Failed to decode local chat session index: {}", error),
        }
    })?;
    Ok(index.sessions)
}

/// Save the app-managed local chat metadata index atomically.
#[tauri::command]
#[specta::specta]
pub async fn save_local_chat_session_index(
    input: SaveLocalChatSessionIndexInput,
) -> Result<(), CommandError> {
    let path = local_chat_session_index_path()?;
    let index = LocalChatSessionIndexFile {
        version: 1,
        sessions: input.sessions,
    };
    let serialized = serde_json::to_string_pretty(&index).map_err(|error| CommandError {
        message: format!("Failed to serialize local chat session index: {}", error),
    })?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, serialized).map_err(|error| CommandError {
        message: format!("Failed to write local chat session index: {}", error),
    })?;
    fs::rename(&tmp_path, &path).map_err(|error| CommandError {
        message: format!("Failed to replace local chat session index: {}", error),
    })?;
    Ok(())
}

/// Launch settings for title inference on a custom provider; `None` for
/// built-in providers.
fn custom_title_provider(
    profiles: &std::collections::BTreeMap<
        vertebrae_core::ProviderId,
        vertebrae_core::ProviderProfile,
    >,
    provider_id: Option<&str>,
) -> Result<Option<vertebrae_harness::CustomProviderProcessLaunch>, String> {
    let Some(provider_id) = provider_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let id = vertebrae_core::ProviderId::new(provider_id)?;
    if id.is_builtin() {
        return Ok(None);
    }
    HarnessRuntimeFactory::new(HarnessFactoryConfig {
        environment: crate::shell_environment::user_shell_environment().variables,
        provider_profiles: profiles.clone(),
        ..HarnessFactoryConfig::default()
    })
    .custom_provider_process_launch(&id)
    .map(Some)
    .map_err(|error| error.to_string())
}

/// Discover and replay a persisted provider transcript through the
/// provider-owned harness adapter. The GUI receives only normalized V1 event
/// JSON and never needs to know the Claude or Codex file layout.
#[tauri::command]
#[specta::specta]
pub async fn load_local_chat_session_replay(
    input: LoadLocalChatSessionReplayInput,
) -> Result<LoadLocalChatSessionReplayOutput, CommandError> {
    let Some(provider_resume_id) = input
        .provider_resume_id
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(LoadLocalChatSessionReplayOutput {
            events: Vec::new(),
            cache_key: None,
            next_cursor: None,
            has_more: false,
        });
    };
    let harness = match input.harness {
        LocalChatHarnessKind::Claude => StepHarness::Claude,
        LocalChatHarnessKind::Codex => StepHarness::Codex,
    };
    let claude_local_chat = input.harness == LocalChatHarnessKind::Claude;
    let session_id = input.session_id.clone();
    let request = TranscriptReplayRequest {
        provider_resume_id: ProviderResumeId::new(provider_resume_id.clone()),
        stream_id: StreamId::new(format!("local-replay/{}", input.session_id)),
        project_path: input.project_path.map(PathBuf::from),
        created_at: input.created_at,
    };
    let page_request = TranscriptReplayPageRequest {
        cursor: input.cursor,
        limit: input.limit.map(|limit| limit as usize),
    };
    let replay = tauri::async_runtime::spawn_blocking(move || {
        HarnessRuntimeFactory::new(HarnessFactoryConfig::default()).replay_transcript_page(
            harness,
            &request,
            &page_request,
        )
    })
    .await
    .map_err(|error| CommandError {
        message: format!("Failed to join local chat replay loader: {error}"),
    })?
    .map_err(|error| CommandError {
        message: format!("Failed to replay local chat transcript: {error}"),
    })?;
    let events = replay
        .as_ref()
        .map(|page| {
            if claude_local_chat {
                for event in &page.events {
                    if let HarnessEventPayloadV1::TurnInput(turn_input) = &event.payload {
                        if turn_input.provenance == TurnInputProvenance::Human {
                            let timestamp = event.timestamp.to_rfc3339();
                            crate::telemetry::record_message_received(
                                "persisted_jsonl",
                                event
                                    .correlation
                                    .session_id
                                    .as_ref()
                                    .map(|id| id.as_str())
                                    .unwrap_or(&session_id),
                                turn_input.thread_id.as_str(),
                                event.correlation.turn_id.as_ref().map(|id| id.as_str()),
                                event.provider_sequence.or(Some(event.sequence)),
                                Some(&timestamp),
                                &turn_input.content,
                            );
                        }
                    }
                }
            }
            page.events
                .iter()
                .map(serde_json::to_string)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()
        .map_err(|error| CommandError {
            message: format!("Failed to serialize local chat replay: {error}"),
        })?
        .unwrap_or_default();
    Ok(LoadLocalChatSessionReplayOutput {
        events,
        cache_key: replay.as_ref().map(|page| page.cache_key.clone()),
        next_cursor: replay.as_ref().and_then(|page| page.next_cursor.clone()),
        has_more: replay.as_ref().is_some_and(|page| page.has_more),
    })
}

/// Resolve a local chat permission request shown in the GUI.
#[tauri::command]
#[specta::specta]
pub async fn resolve_permission_request(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    input: ResolvePermissionRequestInput,
) -> Result<serde_json::Value, ResolvePermissionRequestError> {
    resolve_permission_request_inner(&local_chat_manager, input)
}

pub(crate) fn resolve_permission_request_inner(
    local_chat_manager: &LocalChatSessionManager,
    input: ResolvePermissionRequestInput,
) -> Result<serde_json::Value, ResolvePermissionRequestError> {
    let (behavior, message, updated_input) = match input.behavior {
        PermissionDecisionBehavior::Allow => {
            let updated_input = match input.updated_input {
                Some(value @ serde_json::Value::Object(_)) => Some(value),
                Some(_) => {
                    return Err(ResolvePermissionRequestError {
                        kind: ResolvePermissionRequestErrorKind::Invalid,
                        message:
                            "Allowed permission requests require updated_input to be a JSON object."
                                .to_string(),
                    });
                }
                None => Some(json!({})),
            };
            ("allow", None, updated_input)
        }
        PermissionDecisionBehavior::Deny => (
            "deny",
            Some(
                input
                    .message
                    .unwrap_or_else(|| "Denied from Vertebrae GUI".to_string()),
            ),
            None,
        ),
    };

    local_chat_manager
        .resolve_permission_request(
            &input.request_id,
            LocalPermissionDecision {
                behavior: behavior.to_string(),
                message,
                updated_input,
            },
        )
        .map_err(permission_resolution_error)
}

fn permission_resolution_error(error: PermissionBridgeError) -> ResolvePermissionRequestError {
    match error {
        PermissionBridgeError::NotFound(request_id) => ResolvePermissionRequestError {
            kind: ResolvePermissionRequestErrorKind::NotFound,
            message: format!("Permission request not found or already resolved: {request_id}"),
        },
        PermissionBridgeError::Unavailable => ResolvePermissionRequestError {
            kind: ResolvePermissionRequestErrorKind::Unavailable,
            message: "Permission request connection is no longer available".to_string(),
        },
        PermissionBridgeError::Invalid(message) => ResolvePermissionRequestError {
            kind: ResolvePermissionRequestErrorKind::Invalid,
            message,
        },
        PermissionBridgeError::Internal(message) => ResolvePermissionRequestError {
            kind: ResolvePermissionRequestErrorKind::Internal,
            message,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn gate_trace(
        status: vertebrae_core::TaskRunStatus,
        second_execution: bool,
    ) -> vertebrae_core::TaskRunTrace {
        let started_at = chrono::Utc::now();
        let mut executions = vec![vertebrae_core::StepExecution {
            id: Some("exec-1".into()),
            task_id: "task-1".into(),
            task_run_id: Some("run-1".into()),
            workflow_id: "workflow-1".into(),
            step_name: "approve".into(),
            step_type: Some("human_input".into()),
            started_at,
            completed_at: None,
            status: vertebrae_core::ExecutionStatus::InProgress,
            context: None,
            config: Some(vertebrae_core::StepConfig::HumanInput(
                vertebrae_core::HumanInputConfig {
                    role: Some("Authoritative role.".into()),
                    question: Some("Authoritative question?".into()),
                    artifact: Some("approval".into()),
                    output_schema: Some(serde_json::json!({ "type": "object" })),
                    ..Default::default()
                },
            )),
            output: None,
            transition_result: None,
            model_used: None,
            session_id: None,
            token_usage: None,
            cost_usd: None,
            duration_ms: None,
            model_provider: None,
            handoff: None,
            draft: None,
        }];
        if second_execution {
            executions.push(vertebrae_core::StepExecution {
                id: Some("exec-2".into()),
                started_at: started_at + chrono::Duration::seconds(1),
                ..executions[0].clone()
            });
        }
        vertebrae_core::TaskRunTrace {
            root_task_run_id: "run-1".into(),
            task_runs: vec![vertebrae_core::TaskRun {
                id: "run-1".into(),
                task_id: "task-1".into(),
                project_id: "project-1".into(),
                user_id: None,
                status,
                max_concurrency: None,
                started_at: None,
                ended_at: None,
                stop_requested_at: None,
                latest_step_execution_id: Some("exec-1".into()),
                outcome_kind: None,
                outcome_context: None,
                parent_task_run_id: None,
                root_task_run_id: Some("run-1".into()),
                triggered_by_step_execution_id: None,
                inserted_at: None,
                updated_at: None,
            }],
            step_executions: executions,
            session_logs: Vec::new(),
        }
    }

    fn supplied_gate() -> crate::local_chat::LocalChatGateBinding {
        crate::local_chat::LocalChatGateBinding {
            task_run_id: "run-1".into(),
            step_name: "approve".into(),
            execution_id: "exec-1".into(),
            artifact: "forged".into(),
            role: Some("Forged role.".into()),
            question: Some("Forged question?".into()),
            output_schema: Some(serde_json::json!("forged")),
            revision: None,
            draftable: None,
            draft: None,
            fields: None,
        }
    }

    #[test]
    fn gate_bindings_are_rebuilt_from_the_waiting_execution_config() {
        let gate = canonical_gate_binding(
            gate_trace(vertebrae_core::TaskRunStatus::Waiting, false),
            supplied_gate(),
        )
        .expect("valid gate");

        assert_eq!(gate.artifact, "approval");
        assert_eq!(gate.role.as_deref(), Some("Authoritative role."));
        assert_eq!(gate.question.as_deref(), Some("Authoritative question?"));
        assert_eq!(
            gate.output_schema,
            Some(serde_json::json!({ "type": "object" }))
        );
    }

    #[test]
    fn draftable_gate_bindings_carry_sacrums_flag_draft_and_fields() {
        let mut trace = gate_trace(vertebrae_core::TaskRunStatus::Waiting, false);
        let execution = &mut trace.step_executions[0];
        let Some(vertebrae_core::StepConfig::HumanInput(config)) = execution.config.as_mut() else {
            panic!("human_input config");
        };
        config.output_schema = Some(serde_json::json!({
            "type": "object",
            "required": ["approved"],
            "properties": { "approved": { "type": "boolean", "description": "Ship?" } }
        }));
        config.draftable = true;
        let mut values = serde_json::Map::new();
        values.insert("approved".into(), serde_json::json!(true));
        execution.draft = Some(vertebrae_core::HumanInputDraft {
            execution_id: "exec-1".into(),
            values,
            missing: Vec::new(),
            invalid: Vec::new(),
            complete: true,
            updated_at: None,
        });

        let gate = canonical_gate_binding(
            trace,
            crate::local_chat::LocalChatGateBinding {
                draftable: Some(false),
                ..supplied_gate()
            },
        )
        .expect("valid gate");

        assert_eq!(gate.draftable, Some(true));
        let draft = gate.draft.expect("the draft seeds the protocol");
        assert_eq!(draft.values, serde_json::json!({ "approved": true }));
        assert!(draft.complete);
        let fields = gate.fields.expect("fields for the progress panel");
        assert_eq!(fields[0].name, "approved");
        assert_eq!(fields[0].question.as_deref(), Some("Ship?"));
    }

    #[test]
    fn non_draftable_gate_bindings_carry_no_draft() {
        let gate = canonical_gate_binding(
            gate_trace(vertebrae_core::TaskRunStatus::Waiting, false),
            crate::local_chat::LocalChatGateBinding {
                draftable: Some(true),
                ..supplied_gate()
            },
        )
        .expect("valid gate");

        assert_eq!(gate.draftable, Some(false));
        assert_eq!(gate.draft, None);
    }

    #[test]
    fn rebinding_a_revisited_gate_carries_the_attempt_and_verdict() {
        let mut trace = gate_trace(vertebrae_core::TaskRunStatus::Waiting, true);
        trace.step_executions[1].handoff = Some(r#"{"reasons":"Missing rollback plan"}"#.into());
        let supplied = crate::local_chat::LocalChatGateBinding {
            execution_id: "exec-2".into(),
            revision: Some(crate::local_chat::LocalChatGateRevision {
                attempt: 9,
                verdict: Some(serde_json::json!("forged")),
            }),
            ..supplied_gate()
        };

        let gate = canonical_gate_binding(trace, supplied).expect("valid revision");

        assert_eq!(
            gate.revision,
            Some(crate::local_chat::LocalChatGateRevision {
                attempt: 2,
                verdict: Some(serde_json::json!({ "reasons": "Missing rollback plan" })),
            })
        );
    }

    #[test]
    fn first_gate_visits_are_not_revisions() {
        let gate = canonical_gate_binding(
            gate_trace(vertebrae_core::TaskRunStatus::Waiting, false),
            supplied_gate(),
        )
        .expect("valid gate");

        assert_eq!(gate.revision, None);
        assert_eq!(
            gate_revision(2, Some("not json")).and_then(|revision| revision.verdict),
            Some(serde_json::json!("not json"))
        );
    }

    #[test]
    fn gate_bindings_reject_stale_executions_and_closed_runs() {
        let stale = canonical_gate_binding(
            gate_trace(vertebrae_core::TaskRunStatus::Waiting, true),
            supplied_gate(),
        )
        .expect_err("earlier attempt must be rejected");
        assert!(stale.to_string().contains("earlier execution"));

        let closed = canonical_gate_binding(
            gate_trace(vertebrae_core::TaskRunStatus::Completed, false),
            supplied_gate(),
        )
        .expect_err("closed run must be rejected");
        assert!(closed.to_string().contains("no longer waiting"));
    }

    #[test]
    fn permission_resolution_errors_have_stable_kinds() {
        for (error, expected_kind) in [
            (
                PermissionBridgeError::NotFound("request-1".to_string()),
                ResolvePermissionRequestErrorKind::NotFound,
            ),
            (
                PermissionBridgeError::Unavailable,
                ResolvePermissionRequestErrorKind::Unavailable,
            ),
            (
                PermissionBridgeError::Invalid("bad input".to_string()),
                ResolvePermissionRequestErrorKind::Invalid,
            ),
            (
                PermissionBridgeError::Internal("lock failed".to_string()),
                ResolvePermissionRequestErrorKind::Internal,
            ),
        ] {
            assert_eq!(permission_resolution_error(error).kind, expected_kind);
        }
    }

    #[test]
    fn permission_command_rejects_non_object_updated_input_as_invalid() {
        let manager = LocalChatSessionManager::with_harnesses_for_tests(Vec::new());
        let error = resolve_permission_request_inner(
            &manager,
            ResolvePermissionRequestInput {
                request_id: "request-1".to_string(),
                behavior: PermissionDecisionBehavior::Allow,
                message: None,
                updated_input: Some(json!([])),
            },
        )
        .unwrap_err();

        assert_eq!(error.kind, ResolvePermissionRequestErrorKind::Invalid);
    }

    #[test]
    fn local_file_resolution_requires_a_canonical_file_under_the_project_root() {
        let root = tempdir().expect("temporary root");
        let inside = root.path().join("src").join("main.rs");
        fs::create_dir_all(inside.parent().expect("parent")).expect("source directory");
        fs::write(&inside, "fn main() {}\n").expect("source file");

        let resolved = resolve_local_file(root.path().to_str().unwrap(), "src/main.rs")
            .expect("contained source file");
        assert_eq!(resolved, fs::canonicalize(inside).unwrap());

        let outside = root.path().parent().unwrap().join("outside.rs");
        fs::write(&outside, "fn outside() {}\n").expect("outside file");
        let error = resolve_local_file(root.path().to_str().unwrap(), outside.to_str().unwrap())
            .expect_err("outside file must be rejected");
        assert!(error.message.contains("outside the captured project"));
        let _ = fs::remove_file(outside);
    }
}
