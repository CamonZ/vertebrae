use std::sync::{Arc, Mutex};

use futures::SinkExt;
use tokio::sync::Mutex as AsyncMutex;

use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use vertebrae_harness_core::{
    ApprovalCategory, ApprovalRequest, ControlRequest, ControlRequestEnvelope, ControlResolution,
    ControlSink, GrantScope, SessionId, ThreadId, TurnId,
};

use super::connection::WsSink;
use super::trace::log_raw_traffic;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ControlDisposition {
    Forward,
    RejectStale,
}

struct ActiveRootTurn {
    normalized_turn_id: TurnId,
    provider_turn_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct RootTurnIdentityState {
    root_thread_id: Option<ThreadId>,
    active: Option<ActiveRootTurn>,
    recent_provider_turn_id: Option<String>,
}

#[derive(Default)]
pub(crate) struct RootTurnIdentity {
    state: Mutex<RootTurnIdentityState>,
}

impl RootTurnIdentity {
    pub(crate) fn set_root_thread(&self, thread_id: ThreadId) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .root_thread_id = Some(thread_id);
    }

    pub(crate) fn begin_turn(&self, turn_id: TurnId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(provider_turn_id) = state
            .active
            .take()
            .and_then(|active| active.provider_turn_id)
        {
            state.recent_provider_turn_id = Some(provider_turn_id);
        }
        state.active = Some(ActiveRootTurn {
            normalized_turn_id: turn_id,
            provider_turn_id: None,
        });
    }

    pub(crate) fn bind_provider_turn(&self, provider_turn_id: &str, turn_id: TurnId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.active.as_mut()
            && active.normalized_turn_id == turn_id
        {
            active.provider_turn_id = Some(provider_turn_id.to_string());
        }
    }

    pub(crate) fn finish_turn(&self, turn_id: &TurnId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state
            .active
            .as_ref()
            .is_some_and(|active| &active.normalized_turn_id == turn_id)
        {
            let active = state.active.take().expect("active turn was checked");
            if active.provider_turn_id.is_some() {
                state.recent_provider_turn_id = active.provider_turn_id;
            }
        }
    }

    pub(crate) fn active_provider_turn(&self) -> Option<String> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active
            .as_ref()
            .and_then(|active| active.provider_turn_id.clone())
    }

    pub(crate) fn clear(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.root_thread_id = None;
        state.active = None;
        state.recent_provider_turn_id = None;
    }

    pub(crate) fn prepare_control_request(
        &self,
        request: &mut ControlRequestEnvelope,
    ) -> ControlDisposition {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(thread_id) = request.thread_id.as_ref() else {
            return ControlDisposition::Forward;
        };
        let Some(root_thread_id) = state.root_thread_id.as_ref() else {
            return ControlDisposition::Forward;
        };
        let is_root = thread_id == root_thread_id;
        request.is_root = Some(is_root);
        if !is_root {
            return ControlDisposition::Forward;
        }

        let Some(active) = state.active.as_ref() else {
            return ControlDisposition::RejectStale;
        };
        let Some(requested_turn_id) = request.turn_id.as_ref() else {
            request.turn_id = Some(active.normalized_turn_id.clone());
            return ControlDisposition::Forward;
        };
        if requested_turn_id == &active.normalized_turn_id
            || active.provider_turn_id.as_deref() == Some(requested_turn_id.as_str())
        {
            request.turn_id = Some(active.normalized_turn_id.clone());
            return ControlDisposition::Forward;
        }
        if state.recent_provider_turn_id.as_deref() == Some(requested_turn_id.as_str()) {
            return ControlDisposition::RejectStale;
        }
        if active.provider_turn_id.is_none() {
            request.turn_id = Some(active.normalized_turn_id.clone());
            return ControlDisposition::Forward;
        }
        ControlDisposition::RejectStale
    }
}
pub(crate) async fn respond_to_control_request(
    writer: &Arc<AsyncMutex<WsSink>>,
    control_sink: &Arc<dyn ControlSink>,
    id: Value,
    method: &str,
    prepared: Option<(ControlRequestEnvelope, ControlDisposition)>,
) {
    let response = match prepared {
        None => {
            json!({"id": id, "error": {"code": -32601, "message": format!("unsupported Codex server request '{method}'")}})
        }
        Some((request, disposition)) => match disposition {
            ControlDisposition::Forward => match control_sink.request(request).await {
                Ok(resolution) => {
                    json!({"id": id, "result": encode_control_resolution(&resolution)})
                }
                Err(error) => {
                    json!({"id": id, "error": {"code": -32000, "message": error.to_string()}})
                }
            },
            ControlDisposition::RejectStale => {
                json!({"id": id, "result": {"decision": "decline"}})
            }
        },
    };
    log_raw_traffic("send", &response.to_string());
    let _ = writer
        .lock()
        .await
        .send(Message::Text(response.to_string()))
        .await;
}

