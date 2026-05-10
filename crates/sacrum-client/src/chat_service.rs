//! `ChatService` implementation backed by the sacrum GraphQL API.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use vertebrae_core::chat_service::{ChatMessage, ChatService, ChatSession, SendMessageOptions};
use vertebrae_core::error::ServiceResult;

use crate::api_types::{ChatMessageResponse, ChatSessionResponse};
use crate::client::{GraphqlClient, with_fragments};
use crate::queries::chat;

pub struct SacrumChatService {
    client: GraphqlClient,
}

impl SacrumChatService {
    pub fn new(client: GraphqlClient) -> Self {
        Self { client }
    }

    fn project_id(&self) -> &str {
        self.client.project_id()
    }
}

fn parse_dt(value: &Option<String>) -> Option<DateTime<Utc>> {
    value
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

fn session_response_to_model(r: ChatSessionResponse) -> ChatSession {
    ChatSession {
        id: r.id,
        project_id: r.project_id,
        status: r.status,
        session_kind: r.session_kind,
        started_at: parse_dt(&r.started_at),
        ended_at: parse_dt(&r.ended_at),
        stop_requested_at: parse_dt(&r.stop_requested_at),
        inserted_at: parse_dt(&r.inserted_at),
        updated_at: parse_dt(&r.updated_at),
    }
}

fn message_response_to_model(r: ChatMessageResponse) -> ChatMessage {
    ChatMessage {
        id: r.id,
        project_id: r.project_id,
        chat_session_id: r.chat_session_id,
        role: r.role,
        content: r.content,
        content_format: r.content_format,
        client_message_id: r.client_message_id,
        inserted_at: parse_dt(&r.inserted_at),
        updated_at: parse_dt(&r.updated_at),
    }
}

#[async_trait]
impl ChatService for SacrumChatService {
    async fn create_session(&self) -> ServiceResult<ChatSession> {
        let query = with_fragments(chat::CREATE_CHAT_SESSION, &[chat::CHAT_SESSION_FIELDS]);
        let variables = json!({
            "project_id": self.project_id(),
        });

        let response: ChatSessionResponse = self
            .client
            .execute(&query, variables, "create_chat_session")
            .await?;

        Ok(session_response_to_model(response))
    }

    async fn send_message(
        &self,
        chat_session_id: &str,
        options: SendMessageOptions,
    ) -> ServiceResult<ChatMessage> {
        let mut variables = json!({
            "project_id": self.project_id(),
            "chat_session_id": chat_session_id,
            "content": options.content,
        });

        if let Some(format) = options.content_format {
            variables["content_format"] = Value::String(format);
        }
        if let Some(client_id) = options.client_message_id {
            variables["client_message_id"] = Value::String(client_id);
        }

        let query = with_fragments(chat::SEND_CHAT_MESSAGE, &[chat::CHAT_MESSAGE_FIELDS]);

        let response: ChatMessageResponse = self
            .client
            .execute(&query, variables, "send_chat_message")
            .await?;

        Ok(message_response_to_model(response))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SacrumConfig;
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn create_service(server_url: &str) -> SacrumChatService {
        let client = GraphqlClient::new(SacrumConfig::new(
            server_url.to_string(),
            "test-token".to_string(),
            "test-project".to_string(),
        ));
        SacrumChatService::new(client)
    }

    fn session_payload(id: &str) -> serde_json::Value {
        json!({
            "id": id,
            "project_id": "test-project",
            "status": "active",
            "session_kind": null,
            "started_at": "2026-05-10T12:00:00Z",
            "ended_at": null,
            "stop_requested_at": null,
            "public_metadata": null,
            "inserted_at": "2026-05-10T12:00:00Z",
            "updated_at": "2026-05-10T12:00:00Z"
        })
    }

    fn message_payload(id: &str, session_id: &str, content: &str) -> serde_json::Value {
        json!({
            "id": id,
            "project_id": "test-project",
            "chat_session_id": session_id,
            "role": "user",
            "content": content,
            "content_format": "plain",
            "client_message_id": null,
            "metadata": null,
            "inserted_at": "2026-05-10T12:00:01Z",
            "updated_at": "2026-05-10T12:00:01Z"
        })
    }

    #[tokio::test]
    async fn create_session_sends_project_id_and_returns_model() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateChatSession"))
            .and(body_string_contains("test-project"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": { "create_chat_session": session_payload("sess-1") }
            })))
            .mount(&server)
            .await;

        let service = create_service(&server.uri());
        let session = service.create_session().await.unwrap();

        assert_eq!(session.id, "sess-1");
        assert_eq!(session.project_id, "test-project");
        assert_eq!(session.status, "active");
        assert!(session.session_kind.is_none());
        assert!(session.started_at.is_some());
        assert!(session.inserted_at.is_some());
    }

    #[tokio::test]
    async fn create_session_propagates_graphql_errors() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("CreateChatSession"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{ "message": "forbidden" }]
            })))
            .mount(&server)
            .await;

        let service = create_service(&server.uri());
        let err = service.create_session().await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("forbidden"), "unexpected error: {msg}");
    }

    #[tokio::test]
    async fn send_message_passes_required_variables_and_maps_response() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("SendChatMessage"))
            .and(body_string_contains("hello world"))
            .and(body_string_contains("sess-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "send_chat_message": message_payload("msg-1", "sess-1", "hello world")
                }
            })))
            .mount(&server)
            .await;

        let service = create_service(&server.uri());
        let message = service
            .send_message("sess-1", SendMessageOptions::new("hello world"))
            .await
            .unwrap();

        assert_eq!(message.id, "msg-1");
        assert_eq!(message.chat_session_id, "sess-1");
        assert_eq!(message.role, "user");
        assert_eq!(message.content, "hello world");
        assert_eq!(message.content_format.as_deref(), Some("plain"));
    }

    #[tokio::test]
    async fn send_message_includes_optional_fields_when_set() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("SendChatMessage"))
            .and(body_string_contains("client-xyz"))
            .and(body_string_contains("markdown"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": {
                    "send_chat_message": message_payload("msg-2", "sess-1", "**bold**")
                }
            })))
            .mount(&server)
            .await;

        let service = create_service(&server.uri());
        let opts = SendMessageOptions {
            content: "**bold**".to_string(),
            content_format: Some("markdown".to_string()),
            client_message_id: Some("client-xyz".to_string()),
        };
        let message = service.send_message("sess-1", opts).await.unwrap();
        assert_eq!(message.id, "msg-2");
    }

    #[tokio::test]
    async fn send_message_propagates_graphql_errors() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/graphql"))
            .and(body_string_contains("SendChatMessage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "errors": [{ "message": "session not found" }]
            })))
            .mount(&server)
            .await;

        let service = create_service(&server.uri());
        let err = service
            .send_message("sess-missing", SendMessageOptions::new("x"))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("session not found"), "unexpected error: {msg}");
    }
}
