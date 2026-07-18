use std::sync::Arc;

use vertebrae_harness_claude::{ClaudeDecodeContext, ClaudeStreamDecoder};
use vertebrae_harness_core::{
    CompletionStatus, ControlDecision, ControlRequest, HarnessEventPayloadV1, ProviderThreadRef,
    RunId, SessionId, StreamId, ThreadKind, TurnInputProvenance, UpdateSemantics,
};

#[test]
fn init_preserves_advertised_string_and_object_tool_names() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("run-tools"),
        StreamId::from("stream-tools"),
    ));
    let init = decoder
        .decode_line(
            r#"{"type":"system","subtype":"init","session_id":"conversation-tools","tools":["Read",{"name":"Bash","description":"Run commands"},42,{"missing":"name"}]}"#,
        )
        .unwrap();
    let started = init
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::SessionStarted(started) => Some(started),
            _ => None,
        })
        .unwrap();
    assert_eq!(started.tools, ["Read", "Bash"]);
}

#[test]
fn benign_protocol_records_are_silent_but_rate_limit_failures_are_errors() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("protocol-run"),
        StreamId::from("protocol-stream"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"protocol-session"}"#)
        .unwrap();
    assert!(
        decoder
            .decode_line(r#"{"type":"system","subtype":"status","status":"requesting"}"#)
            .unwrap()
            .is_empty()
    );
    assert!(decoder
        .decode_line(
            r#"{"type":"rate_limit_event","session_id":"protocol-session","rate_limit_info":{"status":"allowed"}}"#,
        )
        .unwrap()
        .is_empty());
    assert!(decoder
        .decode_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"opaque"}}}"#,
        )
        .unwrap()
        .is_empty());

    let failure = decoder
        .decode_line(
            r#"{"type":"rate_limit_event","session_id":"protocol-session","rate_limit_info":{"status":"rejected"}}"#,
        )
        .unwrap();
    assert!(failure.iter().any(|draft| matches!(
        &draft.payload,
        HarnessEventPayloadV1::Error(error)
            if error.code.as_deref() == Some("claude_rate_limited")
                && error.message.contains("rejected")
    )));
}

#[test]
fn slash_commands_and_compact_summaries_are_silent_user_records() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("skill-command-run"),
        StreamId::from("skill-command-stream"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"skill-command-session"}"#)
        .unwrap();

    let compact_summary = decoder
        .decode_line(
            r#"{"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context.\n\nContinue the conversation from where it left off."}}"#,
        )
        .unwrap();
    assert!(compact_summary.is_empty());

    let command = decoder
        .decode_line(
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"}}"#,
        )
        .unwrap();
    assert!(command.is_empty());

    let command_output = decoder
        .decode_line(
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"}}"#,
        )
        .unwrap();
    assert!(command_output.is_empty());

    let clear_command = decoder
        .decode_line(
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"}}"#,
        )
        .unwrap();
    assert!(clear_command.is_empty());

    let clear_output = decoder
        .decode_line(
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Cleared </local-command-stdout>"}}"#,
        )
        .unwrap();
    assert!(clear_output.is_empty());

    let tool_result = decoder
        .decode_line(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"ok"}]}}"#,
        )
        .unwrap();
    assert!(
        tool_result
            .iter()
            .any(|draft| matches!(draft.payload, HarnessEventPayloadV1::ToolOutput(_)))
    );
}

