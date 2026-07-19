use std::{collections::HashMap, sync::Arc, time::Duration};

use tokio::sync::mpsc;
use vertebrae_harness_core::{
    ControlDecision, ControlRequestEnvelope, ControlRequestId, ControlResolution, ControlSink,
    EventCorrelation, HarnessError, HarnessEventDraftV1, HarnessEventPayloadV1, ResolutionSource,
    SequencedEventSink, StreamId,
};

use crate::ClaudeStreamDecoder;

use super::events::emit_runtime_event;

pub(super) struct PendingControl {
    pub(super) request: ControlRequestEnvelope,
    pub(super) provider_input: Option<serde_json::Value>,
    pub(super) stream_id: StreamId,
    pub(super) correlation: EventCorrelation,
    pub(super) abort: tokio::task::AbortHandle,
}

pub(super) struct ControlCompletion {
    pub(super) request_id: ControlRequestId,
    pub(super) result: Result<ControlResolution, HarnessError>,
}

fn timeout_resolution(request: &ControlRequestEnvelope, timeout_ms: u64) -> ControlResolution {
    ControlResolution {
        request_id: request.request_id.clone(),
        source: ResolutionSource::Timeout,
        decision: request
            .automatic_resolution
            .clone()
            .or(Some(ControlDecision::Deny)),
        message: Some(format!(
            "Claude control request timed out after {timeout_ms} ms"
        )),
    }
}

pub(super) async fn dispatch_provider_draft(
    sink: &SequencedEventSink,
    control_sink: Arc<dyn ControlSink>,
    completion_tx: &mpsc::UnboundedSender<ControlCompletion>,
    controls: &mut HashMap<ControlRequestId, PendingControl>,
    draft: HarnessEventDraftV1,
    provider_input: Option<serde_json::Value>,
) -> Result<(), HarnessError> {
    let control = match &draft.payload {
        HarnessEventPayloadV1::ControlRequested(control) => Some(control.clone()),
        _ => None,
    };
    let provider_cancel = match &draft.payload {
        HarnessEventPayloadV1::ControlResolved(resolution)
            if resolution.source == ResolutionSource::Provider
                && matches!(resolution.decision, Some(ControlDecision::Cancel)) =>
        {
            Some(resolution.request_id.clone())
        }
        _ => None,
    };
    let stream_id = draft.stream_id.clone();
    let correlation = draft.correlation.clone();
    if let Some(request_id) = provider_cancel {
        if let Some(pending) = controls.remove(&request_id) {
            pending.abort.abort();
            sink.emit(HarnessEventDraftV1 {
                stream_id: pending.stream_id,
                correlation: pending.correlation,
                ..draft
            })
            .await?;
        } else {
            sink.emit(HarnessEventDraftV1 {
                payload: HarnessEventPayloadV1::Warning(vertebrae_harness_core::DiagnosticEvent {
                    message: format!(
                        "Claude cancelled unknown or already-resolved control request {request_id}"
                    ),
                    code: Some("claude_unknown_control_cancel".into()),
                }),
                ..draft
            })
            .await?;
        }
        return Ok(());
    }
    sink.emit(draft).await?;
    if let Some(request) = control {
        if controls.contains_key(&request.request_id) {
            return Err(HarnessError::Control(format!(
                "duplicate Claude control request {}",
                request.request_id
            )));
        }
        let request_id = request.request_id.clone();
        let task_request = request.clone();
        let timeout_request = request.clone();
        let timeout_ms = request.timeout_ms;
        let completion_tx = completion_tx.clone();
        let task = tokio::spawn(async move {
            let result = match timeout_ms {
                Some(timeout_ms) => {
                    match tokio::time::timeout(
                        Duration::from_millis(timeout_ms),
                        control_sink.request(task_request),
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(_) => Ok(timeout_resolution(&timeout_request, timeout_ms)),
                    }
                }
                None => control_sink.request(task_request).await,
            };
            let _ = completion_tx.send(ControlCompletion { request_id, result });
        });
        controls.insert(
            request.request_id.clone(),
            PendingControl {
                request,
                provider_input,
                stream_id,
                correlation,
                abort: task.abort_handle(),
            },
        );
    }
    Ok(())
}

