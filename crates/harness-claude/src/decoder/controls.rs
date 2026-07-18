use serde_json::{Map, Value};
use vertebrae_harness_core::{
    ApprovalCategory, ApprovalRequest, ControlPresentation, ControlRequest, ControlRequestEnvelope,
    ControlRequestId, QuestionOption, ToolCallId, UserQuestion,
};

use super::drafts::string;
use super::{ClaudeDecodeContext, ClaudeDecodeError};

pub(super) fn decode_control_request(
    object: &Map<String, Value>,
    context: &ClaudeDecodeContext,
) -> Result<ControlRequestEnvelope, ClaudeDecodeError> {
    let request_id = string(object, "request_id")
        .ok_or_else(|| ClaudeDecodeError::Malformed("control_request has no request_id".into()))?;
    let request = object
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ClaudeDecodeError::Malformed("control_request has no request object".into())
        })?;
    let subtype = string(request, "subtype").unwrap_or("unknown");
    let tool_name = string(request, "tool_name").unwrap_or("Claude tool");
    let raw_input = request.get("input").cloned();
    let tool_call_id = string(request, "tool_use_id").map(ToolCallId::new);
    let control_request = if subtype == "can_use_tool" && tool_name == "AskUserQuestion" {
        ControlRequest::UserQuestion {
            questions: decode_user_questions(request)?,
        }
    } else {
        let category = match tool_name {
            "Bash" | "Shell" => ApprovalCategory::CommandExecution,
            "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => ApprovalCategory::FileChange,
            "WebFetch" | "WebSearch" => ApprovalCategory::NetworkAccess,
            _ => ApprovalCategory::AdditionalPermission,
        };
        ControlRequest::Approval(ApprovalRequest {
            category,
            title: if subtype == "can_use_tool" {
                format!("Allow Claude to use {tool_name}?")
            } else {
                format!("Claude control request: {subtype}")
            },
            details: Some(Value::Object(request.clone())),
            modification_supported: subtype == "can_use_tool",
        })
    };
    Ok(ControlRequestEnvelope {
        request_id: ControlRequestId::new(request_id),
        session_id: context.session_id.clone(),
        turn_id: context.turn_id.clone(),
        request: control_request,
        presentation: Some(ControlPresentation {
            tool_name: Some(tool_name.to_owned()),
            tool_call_id,
            input: raw_input,
            message: Some(format!("{tool_name} needs approval")),
        }),
        timeout_ms: object.get("timeout_ms").and_then(Value::as_u64),
        automatic_resolution: None,
    })
}

fn decode_user_questions(
    request: &Map<String, Value>,
) -> Result<Vec<UserQuestion>, ClaudeDecodeError> {
    let questions = request
        .get("input")
        .and_then(Value::as_object)
        .and_then(|input| input.get("questions"))
        .and_then(Value::as_array)
        .filter(|questions| !questions.is_empty())
        .ok_or_else(|| {
            ClaudeDecodeError::Malformed(
                "AskUserQuestion control input has no non-empty questions array".into(),
            )
        })?;
    questions
        .iter()
        .enumerate()
        .map(|(question_index, question)| {
            let question = question.as_object().ok_or_else(|| {
                ClaudeDecodeError::Malformed(format!(
                    "AskUserQuestion question {} is not an object",
                    question_index + 1
                ))
            })?;
            let prompt = string(question, "question")
                .filter(|prompt| !prompt.trim().is_empty())
                .ok_or_else(|| {
                    ClaudeDecodeError::Malformed(format!(
                        "AskUserQuestion question {} has no text",
                        question_index + 1
                    ))
                })?
                .to_owned();
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ClaudeDecodeError::Malformed(format!(
                        "AskUserQuestion question {} has no options array",
                        question_index + 1
                    ))
                })?
                .iter()
                .enumerate()
                .map(|(option_index, option)| {
                    let option = option.as_object().ok_or_else(|| {
                        ClaudeDecodeError::Malformed(format!(
                            "AskUserQuestion question {} option {} is not an object",
                            question_index + 1,
                            option_index + 1
                        ))
                    })?;
                    let label = string(option, "label")
                        .filter(|label| !label.trim().is_empty())
                        .ok_or_else(|| {
                            ClaudeDecodeError::Malformed(format!(
                                "AskUserQuestion question {} option {} has no label",
                                question_index + 1,
                                option_index + 1
                            ))
                        })?
                        .to_owned();
                    Ok(QuestionOption {
                        id: label.clone(),
                        label,
                        description: string(option, "description").map(str::to_owned),
                    })
                })
                .collect::<Result<Vec<_>, ClaudeDecodeError>>()?;
            let multiple = match question.get("multiSelect") {
                Some(value) => value.as_bool().ok_or_else(|| {
                    ClaudeDecodeError::Malformed(format!(
                        "AskUserQuestion question {} has non-boolean multiSelect",
                        question_index + 1
                    ))
                })?,
                None => false,
            };
            Ok(UserQuestion {
                id: prompt.clone(),
                prompt,
                header: string(question, "header").map(str::to_owned),
                options,
                multiple,
                free_form: true,
            })
        })
        .collect()
}