#[test]
fn root_child_and_grandchild_are_separate_canonical_streams() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("run-1"),
        StreamId::from("root-stream"),
    ));
    let init = decoder.decode_line(r#"{"type":"system","subtype":"init","session_id":"conversation-1","model":"claude-sonnet","transcript_path":"opaque://root/%2Fconversation.jsonl"}"#).unwrap();
    let root = init
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::ThreadDeclared(value) => Some(value),
            _ => None,
        })
        .unwrap();
    assert_eq!(root.thread_id.as_str(), "conversation-1");
    assert_eq!(root.kind, ThreadKind::Root);
    assert_eq!(
        root.provider_thread_ref.as_ref().unwrap().as_str(),
        "opaque://root/%2Fconversation.jsonl"
    );

    decoder.decode_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"spawn-child","name":"Task","input":{"prompt":"exact child prompt\nline two","subagent_type":"researcher","description":"Find evidence","model":"haiku"}}]}}"#).unwrap();
    let child = decoder.decode_line(r#"{"type":"assistant","agent_id":"child-agent","parent_tool_use_id":"spawn-child","transcript_path":"subagents/agent-child-agent.jsonl","message":{"content":[{"type":"text","text":"child answer"},{"type":"tool_use","id":"spawn-grandchild","name":"Task","input":{"prompt":"exact grandchild prompt","subagent_type":"reader"}}]}}"#).unwrap();
    let child_declared = child
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::ThreadDeclared(value) => Some(value),
            _ => None,
        })
        .unwrap();
    assert_eq!(child_declared.thread_id.as_str(), "child-agent");
    assert_eq!(
        child_declared.parent_thread_id.as_ref().unwrap().as_str(),
        "conversation-1"
    );
    assert_eq!(
        child_declared
            .caused_by_tool_call_id
            .as_ref()
            .unwrap()
            .as_str(),
        "spawn-child"
    );
    assert_eq!(
        child_declared
            .provider_thread_ref
            .as_ref()
            .unwrap()
            .as_str(),
        "subagents/agent-child-agent.jsonl"
    );
    assert_eq!(
        child_declared
            .agent_metadata
            .as_ref()
            .unwrap()
            .role
            .as_deref(),
        Some("Find evidence")
    );
    assert!(
        child
            .iter()
            .all(|draft| draft.stream_id.as_str() == "root-stream/agent/child-agent")
    );
    let child_input = child
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::TurnInput(value) => Some(value),
            _ => None,
        })
        .unwrap();
    assert_eq!(child_input.content, "exact child prompt\nline two");
    assert_eq!(child_input.provenance, TurnInputProvenance::Agent);

    let grandchild = decoder.decode_line(r#"{"type":"assistant","agent_id":"grandchild-agent","parent_tool_use_id":"spawn-grandchild","transcript_path":"subagents/agent-grandchild-agent.jsonl","message":{"content":[{"type":"text","text":"grandchild answer"}]}}"#).unwrap();
    let declaration = grandchild
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::ThreadDeclared(value) => Some(value),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        declaration.parent_thread_id.as_ref().unwrap().as_str(),
        "child-agent"
    );
    assert_eq!(
        declaration
            .caused_by_tool_call_id
            .as_ref()
            .unwrap()
            .as_str(),
        "spawn-grandchild"
    );
    assert!(
        grandchild
            .iter()
            .all(|draft| draft.stream_id.as_str() == "root-stream/agent/grandchild-agent")
    );
    assert_ne!(child[0].stream_id, grandchild[0].stream_id);
}