pub(super) fn provider_control_input(
    decoder: &mut ClaudeStreamDecoder,
    draft: &HarnessEventDraftV1,
) -> Option<serde_json::Value> {
    match &draft.payload {
        HarnessEventPayloadV1::ControlRequested(request) => {
            decoder.take_provider_control_input(&request.request_id)
        }
        _ => None,
    }
}

pub(super) async fn emit_control_resolution(
    sink: &SequencedEventSink,
    pending: &PendingControl,
    resolution: ControlResolution,
) -> Result<(), HarnessError> {
    emit_runtime_event(
        sink,
        pending.stream_id.clone(),
        pending.correlation.clone(),
        HarnessEventPayloadV1::ControlResolved(resolution),
    )
    .await
}

pub(super) async fn settle_pending_controls(
    sink: &SequencedEventSink,
    controls: &mut HashMap<ControlRequestId, PendingControl>,
    source: ResolutionSource,
    message: &str,
) -> Result<(), HarnessError> {
    let mut first_error = None;
    for (_, pending) in controls.drain() {
        pending.abort.abort();
        let resolution = ControlResolution {
            request_id: pending.request.request_id.clone(),
            source,
            decision: None,
            message: Some(message.to_string()),
        };
        if let Err(error) = emit_control_resolution(sink, &pending, resolution).await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    if let Some(error) = first_error {
        Err(error)
    } else {
        Ok(())
    }
}

pub(super) fn encode_control_response(
    request: &ControlRequestEnvelope,
    provider_input: Option<&serde_json::Value>,
    resolution: &ControlResolution,
) -> Result<String, String> {
    let original_input = provider_input
        .cloned()
        .unwrap_or_else(|| match &request.request {
            vertebrae_harness_core::ControlRequest::Approval(approval) => approval
                .details
                .as_ref()
                .and_then(|details| details.get("input"))
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
            _ => serde_json::json!({}),
        });
    let provider_decision = match resolution.decision.as_ref() {
        Some(ControlDecision::Deny | ControlDecision::Cancel) | None => serde_json::json!({
            "behavior": "deny",
            "message": resolution.message.clone().unwrap_or_else(|| "Denied by consumer".into())
        }),
        Some(ControlDecision::Modified(input)) => serde_json::json!({
            "behavior": "allow",
            "updatedInput": input
        }),
        Some(ControlDecision::QuestionsAnswered(answers)) => {
            let questions = match &request.request {
                vertebrae_harness_core::ControlRequest::UserQuestion { questions } => questions,
                _ => {
                    return Err(
                        "Claude question answers were supplied for a non-question control".into(),
                    );
                }
            };
            let mut provider_answers = serde_json::Map::new();
            for question in questions {
                let answer = answers
                    .iter()
                    .find(|answer| answer.question_id == question.id)
                    .ok_or_else(|| {
                        format!("no answer was supplied for question {}", question.id)
                    })?;
                for option_id in &answer.selected_option_ids {
                    if !question
                        .options
                        .iter()
                        .any(|option| &option.id == option_id)
                    {
                        return Err(format!(
                            "answer for question {} references unknown option {option_id}",
                            question.id
                        ));
                    }
                }
                let mut values = answer.selected_option_ids.clone();
                if let Some(free_form) = answer
                    .free_form
                    .as_deref()
                    .map(str::trim)
                    .filter(|answer| !answer.is_empty())
                {
                    values.push(free_form.to_owned());
                }
                provider_answers.insert(
                    question.prompt.clone(),
                    serde_json::Value::String(values.join(", ")),
                );
            }
            let mut updated_input = original_input.clone();
            let updated_input_object = updated_input
                .as_object_mut()
                .ok_or_else(|| "AskUserQuestion original input is not an object".to_string())?;
            updated_input_object.insert("answers".into(), provider_answers.into());
            serde_json::json!({
                "behavior": "allow",
                "updatedInput": updated_input
            })
        }
        Some(
            ControlDecision::AllowOnce
            | ControlDecision::AllowForSession
            | ControlDecision::PermissionsGranted { .. },
        ) => serde_json::json!({
            "behavior": "allow",
            "updatedInput": original_input
        }),
    };
    serde_json::to_string(&serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request.request_id.as_str(),
            "response": provider_decision
        }
    }))
    .map_err(|error| format!("failed to encode Claude control response: {error}"))
}
