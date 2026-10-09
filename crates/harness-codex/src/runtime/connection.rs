use std::{collections::HashMap, pin::Pin, sync::Arc, time::Duration};

use futures::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex as AsyncMutex, OwnedMutexGuard, mpsc, oneshot, watch},
    task::JoinHandle,
};
use tokio_tungstenite::{connect_async_with_config, tungstenite, tungstenite::Message};
use vertebrae_harness_core::{ControlSink, HarnessError, ThreadId, TurnId};

use super::control::{RootTurnIdentity, control_request, respond_to_control_request};
use super::subscription::OwnedThreads;
use super::trace::log_raw_traffic;
use crate::{CodexAppServerEndpoint, required_string};

pub(crate) type WsSink = Pin<Box<dyn Sink<Message, Error = tungstenite::Error> + Send>>;
pub(crate) type WsSource = Pin<Box<dyn Stream<Item = Result<Message, tungstenite::Error>> + Send>>;
type NotificationReceiver = mpsc::Receiver<NotificationMessage>;
#[derive(Clone)]
pub(crate) struct NotificationMessage {
    pub(super) method: String,
    pub(super) params: Value,
}

pub(crate) struct PendingResponse {
    tx: oneshot::Sender<Result<Value, HarnessError>>,
    normalized_root_turn_id: Option<TurnId>,
}
pub(crate) async fn open_websocket(
    endpoint: &CodexAppServerEndpoint,
) -> Result<(WsSink, WsSource), HarnessError> {
    let unavailable = |error: &dyn std::fmt::Display| {
        HarnessError::Unavailable(format!("failed to connect to Codex App Server: {error}"))
    };
    match endpoint {
        CodexAppServerEndpoint::WebSocketUrl(url) => {
            // JSON-RPC frames are small and often back to back
            // (`initialized` then `thread/start`); Nagle would hold the second
            // until the peer's delayed ACK, stalling it by ~40ms on Linux.
            let (stream, _) = connect_async_with_config(url.as_str(), None, true)
                .await
                .map_err(|error| unavailable(&error))?;
            let (writer, reader) = stream.split();
            Ok((Box::pin(writer), Box::pin(reader)))
        }
        #[cfg(unix)]
        CodexAppServerEndpoint::UnixSocket(path) => {
            let socket = tokio::net::UnixStream::connect(path)
                .await
                .map_err(|error| unavailable(&format!("{}: {error}", path.display())))?;
            let (stream, _) = tokio_tungstenite::client_async("ws://localhost/", socket)
                .await
                .map_err(|error| unavailable(&error))?;
            let (writer, reader) = stream.split();
            Ok((Box::pin(writer), Box::pin(reader)))
        }
        #[cfg(not(unix))]
        CodexAppServerEndpoint::UnixSocket(path) => Err(HarnessError::Unavailable(format!(
            "Codex App Server control socket {} requires Unix domain sockets",
            path.display()
        ))),
    }
}

/// Codex rejects requests with `-32600 Server is draining` while the managed
/// daemon restarts; the caller reconnects and retries.
pub(crate) fn is_draining(error: &HarnessError) -> bool {
    let text = error.to_string();
    text.contains("draining") && text.contains("(-32600)")
}

/// Codex rejects `thread/resume` for a thread without a rollout under this
/// `CODEX_HOME` with `-32600 no rollout found for thread id …`.
pub(crate) fn is_missing_thread(error: &HarnessError) -> bool {
    let text = error.to_string();
    text.contains("no rollout found") && text.contains("(-32600)")
}

pub(crate) struct CodexConnection {
    writer: Arc<AsyncMutex<WsSink>>,
    pending: Arc<AsyncMutex<HashMap<String, PendingResponse>>>,
    next_id: AsyncMutex<u64>,
    notifications: Arc<AsyncMutex<NotificationReceiver>>,
    pub(crate) closed: watch::Sender<Option<String>>,
    reader: AsyncMutex<Option<JoinHandle<()>>>,
    pub(super) root_turn_identity: Arc<RootTurnIdentity>,
}