#[test]
fn live_content_reasoning_plan_tools_usage_and_terminal_outcome_map_neutrally() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("run-2"),
        StreamId::from("stream-2"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"conversation-2"}"#)
        .unwrap();
    let delta = decoder.decode_line(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"part"}}}"#).unwrap();
    assert!(matches!(delta[0].payload, HarnessEventPayloadV1::Text(_)));
    assert_eq!(delta[0].semantics, UpdateSemantics::Delta);
    let thinking = decoder.decode_line(r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"reason"}}"#).unwrap();
    assert!(matches!(
        thinking[0].payload,
        HarnessEventPayloadV1::Reasoning(_)
    ));

    let assistant = decoder.decode_line(r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":2,"output_tokens":3},"content":[{"type":"text","text":"snapshot"},{"type":"tool_use","id":"todo","name":"TodoWrite","input":{"todos":[{"id":"a","content":"First","status":"in_progress"}]}},{"type":"tool_use","id":"bash","name":"Bash","input":{"command":"pwd"}}]}}"#).unwrap();
    assert!(
        assistant
            .iter()
            .any(|draft| matches!(draft.payload, HarnessEventPayloadV1::Usage(_)))
    );
    assert!(
        assistant
            .iter()
            .any(|draft| matches!(draft.payload, HarnessEventPayloadV1::Plan(_)))
    );
    assert_eq!(
        assistant
            .iter()
            .filter(|draft| matches!(draft.payload, HarnessEventPayloadV1::ToolCall(_)))
            .count(),
        2
    );

    let result = decoder.decode_line(r#"{"type":"result","subtype":"success","result":"done","structured_output":{"ok":true},"duration_ms":4321,"num_turns":7,"total_cost_usd":0.42,"modelUsage":{"sonnet":{"contextWindow":180000},"opus":{"contextWindow":200000}},"usage":{"input_tokens":20,"output_tokens":5}}"#).unwrap();
    let outcome = result
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::RunFinished(value) => Some(value),
            _ => None,
        })
        .unwrap();
    assert_eq!(outcome.status, CompletionStatus::Completed);
    assert_eq!(outcome.result_text.as_deref(), Some("done"));
    assert_eq!(outcome.structured_output.as_ref().unwrap()["ok"], true);
    assert_eq!(outcome.usage.as_ref().unwrap().tokens.output_tokens, 5);
    assert_eq!(outcome.metrics.duration_ms, Some(4321));
    assert_eq!(outcome.metrics.turn_count, Some(7));
    assert_eq!(outcome.metrics.total_cost_usd, Some(0.42));
    assert_eq!(outcome.metrics.context_tokens, Some(0));
    assert_eq!(outcome.metrics.context_window, Some(200_000));
}

#[test]
fn result_cost_is_preserved_without_a_usage_object() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("run-cost-only"),
        StreamId::from("stream-cost-only"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"cost-only"}"#)
        .unwrap();
    let result = decoder
        .decode_line(
            r#"{"type":"result","subtype":"success","result":"done","duration_ms":9,"num_turns":2,"total_cost_usd":0.375}"#,
        )
        .unwrap();
    let outcome = result
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::RunFinished(outcome) => Some(outcome),
            _ => None,
        })
        .unwrap();
    assert!(outcome.usage.is_none());
    assert_eq!(outcome.metrics.total_cost_usd, Some(0.375));
    assert_eq!(outcome.metrics.duration_ms, Some(9));
    assert_eq!(outcome.metrics.turn_count, Some(2));
}

#[test]
fn unknown_records_are_contained_but_malformed_records_fail_without_ids() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("run"),
        StreamId::from("stream"),
    ));
    let unknown = decoder
        .decode_line(r#"{"type":"future_record","new":true}"#)
        .unwrap();
    assert_eq!(unknown.len(), 1);
    assert!(matches!(
        unknown[0].payload,
        HarnessEventPayloadV1::Warning(_)
    ));
    assert!(unknown[0].correlation.thread_id.is_none());
    assert!(unknown[0].correlation.session_id.is_none());
    assert_eq!(
        unknown[0].correlation.run_id.as_ref().unwrap().as_str(),
        "run"
    );
    assert!(decoder.decode_line("{broken").is_err());
    assert!(decoder.decode_line(r#"{"field":"without-type"}"#).is_err());
}

#[test]
fn top_level_controls_and_ask_user_tool_calls_both_decode_canonically() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("run-control"),
        StreamId::from("stream-control"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"control-session"}"#)
        .unwrap();
    let control = decoder.decode_line(r#"{"type":"control_request","request_id":"request-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"pwd"},"tool_use_id":"tool-1"}}"#).unwrap();
    assert!(matches!(
        &control[0].payload,
        HarnessEventPayloadV1::ControlRequested(request)
            if request.request_id.as_str() == "request-1"
    ));

    let assistant = decoder.decode_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"ask-1","name":"AskUserQuestion","input":{"questions":[]}}]}}"#).unwrap();
    assert!(assistant.iter().any(|draft| matches!(
        &draft.payload,
        HarnessEventPayloadV1::ToolCall(tool)
            if tool.name == "AskUserQuestion" && tool.tool_call_id.as_str() == "ask-1"
    )));
    assert!(
        !assistant
            .iter()
            .any(|draft| matches!(draft.payload, HarnessEventPayloadV1::ControlRequested(_)))
    );
}

