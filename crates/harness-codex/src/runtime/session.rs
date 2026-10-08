use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use chrono::Utc;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, watch};
use vertebrae_harness_core::{
    AgentMetadata, ControlSink, EventCorrelation, HarnessError, HarnessEventDraftV1,
    HarnessEventPayloadV1, ProviderThreadRef, RunId, SequencedEventSink, SessionCloseOutcome,
    SessionCloseStatus, SessionId, StreamId, TextEvent, ThreadDeclared, ThreadId, ThreadKind,
    ToolCallId, TurnId, TurnInput, TurnInputProvenance, TurnOutcome, UpdateSemantics,
};

use super::connection::CodexConnection;
use super::outcome::{TurnAccumulator, completion_status, outcome_from_completion};
use super::setup::attach;
use super::subscription::OwnedThreads;
use super::trace::trace;
use crate::{CodexProviderConfig, optional_string};

#[derive(Clone)]
pub(crate) struct ChildInfo {
    parent_thread_id: Option<ThreadId>,
    caused_by: Option<ToolCallId>,
    prompt: Option<String>,
    metadata: Option<AgentMetadata>,
}

pub(crate) struct SessionState {
    pub(super) connection: Mutex<Arc<CodexConnection>>,
    pub(super) reconnect_gate: AsyncMutex<()>,
    pub(super) control_sink: Arc<dyn ControlSink>,
    pub(super) owned_threads: Arc<OwnedThreads>,
    /// `thread/resume` params, including the per-thread config Codex does
    /// not persist, re-sent whenever the session reattaches.
    pub(super) resume_params: Value,
    pub(super) config: Arc<CodexProviderConfig>,
    pub(super) sink: Arc<SequencedEventSink>,
    pub(super) root_stream_id: StreamId,
    pub(super) root_session_id: SessionId,
    pub(super) root_thread_id: ThreadId,
    pub(super) default_output_schema: Option<Value>,
    pub(super) root_turn_gate: AsyncMutex<()>,
    pub(super) cleanup: AsyncMutex<Option<watch::Receiver<Option<SessionCloseOutcome>>>>,
    pub(super) children: Mutex<HashMap<String, ChildInfo>>,
    pub(super) declared_threads: Mutex<HashSet<String>>,
    pub(super) closed: watch::Sender<bool>,
    pub(super) closed_rx: watch::Receiver<bool>,
}

pub(crate) enum RecoveredTurn {
    Finished(Box<TurnOutcome>),
    Running(Arc<CodexConnection>),
}

impl SessionState {
    pub(super) fn connection(&self) -> Arc<CodexConnection> {
        Arc::clone(
            &self
                .connection
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    pub(super) async fn reconnect(&self) -> Result<Arc<CodexConnection>, HarnessError> {
        let _gate = self.reconnect_gate.lock().await;
        let current = self.connection();
        if !current.is_closed() {
            return Ok(current);
        }
        if *self.closed_rx.borrow() {
            return Err(HarnessError::Operation("Codex session is closed".into()));
        }
        trace(
            Some(self.root_session_id.as_str()),
            "connection.reconnecting",
            "internal",
            None,
            "reconnecting",
            current.closed.borrow().as_deref(),
            None,
        );
        current.close().await;
        let (connection, _, _) = attach(
            &self.config,
            &self.control_sink,
            &self.owned_threads,
            Some(("thread/resume", &self.resume_params)),
        )
        .await?;
        connection.set_root_thread(self.root_thread_id.clone());
        *self
            .connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::clone(&connection);
        log::info!(
            "[Codex] reattached thread {} to the App Server daemon",
            self.root_thread_id
        );
        Ok(connection)
    }

    pub(super) async fn connection_for_turn(&self) -> Result<Arc<CodexConnection>, HarnessError> {
        let connection = self.connection();
        if connection.is_closed() {
            return self.reconnect().await;
        }
        Ok(connection)
    }

    /// The connection dropped mid-turn (daemon restart, crash, or kill).
    /// Reattach, then reconcile the provider turn from thread history: a
    /// restart drains in-flight turns, but `turn/completed` may not have been
    /// delivered before the connection closed.
    pub(super) async fn recover_turn(
        &self,
        provider_turn: &str,
        turn_id: &TurnId,
        accumulator: &mut TurnAccumulator,
    ) -> Result<RecoveredTurn, HarnessError> {
        log::warn!(
            "[Codex] connection lost during turn {provider_turn}; reattaching to reconcile it"
        );
        let connection = self.reconnect().await?;
        connection.begin_root_turn(turn_id.clone());
        connection.bind_root_turn(provider_turn, turn_id.clone());
        let response = connection
            .request_with_timeout(
                "thread/read",
                json!({"threadId": self.root_thread_id.as_str(), "includeTurns": true}),
                self.config.request_timeout,
                None,
            )
            .await?;
        let turn = response
            .pointer("/thread/turns")
            .and_then(Value::as_array)
            .and_then(|turns| {
                turns
                    .iter()
                    .find(|turn| turn.get("id").and_then(Value::as_str) == Some(provider_turn))
            })
            .ok_or_else(|| {
                HarnessError::Operation(format!(
                    "Codex connection was lost and turn {provider_turn} was not found in thread {} history",
                    self.root_thread_id
                ))
            })?;
        let status = optional_string(turn, &["/status"]).unwrap_or_default();
        if status == "inProgress" {
            return Ok(RecoveredTurn::Running(connection));
        }
        // The rollout's final agent message is authoritative over deltas
        // streamed before the connection dropped.
        if let Some(text) =
            turn.get("items")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items.iter().rev().find(|item| {
                        item.get("type").and_then(Value::as_str) == Some("agentMessage")
                    })
                })
                .and_then(|item| item.get("text").and_then(Value::as_str))
                .filter(|text| *text != accumulator.text)
        {
            accumulator.text = text.to_string();
            self.emit(
                self.root_stream_id.clone(),
                self.root_correlation(Some(turn_id.clone()), None),
                HarnessEventPayloadV1::Text(TextEvent {
                    text: text.to_string(),
                    completion_status: Some(completion_status(&status)),
                }),
                UpdateSemantics::Snapshot,
            )
            .await?;
        }
        Ok(RecoveredTurn::Finished(Box::new(outcome_from_completion(
            &json!({"turn": turn}),
            status,
            accumulator,
        ))))
    }