impl CodexConnection {
    pub(crate) async fn connect(
        endpoint: &CodexAppServerEndpoint,
        control_sink: Arc<dyn ControlSink>,
        owned_threads: Arc<OwnedThreads>,
    ) -> Result<Arc<Self>, HarnessError> {
        let (writer, mut reader) = open_websocket(endpoint).await?;
        let (notification_tx, notification_rx) = mpsc::channel(512);
        let (closed, _) = watch::channel(None);
        let root_turn_identity = Arc::new(RootTurnIdentity::default());
        let connection = Arc::new(Self {
            writer: Arc::new(AsyncMutex::new(writer)),
            pending: Arc::new(AsyncMutex::new(HashMap::new())),
            next_id: AsyncMutex::new(1),
            notifications: Arc::new(AsyncMutex::new(notification_rx)),
            closed,
            reader: AsyncMutex::new(None),
            root_turn_identity: Arc::clone(&root_turn_identity),
        });
        let pending = Arc::clone(&connection.pending);
        let writer = Arc::clone(&connection.writer);
        let connection_closed = connection.closed.clone();
        let reader_task = tokio::spawn(async move {
            let failure = loop {
                let Some(frame) = reader.next().await else {
                    break "Codex App Server websocket ended".to_string();
                };
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(error) => break format!("Codex App Server websocket read failed: {error}"),
                };
                let Some(text) = (match frame {
                    Message::Text(text) => Some(text.to_string()),
                    Message::Close(_) => None,
                    _ => continue,
                }) else {
                    break "Codex App Server websocket closed".into();
                };
                log_raw_traffic("recv", &text);
                let message: crate::CodexRpcMessage = match serde_json::from_str(&text) {
                    Ok(message) => message,
                    Err(error) => break format!("malformed Codex App Server JSON: {error}"),
                };
                if let Some(id) = message.id.clone() {
                    if message.method.is_none() {
                        let key = id.to_string();
                        if let Some(pending) = pending.lock().await.remove(&key) {
                            let result = match message.error {
                                Some(error) => Err(HarnessError::Operation(format!(
                                    "{} ({})",
                                    error.message, error.code
                                ))),
                                None => Ok(message.result.unwrap_or(Value::Null)),
                            };
                            if let (Some(normalized_turn_id), Ok(response)) =
                                (pending.normalized_root_turn_id, &result)
                                && let Ok(provider_turn_id) = required_string(
                                    response.get("turn").unwrap_or(response),
                                    &["/id", "/turn/id"],
                                    "turn/start response turn id",
                                )
                            {
                                root_turn_identity
                                    .bind_provider_turn(&provider_turn_id, normalized_turn_id);
                            }
                            let _ = pending.tx.send(result);
                        }
                        continue;
                    }
                    if let Some(method) = message.method {
                        let writer = Arc::clone(&writer);
                        let control_sink = Arc::clone(&control_sink);
                        let params = message.params.unwrap_or(Value::Null);
                        let prepared = control_request(&method, &params).map(|mut request| {
                            let disposition =
                                root_turn_identity.prepare_control_request(&mut request);
                            (request, disposition)
                        });
                        tokio::spawn(async move {
                            respond_to_control_request(
                                &writer,
                                &control_sink,
                                id,
                                &method,
                                prepared,
                            )
                            .await;
                        });
                        continue;
                    }
                }
                if let Some(method) = message.method
                    && owned_threads
                        .admits(&method, message.params.as_ref().unwrap_or(&Value::Null))
                    && notification_tx
                        .send(NotificationMessage {
                            method,
                            params: message.params.unwrap_or(Value::Null),
                        })
                        .await
                        .is_err()
                {
                    break "Codex notification queue closed".to_string();
                }
            };
            let pending = std::mem::take(&mut *pending.lock().await);
            let _ = connection_closed.send(Some(failure.clone()));
            for (_, pending) in pending {
                let _ = pending
                    .tx
                    .send(Err(HarnessError::Operation(failure.clone())));
            }
        });
        *connection.reader.lock().await = Some(reader_task);
        Ok(connection)
    }

    pub(crate) async fn request(&self, method: &str, params: Value) -> Result<Value, HarnessError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        let key = id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(
            key.clone(),
            PendingResponse {
                tx,
                normalized_root_turn_id: None,
            },
        );
        let message = json!({"id": id, "method": method, "params": params});
        if let Err(error) = self.send(message).await {
            self.pending.lock().await.remove(&key);
            return Err(error);
        }
        rx.await.map_err(|_| {
            HarnessError::Operation(format!(
                "Codex App Server response channel closed for {method}"
            ))
        })?
    }

    pub(crate) async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        normalized_root_turn_id: Option<TurnId>,
    ) -> Result<Value, HarnessError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        let key = id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(
            key.clone(),
            PendingResponse {
                tx,
                normalized_root_turn_id,
            },
        );
        if let Err(error) = self
            .send(json!({"id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().await.remove(&key);
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(result) => result.map_err(|_| {
                HarnessError::Operation(format!(
                    "Codex App Server response channel closed for {method}"
                ))
            })?,
            Err(_) => {
                self.pending.lock().await.remove(&key);
                Err(HarnessError::Operation(format!(
                    "Codex {method} request timed out"
                )))
            }
        }
    }

    /// Sends a JSON-RPC request without retaining response state. Used for
    /// best-effort interruption, where provider terminal notification is the
    /// authoritative acknowledgement.
    pub(crate) async fn request_no_wait(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(), HarnessError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        self.send(json!({"id": id, "method": method, "params": params}))
            .await
    }

    pub(crate) async fn notify(&self, method: &str, params: Value) -> Result<(), HarnessError> {
        self.send(json!({"method": method, "params": params})).await
    }

    async fn send(&self, value: Value) -> Result<(), HarnessError> {
        let text = value.to_string();
        log_raw_traffic("send", &text);
        self.writer
            .lock()
            .await
            .send(Message::Text(text))
            .await
            .map_err(|error| {
                HarnessError::Operation(format!("failed to send Codex App Server message: {error}"))
            })
    }

    pub(crate) async fn close(&self) {
        self.root_turn_identity.clear();
        if let Some(reader) = self.reader.lock().await.take() {
            reader.abort();
        }
        let _ = self.writer.lock().await.close().await;
        let _ = self.closed.send(Some("Codex App Server closed".into()));
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, pending) in pending {
            let _ = pending.tx.send(Err(HarnessError::Operation(
                "Codex App Server closed".into(),
            )));
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.borrow().is_some()
    }

    pub(crate) fn set_root_thread(&self, thread_id: ThreadId) {
        self.root_turn_identity.set_root_thread(thread_id);
    }

    pub(crate) fn bind_root_turn(&self, provider_turn_id: &str, turn_id: TurnId) {
        self.root_turn_identity
            .bind_provider_turn(provider_turn_id, turn_id);
    }

    pub(crate) async fn lock_notifications(&self) -> OwnedMutexGuard<NotificationReceiver> {
        Arc::clone(&self.notifications).lock_owned().await
    }

    pub(crate) fn begin_root_turn(&self, turn_id: TurnId) {
        self.root_turn_identity.begin_turn(turn_id);
    }

    pub(crate) fn finish_root_turn(&self, turn_id: &TurnId) {
        self.root_turn_identity.finish_turn(turn_id);
    }
}