#[test]
fn subagent_records_wait_for_spawn_lineage_and_provider_locator() {
    let mut child_before_spawn = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("run-buffer"),
        StreamId::from("stream-buffer"),
    ));
    child_before_spawn
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"root"}"#)
        .unwrap();
    let buffered = child_before_spawn.decode_line(r#"{"type":"assistant","agent_id":"child","parent_tool_use_id":"spawn","transcript_path":"subagents/agent-child.jsonl","message":{"content":[{"type":"text","text":"child first"}]}}"#).unwrap();
    assert!(buffered.is_empty());
    let flushed = child_before_spawn.decode_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"spawn","name":"Task","input":{"prompt":"exact prompt","subagent_type":"researcher"}}]}}"#).unwrap();
    let declaration_index = flushed
        .iter()
        .position(|draft| matches!(draft.payload, HarnessEventPayloadV1::ThreadDeclared(_)))
        .unwrap();
    let text_index = flushed.iter().position(|draft| matches!(&draft.payload, HarnessEventPayloadV1::Text(text) if text.text == "child first")).unwrap();
    assert!(declaration_index < text_index);
    let declaration = match &flushed[declaration_index].payload {
        HarnessEventPayloadV1::ThreadDeclared(value) => value,
        _ => unreachable!(),
    };
    assert_eq!(
        declaration.parent_thread_id.as_ref().unwrap().as_str(),
        "root"
    );
    assert_eq!(
        declaration
            .caused_by_tool_call_id
            .as_ref()
            .unwrap()
            .as_str(),
        "spawn"
    );
    assert_eq!(
        declaration.provider_thread_ref.as_ref().unwrap().as_str(),
        "subagents/agent-child.jsonl"
    );

    let mut locator_later = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("run-locator"),
        StreamId::from("stream-locator"),
    ));
    locator_later
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"root-2"}"#)
        .unwrap();
    locator_later.decode_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"spawn-2","name":"Task","input":{"prompt":"prompt-2"}}]}}"#).unwrap();
    assert!(locator_later.decode_line(r#"{"type":"assistant","agent_id":"child-2","parent_tool_use_id":"spawn-2","message":{"content":[{"type":"text","text":"before locator"}]}}"#).unwrap().is_empty());
    let flushed = locator_later.decode_line(r#"{"type":"assistant","agent_id":"child-2","parent_tool_use_id":"spawn-2","transcript_path":"subagents/agent-child-2.jsonl","message":{"content":[{"type":"text","text":"after locator"}]}}"#).unwrap();
    let texts = flushed
        .iter()
        .filter_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(texts, vec!["before locator", "after locator"]);
    assert!(matches!(
        flushed[0].payload,
        HarnessEventPayloadV1::ThreadDeclared(_)
    ));
}

#[test]
fn real_init_waits_for_a_canonical_root_locator_and_never_amends_declaration() {
    let resolver = Arc::new(|session_id: &SessionId| {
        Ok(Some(ProviderThreadRef::new(format!(
            "surface://transcripts/{}",
            session_id.as_str()
        ))))
    });
    let mut configured = ClaudeStreamDecoder::with_root_locator_resolver(
        ClaudeDecodeContext::one_shot(
            RunId::from("configured-run"),
            StreamId::from("configured-stream"),
        ),
        Some(resolver),
    );
    let events = configured
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"real-init"}"#)
        .unwrap();
    let declaration = events
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::ThreadDeclared(declaration) => Some(declaration),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        declaration.provider_thread_ref.as_ref().unwrap().as_str(),
        "surface://transcripts/real-init"
    );

    let mut later = ClaudeStreamDecoder::new(ClaudeDecodeContext::one_shot(
        RunId::from("later-run"),
        StreamId::from("later-stream"),
    ));
    assert!(
        later
            .decode_line(r#"{"type":"system","subtype":"init","session_id":"later-init"}"#)
            .unwrap()
            .is_empty()
    );
    assert!(
        later
            .decode_line(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"buffered"}]}}"#
            )
            .unwrap()
            .is_empty()
    );
    let events = later
        .resolve_root_locator(ProviderThreadRef::from("surface://later/root.jsonl"))
        .unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|draft| matches!(draft.payload, HarnessEventPayloadV1::ThreadDeclared(_)))
            .count(),
        1
    );
    assert!(events.iter().any(
        |draft| matches!(&draft.payload, HarnessEventPayloadV1::Text(text) if text.text == "buffered")
    ));
    assert!(
        later
            .resolve_root_locator(ProviderThreadRef::from("surface://different.jsonl"))
            .is_err()
    );
}

