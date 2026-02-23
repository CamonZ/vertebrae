//! Phoenix WebSocket channel protocol for Sacrum.
//!
//! Provides a standalone Phoenix channel client that connects to Sacrum's
//! WebSocket endpoint, joins project channels, and delivers incoming messages
//! via a callback. Adapted from the GUI's websocket_client.rs but decoupled
//! from Tauri so it can be driven by the actor system.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::sink::SinkExt;
use futures::stream::{SplitSink, SplitStream, StreamExt};
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// A parsed Phoenix channel message.
#[derive(Debug, Clone)]
pub struct PhoenixMessage {
    /// The join_ref field (may be null).
    pub join_ref: Option<String>,
    /// The ref field (may be null).
    pub msg_ref: Option<String>,
    /// The channel topic (e.g. "project:my-project-id").
    pub topic: String,
    /// The event name (e.g. "task_created", "phx_reply").
    pub event: String,
    /// The JSON payload.
    pub payload: serde_json::Value,
}

impl PhoenixMessage {
    /// Parse a raw JSON text frame into a PhoenixMessage.
    ///
    /// Phoenix V2 wire format: `[join_ref, ref, topic, event, payload]`
    pub fn parse(text: &str) -> Result<Self, PhoenixError> {
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|e| PhoenixError::Protocol(e.to_string()))?;

        let arr = value
            .as_array()
            .ok_or_else(|| PhoenixError::Protocol("expected JSON array".to_string()))?;

        if arr.len() < 5 {
            return Err(PhoenixError::Protocol(format!(
                "expected 5 elements, got {}",
                arr.len()
            )));
        }

        Ok(PhoenixMessage {
            join_ref: arr[0].as_str().map(String::from),
            msg_ref: arr[1].as_str().map(String::from),
            topic: arr[2]
                .as_str()
                .ok_or_else(|| PhoenixError::Protocol("missing topic".to_string()))?
                .to_string(),
            event: arr[3]
                .as_str()
                .ok_or_else(|| PhoenixError::Protocol("missing event".to_string()))?
                .to_string(),
            payload: arr[4].clone(),
        })
    }

    /// Returns true if this is a Phoenix internal event (phx_reply, phx_error, phx_close).
    pub fn is_phoenix_internal(&self) -> bool {
        matches!(self.event.as_str(), "phx_reply" | "phx_error" | "phx_close")
    }

    /// Extract the project ID from a "project:{id}" topic.
    pub fn project_id(&self) -> Option<&str> {
        self.topic.strip_prefix("project:")
    }
}

/// Errors from the Phoenix WebSocket layer.
#[derive(Debug, thiserror::Error)]
pub enum PhoenixError {
    #[error("WebSocket error: {0}")]
    WebSocket(Box<tokio_tungstenite::tungstenite::Error>),

    #[error("Protocol error: {0}")]
    Protocol(String),

    #[error("Connection closed")]
    ConnectionClosed,

    #[error("URL error: {0}")]
    Url(#[from] url::ParseError),
}

impl From<tokio_tungstenite::tungstenite::Error> for PhoenixError {
    fn from(err: tokio_tungstenite::tungstenite::Error) -> Self {
        PhoenixError::WebSocket(Box::new(err))
    }
}

type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = SplitSink<WsStream, Message>;
type WsReader = SplitStream<WsStream>;

/// Default heartbeat interval (30 seconds, matching Phoenix protocol).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// A reference counter tracking which channels are joined.
/// Key: topic string, Value: join_ref used when joining.
type JoinedChannels = Arc<AsyncMutex<HashMap<String, String>>>;

/// A connected Phoenix WebSocket that can join/leave channels and read messages.
pub struct PhoenixSocket {
    writer: Arc<AsyncMutex<WsSink>>,
    reader: AsyncMutex<Option<WsReader>>,
    joined_channels: JoinedChannels,
    ref_counter: std::sync::atomic::AtomicU64,
    heartbeat_handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl PhoenixSocket {
    /// Connect to a Sacrum WebSocket endpoint.
    ///
    /// Builds the URL from `base_url` (http/https) and appends the Phoenix
    /// socket path with token and version parameters.
    pub async fn connect(base_url: &str, api_token: &str) -> Result<Self, PhoenixError> {
        let ws_url = format!(
            "{}{}?token={}&vsn=2.0.0",
            base_url
                .replace("https://", "wss://")
                .replace("http://", "ws://"),
            "/socket/websocket",
            api_token
        );

        tracing::info!("Connecting to Phoenix WebSocket at {}", ws_url);

        let (socket, _response) = tokio_tungstenite::connect_async(&ws_url).await?;
        let (write, read) = socket.split();

        let writer = Arc::new(AsyncMutex::new(write));
        let joined_channels: JoinedChannels = Arc::new(AsyncMutex::new(HashMap::new()));

        // Start heartbeat task
        let heartbeat_writer = Arc::clone(&writer);
        let heartbeat_handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
            loop {
                interval.tick().await;
                let heartbeat =
                    serde_json::json!([null, "phx_heartbeat", "phoenix", "heartbeat", {}]);
                let msg = Message::Text(heartbeat.to_string().into());
                if heartbeat_writer.lock().await.send(msg).await.is_err() {
                    tracing::warn!("Heartbeat send failed, connection likely dropped");
                    break;
                }
                tracing::debug!("Sent heartbeat");
            }
        });

