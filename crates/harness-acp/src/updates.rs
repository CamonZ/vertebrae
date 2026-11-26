use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::{Value, json};
use vertebrae_harness_core::{
    ControlDecision, ControlPresentation, ControlRequest, ControlRequestEnvelope, ControlRequestId,
    ControlResolution, EventCorrelation, HarnessEventPayloadV1 as Event, QuestionOption,
    SessionUsage, TextEvent, ToolCallEvent, ToolCallId, ToolOutputEvent, ToolStatus,
    UpdateSemantics, UsageEvent, UserQuestion,
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
        "usage_update" => {
            let size = value["size"].as_u64().filter(|size| *size > 0)?;
            let used = value["used"].as_u64()?;
            Some((
                Event::Usage(UsageEvent {
                    turn_delta: None,
                    session_snapshot: Some(SessionUsage {
                        context_tokens: Some(used),
                        context_window: Some(size),
                        ..Default::default()
                    }),
                }),
                UpdateSemantics::Snapshot,
            ))
        }
        _ => None,
    }
}

#[derive(Default)]
pub(crate) struct ToolCalls(HashMap<String, ToolCall>);

struct ToolCall {
    name: String,
    summary: Option<String>,
    input: Value,
    output: Option<Value>,
    status: ToolStatus,
}

impl ToolCalls {
    pub(crate) fn update(&mut self, value: &Value) -> Option<Vec<(Event, UpdateSemantics)>> {
        match value["sessionUpdate"].as_str()? {
            "tool_call" | "tool_call_update" => {}
            _ => return None,
        }
        let id = value["toolCallId"].as_str()?;
        let first = !self.0.contains_key(id);
        let call = self.0.entry(id.to_owned()).or_insert_with(|| ToolCall {
            name: "Agent tool".to_owned(),
            summary: None,
            input: json!({}),
            output: None,
            status: ToolStatus::Started,
        });
        let name = value["name"].as_str().or_else(|| {
            (call.name == "Agent tool")
                .then(|| value["kind"].as_str())
                .flatten()
        });
        let mut changed = first;
        if let Some(name) = name {
            changed |= call.name != name;
            call.name = name.to_owned();
        }
        if let Some(title) = value["title"]
            .as_str()
            .filter(|title| !title.trim().is_empty())
        {
            changed |= call.summary.as_deref() != Some(title);
            call.summary = Some(title.to_owned());
        }
        if let Some(input) = value.get("rawInput").filter(|input| !input.is_null()) {
            changed |= &call.input != input;
            call.input = input.clone();
        }
        let output = tool_output(value);
        let output_changed = output
            .as_ref()
            .is_some_and(|output| call.output.as_ref() != Some(output));
        if let Some(output) = output {
            call.output = Some(output);
        }
        let previous_status = call.status;
        call.status = match value["status"].as_str() {
            Some("completed") => ToolStatus::Completed,
            Some("failed") => ToolStatus::Failed,
            Some("in_progress") => ToolStatus::Running,
            _ => call.status,
        };
        let tool_call_id = ToolCallId::new(id);
        let mut events = Vec::new();
        if changed || (call.status != previous_status && !call.status.is_terminal()) {
            events.push((
                Event::ToolCall(ToolCallEvent {
                    tool_call_id: tool_call_id.clone(),
                    name: call.name.clone(),
                    summary: call.input["toolSummary"]
                        .as_str()
                        .map(str::trim)
                        .filter(|summary| !summary.is_empty())
                        .map(str::to_owned)
                        .or_else(|| call.summary.clone()),
                    input: call.input.clone(),
                    status: call.status,
                }),
                UpdateSemantics::Snapshot,
            ));
        }
        if call.status.is_terminal() && (first || call.status != previous_status || output_changed)
        {
            events.push((
                Event::ToolOutput(ToolOutputEvent {
                    tool_call_id,
                    output: call.output.clone().unwrap_or_else(|| json!("")),
                    status: call.status,
                    content_semantics: UpdateSemantics::Snapshot,
                }),
                UpdateSemantics::Snapshot,
            ));
        }
        Some(events)
    }
}

fn tool_output(value: &Value) -> Option<Value> {
    if let Some(content) = value["content"]
        .as_array()
        .filter(|content| !content.is_empty())
    {
        let text: Vec<_> = content
            .iter()
            .filter_map(|block| {
                (block["type"] == "content" && block["content"]["type"] == "text")
                    .then(|| block["content"]["text"].as_str())
                    .flatten()
            })
            .collect();
        return Some(if text.len() == content.len() {
            json!(text.join("\n"))
        } else {
            json!(content)
        });
    }
    value
        .get("rawOutput")
        .filter(|output| !output.is_null())
        .cloned()
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

#[cfg(test)]
mod tool_tests {
    use super::*;

    #[test]
    fn tool_updates_preserve_the_latest_title_and_prior_output() {
        let mut calls = ToolCalls::default();
        let initial = calls
            .update(&json!({
                "sessionUpdate": "tool_call", "toolCallId": "tool",
                "name": "read_file", "title": "Reading config"
            }))
            .unwrap();
        assert!(matches!(&initial[0].0, Event::ToolCall(call)
            if call.name == "read_file" && call.summary.as_deref() == Some("Reading config")));

        let progress = calls
            .update(&json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "tool",
                "title": "short title", "rawInput": {"toolSummary": "Read config"}, "status": "in_progress",
                "content": [{"type":"content", "content":{"type":"text", "text":"loaded"}}]
            }))
            .unwrap();
        assert!(matches!(&progress[..], [(Event::ToolCall(call), _)]
            if call.name == "read_file" && call.summary.as_deref() == Some("Read config")));

        let completion = calls
            .update(&json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "tool", "status": "completed"
            }))
            .unwrap();
        assert!(matches!(&completion[..], [(Event::ToolOutput(output), _)]
            if output.output == "loaded" && output.status == ToolStatus::Completed));
    }
}