#[test]
fn ask_user_controls_and_provider_cancellations_decode_neutrally() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("questions-run"),
        StreamId::from("questions-stream"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"questions-session"}"#)
        .unwrap();
    let events = decoder.decode_line(r#"{"type":"control_request","request_id":"question-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"question-tool","input":{"questions":[{"question":"Which environment?","header":"Environment","options":[{"label":"Staging","description":"Use staging"},{"label":"Production","description":"Use production"}],"multiSelect":false}]}}}"#).unwrap();
    let request = events
        .iter()
        .find_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::ControlRequested(request) => Some(request),
            _ => None,
        })
        .unwrap();
    match &request.request {
        ControlRequest::UserQuestion { questions } => {
            assert_eq!(questions[0].id, "Which environment?");
            assert_eq!(questions[0].prompt, "Which environment?");
            assert_eq!(questions[0].header.as_deref(), Some("Environment"));
            assert_eq!(questions[0].options[0].id, "Staging");
            assert!(!questions[0].multiple);
        }
        other => panic!("expected user question, got {other:?}"),
    }
    let presentation = request.presentation.as_ref().unwrap();
    assert_eq!(presentation.tool_name.as_deref(), Some("AskUserQuestion"));
    assert_eq!(
        presentation.tool_call_id.as_ref().unwrap().as_str(),
        "question-tool"
    );
    assert_eq!(
        presentation.input.as_ref().unwrap()["questions"][0]["header"],
        "Environment"
    );
    assert_eq!(
        presentation.message.as_deref(),
        Some("AskUserQuestion needs approval")
    );

    let events = decoder
        .decode_line(r#"{"type":"control_cancel_request","request_id":"question-1"}"#)
        .unwrap();
    assert!(events.iter().any(|draft| matches!(
        &draft.payload,
        HarnessEventPayloadV1::ControlResolved(resolution)
            if resolution.source == vertebrae_harness_core::ResolutionSource::Provider
                && resolution.decision == Some(ControlDecision::Cancel)
    )));
}

#[test]
fn nested_unknown_records_warn_and_malformed_known_shapes_fail() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("nested-hardening-run"),
        StreamId::from("nested-hardening-stream"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"nested-hardening"}"#)
        .unwrap();
    let warning = decoder
        .decode_line(r#"{"type":"stream_event","event":{"type":"future_nested_event"}}"#)
        .unwrap();
    assert!(warning.iter().any(|draft| matches!(
        &draft.payload,
        HarnessEventPayloadV1::Warning(warning)
            if warning.code.as_deref() == Some("claude_unknown_stream_event")
    )));
    let error = decoder
        .decode_line(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta"}}}"#,
        )
        .unwrap_err();
    assert!(error.to_string().contains("text_delta has no text"));
}