        Ok(PhoenixSocket {
            writer,
            reader: AsyncMutex::new(Some(read)),
            joined_channels,
            ref_counter: std::sync::atomic::AtomicU64::new(1),
            heartbeat_handle: std::sync::Mutex::new(Some(heartbeat_handle)),
        })
    }

    /// Join a Phoenix channel topic (e.g. "project:{project_id}").
    ///
    /// The `client_type` parameter is included in the phx_join payload so Sacrum
    /// can route events appropriately. Daemon connections should pass `"daemon"` to
    /// receive only `run_step` and `cancel_step` events.
    pub async fn join(
        &self,
        topic: &str,
        token: &str,
        client_type: &str,
    ) -> Result<(), PhoenixError> {
        let join_ref = self.next_ref();
        let msg_ref = self.next_ref();

        let join_payload = serde_json::json!({ "token": token, "client_type": client_type });
        let join_msg = serde_json::json!([join_ref, msg_ref, topic, "phx_join", join_payload]);

        tracing::info!("Joining channel: {}", topic);

        self.writer
            .lock()
            .await
            .send(Message::Text(join_msg.to_string().into()))
            .await?;

        self.joined_channels
            .lock()
            .await
            .insert(topic.to_string(), join_ref);

        Ok(())
    }

    /// Leave a Phoenix channel topic.
    pub async fn leave(&self, topic: &str) -> Result<(), PhoenixError> {
        let msg_ref = self.next_ref();
        let join_ref = self
            .joined_channels
            .lock()
            .await
            .remove(topic)
            .unwrap_or_default();

        let leave_msg = serde_json::json!([join_ref, msg_ref, topic, "phx_leave", {}]);

        tracing::info!("Leaving channel: {}", topic);

        self.writer
            .lock()
            .await
            .send(Message::Text(leave_msg.to_string().into()))
            .await?;

        Ok(())
    }

    /// Take the reader half of the WebSocket stream for the message pump loop.
    ///
    /// This can only be called once. Returns `None` if the reader was already taken.
    pub async fn take_reader(&self) -> Option<WsReader> {
        self.reader.lock().await.take()
    }

    /// Close the WebSocket connection and stop the heartbeat.
    pub async fn close(&self) {
        // Stop heartbeat (sync lock — safe because we only take the handle)
        if let Some(handle) = self.heartbeat_handle.lock().unwrap().take() {
            handle.abort();
        }

        // Send close frame
        let _ = self.writer.lock().await.close().await;
    }

    /// Generate the next unique ref string for Phoenix protocol messages.
    fn next_ref(&self) -> String {
        self.ref_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .to_string()
    }
}

