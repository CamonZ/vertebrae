use super::*;

// ============================================================================
// Local Chat Commands
// ============================================================================

/// List supported local chat harnesses for provider-neutral local sessions.
#[tauri::command]
#[specta::specta]
pub fn get_supported_local_chat_harnesses(
    local_chat_manager: State<'_, LocalChatSessionManager>,
) -> LocalChatHarnessCatalog {
    local_chat_manager.catalog()
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

/// Resolve a local chat permission request shown in the GUI.
#[tauri::command]
#[specta::specta]
pub async fn resolve_permission_request(
    local_chat_manager: State<'_, LocalChatSessionManager>,
    input: ResolvePermissionRequestInput,
) -> Result<serde_json::Value, CommandError> {
    let (behavior, message, updated_input) = match input.behavior {
        PermissionDecisionBehavior::Allow => {
            let updated_input = match input.updated_input {
                Some(value @ serde_json::Value::Object(_)) => Some(value),
                Some(_) => {
                    return Err(CommandError {
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
        .map_err(|err| CommandError { message: err })
}
