use super::*;
use crate::local_chat::LocalChatHarnessKind;
use crate::types::PermissionMode;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

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
    pub provider_jsonl_path: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct LoadLocalChatSessionMessagesInput {
    pub harness: LocalChatHarnessKind,
    pub provider_resume_id: String,
    pub project_path: Option<String>,
    pub created_at: Option<String>,
    pub provider_jsonl_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoadLocalChatSessionMessagesOutput {
    pub lines: Vec<String>,
    pub provider_jsonl_path: Option<String>,
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

fn local_chat_provider_home_dir(provider_dir: &str) -> Result<PathBuf, CommandError> {
    let home = dirs::home_dir().ok_or_else(|| CommandError {
        message: "Could not determine home directory".to_string(),
    })?;
    Ok(home.join(provider_dir))
}

fn cached_provider_jsonl_path(provider_dir: &Path, path: Option<&str>) -> Option<PathBuf> {
    let path = path?;
    let candidate = PathBuf::from(path);
    if !candidate.is_file() {
        return None;
    }
    let provider_dir = provider_dir.canonicalize().ok()?;
    let candidate = candidate.canonicalize().ok()?;
    candidate.starts_with(&provider_dir).then_some(candidate)
}

fn claude_project_dir_name(project_path: &str) -> String {
    project_path
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn find_jsonl_by_stem(root: &Path, stem: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            && path.file_stem().and_then(|value| value.to_str()) == Some(stem)
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_jsonl_by_stem(&path, stem) {
                return Some(found);
            }
        }
    }
    None
}

fn find_jsonl_by_stem_suffix(root: &Path, stem_suffix: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            && path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|stem| stem.ends_with(stem_suffix))
        {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_jsonl_by_stem_suffix(&path, stem_suffix) {
                return Some(found);
            }
        }
    }
    None
}

fn claude_session_jsonl_path(
    provider_resume_id: &str,
    project_path: Option<&str>,
    provider_jsonl_path: Option<&str>,
) -> Result<Option<PathBuf>, CommandError> {
    let claude_dir = local_chat_provider_home_dir(".claude")?;
    if let Some(path) = cached_provider_jsonl_path(&claude_dir, provider_jsonl_path) {
        return Ok(Some(path));
    }
    if let Some(project_path) = project_path {
        let direct = claude_dir
            .join("projects")
            .join(claude_project_dir_name(project_path))
            .join(format!("{provider_resume_id}.jsonl"));
        if direct.is_file() {
            return Ok(Some(direct));
        }
    }
    Ok(find_jsonl_by_stem(
        &claude_dir.join("projects"),
        provider_resume_id,
    ))
}

fn codex_date_dir(root: &Path, created_at: Option<&str>) -> Option<PathBuf> {
    let date = created_at?.get(0..10)?;
    let mut parts = date.split('-');
    let year = parts.next()?;
    let month = parts.next()?;
    let day = parts.next()?;
    if parts.next().is_some()
        || year.len() != 4
        || month.len() != 2
        || day.len() != 2
        || !year.chars().all(|ch| ch.is_ascii_digit())
        || !month.chars().all(|ch| ch.is_ascii_digit())
        || !day.chars().all(|ch| ch.is_ascii_digit())
    {
        return None;
    }
    Some(root.join(year).join(month).join(day))
}

fn find_codex_jsonl_in_root(root: &Path, provider_resume_id: &str) -> Option<PathBuf> {
    if let Some(path) = find_jsonl_by_stem_suffix(root, provider_resume_id) {
        return Some(path);
    }
    if let Some(path) = find_jsonl_by_stem(root, &format!("rollout-{provider_resume_id}")) {
        return Some(path);
    }
    find_jsonl_by_stem(root, provider_resume_id)
}