impl Drop for PhoenixSocket {
    fn drop(&mut self) {
        if let Some(handle) = self.heartbeat_handle.get_mut().unwrap().take() {
            handle.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== PhoenixMessage parsing tests =====

    #[test]
    fn parse_valid_message() {
        let raw = r#"["join1", "1", "project:abc", "task_created", {"id": "t1"}]"#;
        let msg = PhoenixMessage::parse(raw).unwrap();

        assert_eq!(msg.join_ref.as_deref(), Some("join1"));
        assert_eq!(msg.msg_ref.as_deref(), Some("1"));
        assert_eq!(msg.topic, "project:abc");
        assert_eq!(msg.event, "task_created");
        assert_eq!(msg.payload["id"].as_str().unwrap(), "t1");
    }

    #[test]
    fn parse_message_with_null_refs() {
        let raw = r#"[null, null, "phoenix", "heartbeat", {}]"#;
        let msg = PhoenixMessage::parse(raw).unwrap();

        assert!(msg.join_ref.is_none());
        assert!(msg.msg_ref.is_none());
        assert_eq!(msg.topic, "phoenix");
        assert_eq!(msg.event, "heartbeat");
    }

    #[test]
    fn parse_rejects_too_short_array() {
        let raw = r#"["ref1", "1", "topic"]"#;
        let err = PhoenixMessage::parse(raw).unwrap_err();
        assert!(matches!(err, PhoenixError::Protocol(_)));
    }

    #[test]
    fn parse_rejects_non_array() {
        let raw = r#"{"event": "task_created"}"#;
        let err = PhoenixMessage::parse(raw).unwrap_err();
        assert!(matches!(err, PhoenixError::Protocol(_)));
    }

    #[test]
    fn parse_rejects_invalid_json() {
        let err = PhoenixMessage::parse("not json at all").unwrap_err();
        assert!(matches!(err, PhoenixError::Protocol(_)));
    }

    #[test]
    fn parse_rejects_missing_topic() {
        let raw = r#"["ref1", "1", null, "event", {}]"#;
        let err = PhoenixMessage::parse(raw).unwrap_err();
        assert!(matches!(err, PhoenixError::Protocol(_)));
    }

    #[test]
    fn parse_rejects_missing_event() {
        let raw = r#"["ref1", "1", "topic", null, {}]"#;
        let err = PhoenixMessage::parse(raw).unwrap_err();
        assert!(matches!(err, PhoenixError::Protocol(_)));
    }

    // ===== PhoenixMessage helper method tests =====

    #[test]
    fn is_phoenix_internal_returns_true_for_phx_events() {
        for event in ["phx_reply", "phx_error", "phx_close"] {
            let msg = PhoenixMessage {
                join_ref: None,
                msg_ref: None,
                topic: "any".to_string(),
                event: event.to_string(),
                payload: serde_json::Value::Null,
            };
            assert!(
                msg.is_phoenix_internal(),
                "expected {} to be internal",
                event
            );
        }
    }

    #[test]
    fn is_phoenix_internal_returns_false_for_app_events() {
        for event in ["task_created", "workflow_updated", "heartbeat"] {
            let msg = PhoenixMessage {
                join_ref: None,
                msg_ref: None,
                topic: "any".to_string(),
                event: event.to_string(),
                payload: serde_json::Value::Null,
            };
            assert!(
                !msg.is_phoenix_internal(),
                "expected {} to not be internal",
                event
            );
        }
    }

    #[test]
    fn project_id_extracts_from_topic() {
        let msg = PhoenixMessage {
            join_ref: None,
            msg_ref: None,
            topic: "project:abc-123".to_string(),
            event: "test".to_string(),
            payload: serde_json::Value::Null,
        };
        assert_eq!(msg.project_id(), Some("abc-123"));
    }

    #[test]
    fn project_id_returns_none_for_non_project_topic() {
        let msg = PhoenixMessage {
            join_ref: None,
            msg_ref: None,
            topic: "phoenix".to_string(),
            event: "heartbeat".to_string(),
            payload: serde_json::Value::Null,
        };
        assert!(msg.project_id().is_none());
    }

    // ===== PhoenixError tests =====

    #[test]
    fn phoenix_error_display_protocol() {
        let err = PhoenixError::Protocol("bad format".to_string());
        assert_eq!(err.to_string(), "Protocol error: bad format");
    }

    #[test]
    fn phoenix_error_display_connection_closed() {
        let err = PhoenixError::ConnectionClosed;
        assert_eq!(err.to_string(), "Connection closed");
    }
}
