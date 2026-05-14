//! Chat service trait for the sacrum live chat surface.

use crate::error::ServiceResult;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub project_id: String,
    pub status: String,
    pub session_kind: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub stop_requested_at: Option<DateTime<Utc>>,
    pub inserted_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteChatSessionResult {
    pub deleted_session_id: String,
    pub success: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub project_id: String,
    pub chat_session_id: String,
    pub role: String,
    pub content: String,
    pub content_format: Option<String>,
    pub client_message_id: Option<String>,
    pub inserted_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

/// `content_format` defaults to `"plain"` server-side when omitted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendMessageOptions {
    pub content: String,
    pub content_format: Option<String>,
    pub client_message_id: Option<String>,
}

impl SendMessageOptions {
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            ..Default::default()
        }
    }
}

/// Pagination / filter options for `ChatService::list_messages`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListMessagesOptions {
    pub limit: Option<i32>,
    /// RFC3339 timestamp; messages with `inserted_at > after` are returned.
    pub after: Option<String>,
}

#[async_trait]
pub trait ChatService: Send + Sync {
    async fn create_session(&self) -> ServiceResult<ChatSession>;

    async fn send_message(
        &self,
        chat_session_id: &str,
        options: SendMessageOptions,
    ) -> ServiceResult<ChatMessage>;

    /// Fetch a chat session by id within the configured project. Returns
    /// `Ok(None)` if the session does not exist (or is not visible to the
    /// caller).
    async fn get_session(&self, chat_session_id: &str) -> ServiceResult<Option<ChatSession>>;

    /// List project-scoped chat sessions newest-first.
    async fn list_sessions(&self, limit: Option<i32>) -> ServiceResult<Vec<ChatSession>>;

    /// Delete a project-scoped chat session and its transcript.
    async fn delete_session(&self, chat_session_id: &str)
    -> ServiceResult<DeleteChatSessionResult>;

    /// List chat messages for a session in chronological order.
    async fn list_messages(
        &self,
        chat_session_id: &str,
        options: ListMessagesOptions,
    ) -> ServiceResult<Vec<ChatMessage>>;
}
