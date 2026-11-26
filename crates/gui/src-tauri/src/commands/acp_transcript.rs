use serde_json::Value;
use tauri::State;

use super::CommandError;
use crate::local_chat::{
    acp_transcript, harnesses::acp::RecoveredAcpMessage, LocalChatSessionManager,
};

/// ACP transcript bodies are machine-local and stay outside the shared catalog.
#[tauri::command]
#[specta::specta]
pub async fn load_acp_transcript(session_id: String) -> Result<Vec<Value>, CommandError> {
    acp_transcript::load(session_id)
        .await
        .map_err(storage_error)
}

/// Recover text for catalog entries created before local ACP transcripts existed.
#[tauri::command]
#[specta::specta]
pub async fn recover_acp_transcript(
    manager: State<'_, LocalChatSessionManager>,
    provider_id: String,
    provider_resume_id: String,
    working_dir: String,
) -> Result<Vec<RecoveredAcpMessage>, CommandError> {
    manager
        .recover_acp_history(provider_id, provider_resume_id, working_dir.into())
        .await
        .map_err(|error| CommandError {
            message: error.to_string(),
        })
}

#[tauri::command]
#[specta::specta]
pub async fn save_acp_transcript(
    session_id: String,
    messages: Vec<Value>,
) -> Result<(), CommandError> {
    acp_transcript::save(session_id, messages)
        .await
        .map_err(storage_error)
}

fn storage_error(error: std::io::Error) -> CommandError {
    tracing::warn!(kind = ?error.kind(), "ACP transcript storage failed");
    CommandError {
        message: "Could not access the local ACP transcript.".into(),
    }
}
