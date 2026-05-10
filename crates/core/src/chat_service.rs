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

#[async_trait]
pub trait ChatService: Send + Sync {
    async fn create_session(&self) -> ServiceResult<ChatSession>;

    async fn send_message(
        &self,
        chat_session_id: &str,
        options: SendMessageOptions,
    ) -> ServiceResult<ChatMessage>;
}