fn codex_session_jsonl_path(
    provider_resume_id: &str,
    created_at: Option<&str>,
    provider_jsonl_path: Option<&str>,
) -> Result<Option<PathBuf>, CommandError> {
    let codex_dir = local_chat_provider_home_dir(".codex")?;
    if let Some(path) = cached_provider_jsonl_path(&codex_dir, provider_jsonl_path) {
        return Ok(Some(path));
    }
    let roots = [
        codex_dir.join("sessions"),
        codex_dir.join("archived_sessions"),
    ];
    for root in &roots {
        if let Some(date_dir) = codex_date_dir(root, created_at) {
            if let Some(path) = find_codex_jsonl_in_root(&date_dir, provider_resume_id) {
                return Ok(Some(path));
            }
        }
    }
    for root in roots {
        if let Some(path) = find_codex_jsonl_in_root(&root, provider_resume_id) {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

fn read_jsonl_lines(path: &Path) -> Result<Vec<String>, CommandError> {
    let file = fs::File::open(path).map_err(|error| CommandError {
        message: format!("Failed to open provider session JSONL: {}", error),
    })?;
    Ok(BufReader::new(file).lines().map_while(Result::ok).collect())
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

    local_chat_manager.create_session(input, app_handle).await
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

/// Load durable transcript messages from the owning harness JSONL store.
#[tauri::command]
#[specta::specta]
pub async fn load_local_chat_session_messages(
    input: LoadLocalChatSessionMessagesInput,
) -> Result<LoadLocalChatSessionMessagesOutput, CommandError> {
    if input.provider_resume_id.trim().is_empty() {
        return Ok(LoadLocalChatSessionMessagesOutput {
            lines: Vec::new(),
            provider_jsonl_path: None,
        });
    }
    let path = match input.harness {
        LocalChatHarnessKind::Claude => claude_session_jsonl_path(
            &input.provider_resume_id,
            input.project_path.as_deref(),
            input.provider_jsonl_path.as_deref(),
        )?,
        LocalChatHarnessKind::Codex => codex_session_jsonl_path(
            &input.provider_resume_id,
            input.created_at.as_deref(),
            input.provider_jsonl_path.as_deref(),
        )?,
    };
    let Some(path) = path else {
        return Ok(LoadLocalChatSessionMessagesOutput {
            lines: Vec::new(),
            provider_jsonl_path: None,
        });
    };
    let lines = read_jsonl_lines(&path)?;
    Ok(LoadLocalChatSessionMessagesOutput {
        lines,
        provider_jsonl_path: Some(path.to_string_lossy().to_string()),
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
    fn finds_codex_jsonl_by_thread_id_suffix() {
        let temp = tempfile::tempdir().unwrap();
        let session_dir = temp
            .path()
            .join("sessions")
            .join("2026")
            .join("07")
            .join("02");
        fs::create_dir_all(&session_dir).unwrap();
        let thread_id = "019f23d9-575e-77b3-bf09-917ec742e78c";
        let path = session_dir.join(format!("rollout-2026-07-02T19-21-14-{thread_id}.jsonl"));
        fs::write(&path, "{}\n").unwrap();

        let found = find_jsonl_by_stem_suffix(temp.path(), thread_id);

        assert_eq!(found.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn builds_codex_date_dir_from_created_at() {
        let root = Path::new("/tmp/codex/sessions");

        assert_eq!(
            codex_date_dir(root, Some("2026-07-02T19:21:14.000Z")),
            Some(root.join("2026").join("07").join("02"))
        );
        assert!(codex_date_dir(root, Some("not-a-date")).is_none());
        assert!(codex_date_dir(root, None).is_none());
    }

    #[test]
    fn read_jsonl_lines_returns_raw_provider_lines() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        fs::write(
            temp.path(),
            r#"{"type":"user","message":{"content":"hello"}}"#.to_string()
                + "\n"
                + r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();

        let lines = read_jsonl_lines(temp.path()).unwrap();

        assert_eq!(
            lines,
            vec![
                r#"{"type":"user","message":{"content":"hello"}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#,
            ]
        );
    }
}