#[test]
fn message_content_validation_rejects_every_malformed_known_boundary() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("message-validation-run"),
        StreamId::from("message-validation-stream"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"message-validation"}"#)
        .unwrap();

    for (name, line, expected) in [
        (
            "missing message",
            r#"{"type":"assistant"}"#,
            "has no message",
        ),
        (
            "non-object message",
            r#"{"type":"assistant","message":[]}"#,
            "message is not an object",
        ),
        (
            "missing content",
            r#"{"type":"assistant","message":{}}"#,
            "has no content",
        ),
        (
            "non-array content",
            r#"{"type":"assistant","message":{"content":{}}}"#,
            "content is not an array",
        ),
        (
            "non-object block",
            r#"{"type":"assistant","message":{"content":[42]}}"#,
            "content block 1 is not an object",
        ),
        (
            "block missing type",
            r#"{"type":"assistant","message":{"content":[{}]}}"#,
            "content block has no type",
        ),
        (
            "text missing text",
            r#"{"type":"assistant","message":{"content":[{"type":"text"}]}}"#,
            "text content block has no text",
        ),
        (
            "thinking wrong shape",
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":7}]}}"#,
            "thinking is not a string",
        ),
        (
            "tool use missing id",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{}}]}}"#,
            "tool_use content block has no id",
        ),
        (
            "tool use missing name",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","input":{}}]}}"#,
            "tool_use content block has no name",
        ),
        (
            "tool use missing input",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Read"}]}}"#,
            "tool_use content block has no input",
        ),
        (
            "tool use empty id",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"","name":"Read","input":{}}]}}"#,
            "tool_use content block id is empty",
        ),
        (
            "tool result missing id",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            "tool_result content block has no tool_use_id",
        ),
        (
            "tool result missing content",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1"}]}}"#,
            "tool_result content block has no content",
        ),
        (
            "tool result invalid error flag",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"bad","is_error":"yes"}]}}"#,
            "is_error is not a boolean",
        ),
        (
            "invalid usage",
            r#"{"type":"assistant","message":{"usage":3,"content":[]}}"#,
            "usage is not an object",
        ),
        (
            "invalid todo nesting",
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"todo-1","name":"TodoWrite","input":{"todos":["bad"]}}]}}"#,
            "TodoWrite item 1 is not an object",
        ),
        (
            "invalid ignored image",
            r#"{"type":"user","message":{"content":[{"type":"image","source":"bad"}]}}"#,
            "image content block has no source object",
        ),
    ] {
        let error = match decoder.decode_line(line) {
            Ok(_) => panic!("{name} should fail"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains(expected),
            "{name}: expected {expected:?}, got {error}"
        );
    }
}

#[test]
fn unknown_message_blocks_warn_and_known_ignored_blocks_are_explicit_noops() {
    let mut decoder = configured_decoder(ClaudeDecodeContext::one_shot(
        RunId::from("content-kind-run"),
        StreamId::from("content-kind-stream"),
    ));
    decoder
        .decode_line(r#"{"type":"system","subtype":"init","session_id":"content-kind"}"#)
        .unwrap();
    let events = decoder.decode_line(r#"{"type":"assistant","message":{"content":[{"type":"future_content","payload":{"ok":true}},{"type":"text","text":"continued"}]}}"#).unwrap();
    assert!(events.iter().any(|draft| matches!(
        &draft.payload,
        HarnessEventPayloadV1::Warning(warning)
            if warning.code.as_deref() == Some("claude_unknown_content_block")
    )));
    assert!(events.iter().any(
        |draft| matches!(&draft.payload, HarnessEventPayloadV1::Text(text) if text.text == "continued")
    ));

    let ignored = decoder.decode_line(r#"{"type":"assistant","message":{"content":[{"type":"redacted_thinking","data":"opaque"},{"type":"image","source":{"type":"base64","data":"opaque"}},{"type":"document","source":{"type":"text","data":"opaque"}},{"type":"tool_result","tool_use_id":"tool-ignored","content":"ok"}]}}"#).unwrap();
    assert!(ignored.is_empty());
    let ignored = decoder.decode_line(r#"{"type":"user","message":{"content":[{"type":"text","text":"echo"},{"type":"tool_use","id":"ignored-use","name":"Read","input":{}}]}}"#).unwrap();
    assert!(ignored.is_empty());
}

fn configured_decoder(context: ClaudeDecodeContext) -> ClaudeStreamDecoder {
    ClaudeStreamDecoder::with_root_locator_resolver(
        context,
        Some(Arc::new(|session_id: &SessionId| {
            Ok(Some(ProviderThreadRef::new(format!(
                "fixture://root/{}",
                session_id.as_str()
            ))))
        })),
    )
}
