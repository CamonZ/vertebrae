use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};
use vertebrae_harness_core::{
    ControlDecision, ControlPresentation, ControlRequest, ControlRequestEnvelope, ControlRequestId,
    ControlResolution, EventCorrelation, HarnessEventPayloadV1 as Event, QuestionOption, TextEvent,
    ToolCallEvent, ToolCallId, ToolOutputEvent, ToolStatus, UpdateSemantics, UserQuestion,
};

pub(crate) fn update(value: &Value) -> Option<(Event, UpdateSemantics)> {
    match value["sessionUpdate"].as_str()? {
        "agent_message_chunk" if value["content"]["type"] == "text" => Some((
            Event::Text(TextEvent {
                text: value["content"]["text"].as_str()?.to_owned(),
                completion_status: None,
            }),
            UpdateSemantics::Delta,
        )),
        "tool_call" | "tool_call_update" => {
            let tool_call_id = ToolCallId::new(value["toolCallId"].as_str()?);
            let status = match value["status"].as_str() {
                Some("completed") => ToolStatus::Completed,
                Some("failed") => ToolStatus::Failed,
                Some("in_progress") => ToolStatus::Running,
                _ => ToolStatus::Started,
            };
            if value["sessionUpdate"] == "tool_call" {
                let name = value["title"].as_str().unwrap_or("Agent tool").to_owned();
                Some((
                    Event::ToolCall(ToolCallEvent {
                        tool_call_id,
                        name,
                        input: value.get("rawInput").cloned().unwrap_or_else(|| json!({})),
                        status,
                    }),
                    UpdateSemantics::Snapshot,
                ))
            } else if status.is_terminal() {
                let output = value
                    .get("rawOutput")
                    .or_else(|| value.get("content"))
                    .cloned()
                    .unwrap_or_else(|| json!(""));
                Some((
                    Event::ToolOutput(ToolOutputEvent {
                        tool_call_id,
                        output,
                        status,
                        content_semantics: UpdateSemantics::Snapshot,
                    }),
                    UpdateSemantics::Snapshot,
                ))
            } else {
                None
            }
        }
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionOption {
    option_id: String,
    name: String,
    #[serde(rename = "_meta")]
    metadata: Option<Value>,
}

pub(crate) fn permission(
    params: &Value,
    correlation: &EventCorrelation,
) -> Option<ControlRequestEnvelope> {
    let options: Vec<PermissionOption> = serde_json::from_value(params["options"].clone()).ok()?;
    let mut ids = HashSet::new();
    if options.is_empty()
        || options.iter().any(|option| {
            option.option_id.is_empty()
                || option.name.trim().is_empty()
                || !ids.insert(&option.option_id)
        })
    {
        return None;
    }
    let mut names = HashSet::new();
    let disambiguate = options.iter().any(|option| !names.insert(&option.name));
    let tool = &params["toolCall"];
    let title = tool["title"].as_str().unwrap_or("Agent tool");
    let fixed_choice = tool["toolCallId"]
        .as_str()
        .is_some_and(|id| id.starts_with("interaction_"));
    let question = UserQuestion {
        id: "permission".into(),
        prompt: title.to_owned(),
        header: Some(
            if fixed_choice {
                "Question"
            } else {
                "Agent permission"
            }
            .into(),
        ),
        options: options
            .into_iter()
            .enumerate()
            .map(|(index, option)| QuestionOption {
                id: option.option_id,
                label: if disambiguate {
                    format!("{}. {}", index + 1, option.name)
                } else {
                    option.name
                },
                description: option
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.pointer("/agy.security.warning/message"))
                    .and_then(Value::as_str)
                    .map(|message| message.chars().take(512).collect()),
            })
            .collect(),
        multiple: false,
        free_form: false,
    };
    Some(ControlRequestEnvelope {
        request_id: ControlRequestId::new(uuid::Uuid::new_v4().to_string()),
        session_id: correlation.session_id.clone(),
        turn_id: correlation.turn_id.clone(),
        thread_id: correlation.thread_id.clone(),
        is_root: Some(true),
        request: ControlRequest::UserQuestion {
            questions: vec![question],
        },
        // The approval card and the tool activity have separate identities.
        presentation: Some(ControlPresentation {
            question_presentation: Some(if fixed_choice {
                vertebrae_harness_core::QuestionPresentation::FixedChoice
            } else {
                vertebrae_harness_core::QuestionPresentation::Approval
            }),
            ..Default::default()
        }),
        timeout_ms: None,
        automatic_resolution: None,
    })
}

pub(crate) fn permission_response(
    id: &Value,
    request: &ControlRequestEnvelope,
    resolution: Option<ControlResolution>,
) -> Value {
    let selected = resolution
        .filter(|resolution| resolution.request_id == request.request_id)
        .and_then(|resolution| resolution.decision)
        .and_then(|decision| match (&request.request, decision) {
            (
                ControlRequest::UserQuestion { questions },
                ControlDecision::QuestionsAnswered(answers),
            ) => {
                let question = questions.first()?;
                let answer = answers
                    .iter()
                    .find(|answer| answer.question_id == question.id)?;
                question
                    .options
                    .iter()
                    .find(|option| answer.selected_option_ids.as_slice() == [option.id.as_str()])
                    .map(|option| option.id.clone())
            }
            _ => None,
        });
    let outcome = selected.map_or_else(
        || json!({"outcome":"cancelled"}),
        |option_id| json!({"outcome":"selected", "optionId":option_id}),
    );
    json!({"jsonrpc":"2.0", "id":id, "result":{"outcome":outcome}})
}

pub(crate) fn cancel_permission(id: &Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result":{"outcome":{"outcome":"cancelled"}}})
}
