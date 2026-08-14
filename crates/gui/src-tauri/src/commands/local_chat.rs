use super::*;
use crate::local_chat::LocalChatHarnessKind;
use crate::types::PermissionMode;
use std::fs;
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use vertebrae_core::Provider;
use vertebrae_harness::{HarnessFactoryConfig, HarnessRuntimeFactory};
use vertebrae_harness_core::{ProviderResumeId, StreamId, TranscriptReplayRequest};

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
    log::info!(
        "[LOCAL_FILE] open request root={} path={} line={:?} column={:?} editor={:?}",
        project_root,
        path,
        line,
        column,
        editor
    );
    let file = match resolve_local_file(&project_root, &path) {
        Ok(file) => file,
        Err(error) => {
            log::error!("[LOCAL_FILE] file resolution failed: {}", error.message);
            return Err(error);
        }
    };
    log::info!("[LOCAL_FILE] resolved file={}", file.display());
    let editor = editor.and_then(|editor| {
        let editor = editor.trim();
        (!editor.is_empty()).then(|| editor.to_string())
    });

    let result =
        super::open_local_file_with_editor(&app_handle, &file, line, column, editor.as_deref());
    if let Err(error) = &result {
        log::error!("[LOCAL_FILE] launch failed: {}", error.message);
    } else {
        log::info!("[LOCAL_FILE] launch request accepted");
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
    pub model: Option<String>,
    pub selected_model_id: Option<String>,
    pub selected_reasoning_effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub created_at: String,
    pub updated_at: String,
    pub project_path: Option<String>,
    pub provider_resume_id: Option<String>,
    pub thread_total_tokens: Option<u32>,
    pub message_count: u32,
    pub lifecycle: String,
    pub status: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LoadLocalChatSessionReplayOutput {
    /// Each entry is one serialized, normalized HarnessEventV1 JSON object.
    pub events: Vec<String>,
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

fn local_chat_trace(
    kind: &str,
    direction: &str,
    backend_session_id: Option<&str>,
    state: &str,
    detail: Option<String>,
    payload: Option<&str>,
) {
    let record = serde_json::json!({
        "timestamp_ms": chrono::Utc::now().timestamp_millis(),
        "source": "tauri",
        "kind": kind,
        "direction": direction,
        "backend_session_id": backend_session_id,
        "state": state,
        "detail": detail,
        "payload": payload,
    });
    log::info!("[LOCAL_CHAT_TRACE] {record}");
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
    local_chat_manager: State<'_, LocalChatSessionManager>,
    app_handle: tauri::AppHandle,
    input: CreateLocalChatSessionInput,
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

    let backend_session_id = input.backend_session_id.clone();
    local_chat_trace(
        "command.create.requested",
        "gui_to_tauri",
        Some(&backend_session_id),
        "starting",
        None,
        input.initial_prompt.as_deref(),
    );
    let result = local_chat_manager.create_session(input, app_handle).await;
    match &result {
        Ok(()) => local_chat_trace(
            "command.create.accepted",
            "tauri_to_gui",
            Some(&backend_session_id),
            "accepted",
            None,
            None,
        ),
        Err(error) => local_chat_trace(
            "command.create.rejected",
            "tauri_to_gui",
            Some(&backend_session_id),
            "error",
            Some(error.to_string()),
            None,
        ),
    }
    result
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

    local_chat_trace(
        "command.send.requested",
        "gui_to_tauri",
        Some(&backend_session_id),
        "sending",
        None,
        Some(&content),
    );
    let result = local_chat_manager
        .send_message(&backend_session_id, &content)
        .await;
    match &result {
        Ok(()) => local_chat_trace(
            "command.send.accepted",
            "tauri_to_gui",
            Some(&backend_session_id),
            "accepted",
            None,
            None,
        ),
        Err(error) => local_chat_trace(
            "command.send.rejected",
            "tauri_to_gui",
            Some(&backend_session_id),
            "error",
            Some(error.to_string()),
            None,
        ),
    }
    result
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

    match infer_session_title(input).await {
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
        return Ok(LoadLocalChatSessionReplayOutput { events: Vec::new() });
    };
    let provider = match input.harness {
        LocalChatHarnessKind::Claude => Provider::Anthropic,
        LocalChatHarnessKind::Codex => Provider::Openai,
    };
    let request = TranscriptReplayRequest {
        provider_resume_id: ProviderResumeId::new(provider_resume_id.clone()),
        stream_id: StreamId::new(format!("local-replay/{}", input.session_id)),
        project_path: input.project_path.map(PathBuf::from),
        created_at: input.created_at,
    };
    let replay = HarnessRuntimeFactory::new(HarnessFactoryConfig::default())
        .replay_transcript(provider, &request)
        .map_err(|error| CommandError {
            message: format!("Failed to replay local chat transcript: {error}"),
        })?;
    let events = replay
        .map(|replay| {
            replay
                .events
                .iter()
                .map(serde_json::to_string)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()
        .map_err(|error| CommandError {
            message: format!("Failed to serialize local chat replay: {error}"),
        })?
        .unwrap_or_default();
    Ok(LoadLocalChatSessionReplayOutput { events })
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