    pub(super) async fn emit(
        &self,
        stream_id: StreamId,
        correlation: EventCorrelation,
        payload: HarnessEventPayloadV1,
        semantics: UpdateSemantics,
    ) -> Result<(), HarnessError> {
        self.sink
            .emit(HarnessEventDraftV1 {
                stream_id,
                correlation,
                timestamp: Utc::now(),
                semantics,
                provider_sequence: None,
                payload,
            })
            .await
            .map(|_| ())
    }

    pub(super) fn root_correlation(
        &self,
        turn_id: Option<TurnId>,
        run_id: Option<RunId>,
    ) -> EventCorrelation {
        EventCorrelation {
            session_id: Some(self.root_session_id.clone()),
            thread_id: Some(self.root_thread_id.clone()),
            turn_id,
            run_id,
            ..EventCorrelation::default()
        }
    }

    pub(super) fn child_correlation(
        session_id: &SessionId,
        thread_id: ThreadId,
        turn_id: Option<TurnId>,
        parent_tool_call_id: Option<ToolCallId>,
    ) -> EventCorrelation {
        EventCorrelation {
            session_id: Some(session_id.clone()),
            thread_id: Some(thread_id),
            turn_id,
            parent_tool_call_id,
            ..EventCorrelation::default()
        }
    }