pub(crate) fn control_request(method: &str, params: &Value) -> Option<ControlRequestEnvelope> {
    let request = match method {
        "item/commandExecution/requestApproval" => ControlRequest::Approval(ApprovalRequest {
            category: ApprovalCategory::CommandExecution,
            title: "Codex command execution".into(),
            details: Some(params.clone()),
            modification_supported: false,
        }),
        "item/fileChange/requestApproval" => ControlRequest::Approval(ApprovalRequest {
            category: ApprovalCategory::FileChange,
            title: "Codex file change".into(),
            details: Some(params.clone()),
            modification_supported: false,
        }),
        "item/permissions/requestApproval" => {
            ControlRequest::PermissionGrant(vertebrae_harness_core::PermissionGrantRequest {
                permissions: params
                    .get("permissions")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToOwned::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                scope_supported: vec![GrantScope::Turn, GrantScope::Session],
            })
        }
        "item/question/request" | "item/userQuestion/request" => ControlRequest::UserQuestion {
            questions: Vec::new(),
        },
        _ => return None,
    };
    Some(ControlRequestEnvelope {
        request_id: params
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or(method)
            .into(),
        session_id: params
            .get("threadId")
            .and_then(Value::as_str)
            .map(|value| SessionId::new(value.to_string())),
        turn_id: params
            .get("turnId")
            .and_then(Value::as_str)
            .map(|value| TurnId::new(value.to_string())),
        thread_id: params
            .get("threadId")
            .and_then(Value::as_str)
            .map(|value| ThreadId::new(value.to_string())),
        is_root: None,
        request,
        presentation: None,
        timeout_ms: None,
        automatic_resolution: None,
    })
}

fn encode_control_resolution(resolution: &ControlResolution) -> Value {
    match resolution.decision.as_ref() {
        Some(vertebrae_harness_core::ControlDecision::AllowOnce) => json!({"decision":"accept"}),
        Some(vertebrae_harness_core::ControlDecision::AllowForSession) => {
            json!({"decision":"acceptForSession"})
        }
        Some(vertebrae_harness_core::ControlDecision::Deny) => json!({"decision":"decline"}),
        Some(vertebrae_harness_core::ControlDecision::Cancel) => json!({"decision":"cancel"}),
        Some(vertebrae_harness_core::ControlDecision::Modified(value)) => {
            json!({"decision":"accept", "updatedInput": value})
        }
        Some(vertebrae_harness_core::ControlDecision::PermissionsGranted {
            permissions,
            scope,
        }) => {
            json!({"permissions": permissions.iter().cloned().map(|permission| (permission, Value::Bool(true))).collect::<serde_json::Map<_, _>>(), "scope": match scope { GrantScope::Turn => "turn", GrantScope::Session => "session" }})
        }
        Some(vertebrae_harness_core::ControlDecision::QuestionsAnswered(answers)) => {
            json!({"decision":"accept", "answers": answers})
        }
        None => json!({"decision":"decline"}),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{ControlDisposition, RootTurnIdentity, control_request};
    use vertebrae_harness_core::{ThreadId, TurnId};

    fn approval(thread_id: &str, turn_id: &str) -> vertebrae_harness_core::ControlRequestEnvelope {
        control_request(
            "item/commandExecution/requestApproval",
            &json!({
                "requestId": format!("approval-{thread_id}-{turn_id}"),
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )
        .expect("supported control request")
    }

    #[test]
    fn classifies_and_normalizes_early_root_controls_without_touching_children() {
        let identity = RootTurnIdentity::default();
        identity.set_root_thread(ThreadId::new("root-thread"));
        identity.begin_turn(TurnId::new("requested-root"));

        let mut early_root = approval("root-thread", "provider-root");
        assert_eq!(
            identity.prepare_control_request(&mut early_root),
            ControlDisposition::Forward
        );
        assert_eq!(early_root.turn_id, Some(TurnId::new("requested-root")));
        assert_eq!(early_root.thread_id, Some(ThreadId::new("root-thread")));
        assert_eq!(early_root.is_root, Some(true));

        let mut child = approval("child-thread", "child-turn");
        assert_eq!(
            identity.prepare_control_request(&mut child),
            ControlDisposition::Forward
        );
        assert_eq!(child.turn_id, Some(TurnId::new("child-turn")));
        assert_eq!(child.thread_id, Some(ThreadId::new("child-thread")));
        assert_eq!(child.is_root, Some(false));
    }

    #[test]
    fn root_turn_identity_is_bounded_and_rejects_the_replaced_provider_turn() {
        let identity = RootTurnIdentity::default();
        identity.set_root_thread(ThreadId::new("root-thread"));

        for index in 0..100 {
            let normalized = TurnId::new(format!("requested-{index}"));
            identity.begin_turn(normalized.clone());
            identity.bind_provider_turn(&format!("provider-{index}"), normalized.clone());
            identity.finish_turn(&normalized);
        }
        {
            let state = identity.state.lock().unwrap();
            assert!(state.active.is_none());
            assert_eq!(
                state.recent_provider_turn_id.as_deref(),
                Some("provider-99")
            );
        }

        identity.begin_turn(TurnId::new("requested-next"));
        let mut old = approval("root-thread", "provider-99");
        assert_eq!(
            identity.prepare_control_request(&mut old),
            ControlDisposition::RejectStale
        );
        assert_eq!(old.turn_id, Some(TurnId::new("provider-99")));

        identity.bind_provider_turn("provider-next", TurnId::new("requested-next"));
        let mut current = approval("root-thread", "provider-next");
        assert_eq!(
            identity.prepare_control_request(&mut current),
            ControlDisposition::Forward
        );
        assert_eq!(current.turn_id, Some(TurnId::new("requested-next")));

        identity.clear();
        let state = identity.state.lock().unwrap();
        assert!(state.active.is_none());
        assert!(state.recent_provider_turn_id.is_none());
    }
}