    pub(super) async fn declare_child(
        &self,
        params: &Value,
    ) -> Result<Option<(ThreadId, StreamId, EventCorrelation)>, HarnessError> {
        let Some(thread_id) = optional_string(params, &["/threadId", "/thread/id"]) else {
            return Ok(None);
        };
        if thread_id == self.root_thread_id.as_str() {
            return Ok(None);
        }
        self.owned_threads.insert(thread_id.clone());
        let info = self
            .children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&thread_id)
            .cloned();
        let parent = optional_string(params, &["/parentThreadId", "/thread/parentThreadId"])
            .map(ThreadId::new)
            .or_else(|| info.as_ref().and_then(|info| info.parent_thread_id.clone()));
        let caused_by = info.as_ref().and_then(|info| info.caused_by.clone());
        let metadata = info.as_ref().and_then(|info| info.metadata.clone());
        let is_new = self
            .declared_threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(thread_id.clone());
        let thread = ThreadId::new(thread_id.clone());
        let stream = StreamId::new(format!("{}:thread:{}", self.root_stream_id, thread_id));
        let correlation = Self::child_correlation(
            &self.root_session_id,
            thread.clone(),
            optional_string(params, &["/turnId", "/turn/id"]).map(TurnId::new),
            caused_by.clone(),
        );
        if is_new {
            self.emit(
                stream.clone(),
                correlation.clone(),
                HarnessEventPayloadV1::ThreadDeclared(ThreadDeclared {
                    thread_id: thread.clone(),
                    parent_thread_id: parent,
                    kind: ThreadKind::Subagent,
                    caused_by_tool_call_id: caused_by,
                    provider_thread_ref: Some(ProviderThreadRef::new(thread_id.clone())),
                    agent_metadata: metadata,
                }),
                UpdateSemantics::Snapshot,
            )
            .await?;
            if let Some(prompt) = info.and_then(|info| info.prompt) {
                self.emit(
                    stream.clone(),
                    correlation.clone(),
                    HarnessEventPayloadV1::TurnInput(TurnInput {
                        thread_id: thread.clone(),
                        run_id: None,
                        content: prompt,
                        provenance: TurnInputProvenance::Agent,
                    }),
                    UpdateSemantics::Snapshot,
                )
                .await?;
            }
        }
        Ok(Some((thread, stream, correlation)))
    }

    pub(super) async fn remember_spawn(
        &self,
        item: &Value,
        tool_id: &str,
        parent_thread_id: ThreadId,
    ) {
        let Some(ids) = item
            .get("receiverThreadIds")
            .or_else(|| item.get("receiver_thread_ids"))
            .and_then(Value::as_array)
        else {
            return;
        };
        let prompt = optional_string(
            item,
            &["/prompt", "/input/prompt", "/input/text", "/description"],
        );
        let metadata = Some(AgentMetadata {
            name: optional_string(item, &["/newAgentNickname", "/nickname", "/agent/nickname"]),
            role: optional_string(item, &["/newAgentRole", "/role", "/agent/role"]),
            model: optional_string(item, &["/model", "/agent/model"]),
        });
        let parent = Some(parent_thread_id);
        let mut children = self
            .children
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for id in ids.iter().filter_map(Value::as_str) {
            self.owned_threads.insert(id);
            children.entry(id.to_string()).or_insert(ChildInfo {
                parent_thread_id: parent.clone(),
                caused_by: Some(ToolCallId::new(tool_id)),
                prompt: prompt.clone(),
                metadata: metadata.clone(),
            });
        }
    }

    pub(crate) async fn close(
        self: &Arc<Self>,
        status: SessionCloseStatus,
        error: Option<String>,
    ) -> Result<SessionCloseOutcome, HarnessError> {
        let mut slot = self.cleanup.lock().await;
        if let Some(rx) = slot.as_ref() {
            let rx = rx.clone();
            drop(slot);
            return wait_cleanup(rx).await;
        }
        let (tx, rx) = watch::channel(None);
        *slot = Some(rx.clone());
        drop(slot);
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = this.close_inner(status, error).await;
            let _ = tx.send(Some(outcome));
        });
        wait_cleanup(rx).await
    }

    async fn close_inner(
        &self,
        status: SessionCloseStatus,
        error: Option<String>,
    ) -> SessionCloseOutcome {
        let _ = self.closed.send(true);
        let connection = self.connection();
        if !connection.is_closed() {
            // The daemon outlives the session: stop a turn still running on
            // its behalf, then release the thread so the daemon can unload it.
            if let Some(provider_turn) = connection.root_turn_identity.active_provider_turn() {
                let _ = connection
                    .request_with_timeout(
                        "turn/interrupt",
                        json!({"threadId": self.root_thread_id.as_str(), "turnId": provider_turn}),
                        self.config.cleanup_timeout,
                        None,
                    )
                    .await;
            }
            // Subagent threads are subscribed by this connection too; Codex
            // documents no release on disconnect, so unsubscribe each
            // explicitly, children first.
            let mut threads: Vec<String> = self
                .declared_threads
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .filter(|thread| thread.as_str() != self.root_thread_id.as_str())
                .cloned()
                .collect();
            threads.sort();
            threads.push(self.root_thread_id.as_str().to_string());
            for thread in threads {
                if let Err(error) = connection
                    .request_with_timeout(
                        "thread/unsubscribe",
                        json!({"threadId": thread}),
                        self.config.cleanup_timeout,
                        None,
                    )
                    .await
                {
                    log::warn!("[Codex] thread/unsubscribe failed for {thread}: {error}");
                }
            }
        }
        connection.close().await;
        let outcome = SessionCloseOutcome { status, error };
        trace(
            Some(self.root_session_id.as_str()),
            "session.closed",
            "internal",
            None,
            "closed",
            Some(&format!(
                "status={:?}; error={:?}",
                outcome.status, outcome.error
            )),
            None,
        );
        let _ = self
            .emit(
                self.root_stream_id.clone(),
                self.root_correlation(None, None),
                HarnessEventPayloadV1::SessionClosed(outcome.clone()),
                UpdateSemantics::Snapshot,
            )
            .await;
        outcome
    }
}

async fn wait_cleanup(
    mut rx: watch::Receiver<Option<SessionCloseOutcome>>,
) -> Result<SessionCloseOutcome, HarnessError> {
    loop {
        if let Some(outcome) = rx.borrow().clone() {
            return Ok(outcome);
        }
        rx.changed().await.map_err(|_| {
            HarnessError::Operation("Codex App Server cleanup ended without an outcome".into())
        })?;
    }
}
