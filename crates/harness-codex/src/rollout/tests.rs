use super::*;
use crate::runtime::projection::{file_change_event, tool_call, tool_output};
use tempfile::tempdir;

const ROLLOUT: &str = include_str!("../../tests/fixtures/code-mode/rollout.jsonl");
const ITEMS: &str = include_str!("../../tests/fixtures/code-mode/app-server-items.json");
const PLUMBING: &str = include_str!("../../tests/fixtures/code-mode/plumbing.jsonl");

fn request() -> TranscriptReplayRequest {
    TranscriptReplayRequest {
        provider_resume_id: ProviderResumeId::new("code-mode"),
        stream_id: StreamId::new("replay/code-mode"),
        project_path: None,
        created_at: Some("2026-01-01T00:00:00Z".into()),
    }
}

fn parse(body: &str) -> Vec<HarnessEventDraftV1> {
    let directory = tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    std::fs::write(&path, body).unwrap();
    read_rollout(&path, &request()).unwrap()
}

fn tools(drafts: &[HarnessEventDraftV1]) -> Vec<HarnessEventPayloadV1> {
    drafts
        .iter()
        .filter_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::ToolCall(_)
            | HarnessEventPayloadV1::ToolOutput(_)
            | HarnessEventPayloadV1::FileChange(_) => Some(draft.payload.clone()),
            _ => None,
        })
        .collect()
}

fn completed(item: Value) -> String {
    json!({"timestamp":"2026-01-01T00:00:00Z", "type":"event_msg", "payload":{"type":"item_completed","item":item}}).to_string() + "\n"
}

#[test]
fn real_core_items_match_app_server_projection_and_ids() {
    let items: Vec<Value> = serde_json::from_str(ITEMS).unwrap();
    let mut expected = Vec::new();
    for item in &items {
        if let Some(change) = file_change_event(item) {
            expected.push(HarnessEventPayloadV1::FileChange(change));
        } else {
            let (id, name, input, _) = tool_call(item).expect("live tool call");
            expected.push(HarnessEventPayloadV1::ToolCall(ToolCallEvent {
                tool_call_id: ToolCallId::new(id),
                name,
                input,
                status: ToolStatus::Started,
            }));
            let (id, output, failed) = tool_output(item).expect("live output");
            expected.push(HarnessEventPayloadV1::ToolOutput(ToolOutputEvent {
                tool_call_id: ToolCallId::new(id),
                output,
                status: if failed {
                    ToolStatus::Failed
                } else {
                    ToolStatus::Completed
                },
                content_semantics: UpdateSemantics::Snapshot,
            }));
        }
    }
    let drafts = parse(ROLLOUT);
    let actual = tools(&drafts);
    assert_eq!(actual, expected);
    assert_eq!(actual.len(), 5);
    assert!(matches!(&actual[0], HarnessEventPayloadV1::ToolCall(call)
        if call.name == "Bash" && call.input == json!({"command":"/bin/zsh -lc 'echo from-root'", "cwd":"/fixture"})));
    assert!(
        matches!(&actual[2], HarnessEventPayloadV1::FileChange(change)
        if change.changes[0].kind == FileChangeKind::Added && change.changes[0].patch.as_deref() == Some("hi\n"))
    );
    assert!(matches!(&actual[3], HarnessEventPayloadV1::ToolCall(call)
        if call.name == "search_openai_docs" && call.tool_call_id.as_str() == "exec-a94227f1-77e7-4e86-859d-c058742ec47c"));
    for draft in drafts
        .iter()
        .filter(|draft| draft.correlation.item_id.is_some())
    {
        assert_eq!(
            draft.correlation.item_id.as_ref().unwrap().as_str(),
            draft.correlation.tool_call_id.as_ref().unwrap().as_str()
        );
    }
}

#[test]
fn plumbing_calls_and_outputs_disappear_but_collaboration_stays() {
    let events = tools(&parse(PLUMBING));
    assert_eq!(events.len(), 4);
    let calls = events
        .iter()
        .filter_map(|event| match event {
            HarnessEventPayloadV1::ToolCall(call) => {
                Some((call.name.as_str(), call.tool_call_id.as_str()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        calls,
        vec![
            ("spawn_agent", "call_f28e790fe13543cd96438e1dc6e90022"),
            ("wait_agent", "call_ef3527d38c554ffca8bae501718af76d"),
        ]
    );
}

#[test]
fn commands_preserve_shell_quoting_cwd_and_failure() {
    let body = completed(json!({"type":"CommandExecution", "id":"exec-failed",
        "command":["/bin/zsh", "-lc", "printf '%s' \"a b\""], "cwd":"file:///tmp/a%20b",
        "exit_code": 7, "status":"completed", "aggregated_output":"failure"}));
    let events = tools(&parse(&body));
    assert!(matches!(&events[0], HarnessEventPayloadV1::ToolCall(call)
        if call.input["cwd"] == "/tmp/a b" && call.input["command"] == "/bin/zsh -lc \"printf '%s' \\\"a b\\\"\""));
    assert!(
        matches!(&events[1], HarnessEventPayloadV1::ToolOutput(output)
        if output.status == ToolStatus::Failed && output.output == "failure")
    );
}

#[test]
fn file_maps_preserve_add_delete_update_move_diff_and_status() {
    let body = completed(
        json!({"type":"FileChange", "id":"exec-files", "status":"failed", "changes":{
            "a":{"type":"add", "content":"new\n"},
            "b":{"type":"delete", "content":"old\n"},
            "c":{"type":"update", "unified_diff":"-old\n+new", "move_path":"d"}
        }}),
    );
    let events = tools(&parse(&body));
    let HarnessEventPayloadV1::FileChange(change) = &events[0] else {
        panic!("file event")
    };
    assert_eq!(change.status, ToolStatus::Failed);
    assert_eq!(
        change
            .changes
            .iter()
            .map(|c| (c.path.as_str(), c.kind, c.patch.as_deref()))
            .collect::<Vec<_>>(),
        vec![
            ("a", FileChangeKind::Added, Some("new\n")),
            ("b", FileChangeKind::Deleted, Some("old\n")),
            (
                "c",
                FileChangeKind::Modified,
                Some("-old\n+new\n\nMoved to: d")
            ),
        ]
    );
}

#[test]
fn failed_mcp_and_unsupported_items_follow_live_mapping() {
    let body = completed(
        json!({"type":"McpToolCall", "id":"exec-mcp", "tool":"fetch",
        "arguments":{"url":"example"}, "status":"failed", "result":null, "error":{"message":"denied"}}),
    );
    let events = tools(&parse(&body));
    assert!(
        matches!(&events[0], HarnessEventPayloadV1::ToolCall(call) if call.name == "fetch" && call.input == json!({"url":"example"}))
    );
    assert!(
        matches!(&events[1], HarnessEventPayloadV1::ToolOutput(output) if output.status == ToolStatus::Failed && output.output.is_null())
    );
    for item in [
        json!({"type":"FutureItem", "id":"future"}),
        json!({"type":"CommandExecution", "command":[]}),
        json!({"type":"CommandExecution", "id":"bad", "command":[1]}),
    ] {
        assert!(tools(&parse(&completed(item))).is_empty());
    }
}

#[test]
fn legacy_calls_patches_and_exec_json_remain_supported() {
    let body = concat!(
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"old-shell\",\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}}\n",
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"old-shell\",\"output\":\"/repo\"}}\n",
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"call_id\":\"old-patch\",\"name\":\"apply_patch\",\"input\":\"*** Begin Patch\\n*** Add File: old.rs\\n+new\\n*** End Patch\"}}\n",
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"patch_apply_end\",\"call_id\":\"old-patch\",\"success\":true,\"changes\":{\"old.rs\":{\"type\":\"add\",\"content\":\"new\"}}}}\n",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"id\":\"exec-json\",\"command\":\"ls\",\"aggregated_output\":\"old.rs\",\"exit_code\":0}}\n",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"file_change\",\"id\":\"file-json\",\"changes\":[{\"path\":\"other.rs\",\"kind\":\"update\",\"diff\":\"+new\"}]}}\n",
    );
    let events = tools(&parse(body));
    assert_eq!(events.len(), 7);
    assert!(
        matches!(&events[0], HarnessEventPayloadV1::ToolCall(call) if call.name == "Bash" && call.input == json!({"cmd":"pwd", "command":"pwd"}))
    );
    assert!(
        matches!(&events[1], HarnessEventPayloadV1::ToolOutput(output) if output.output == "/repo")
    );
    assert!(
        matches!(&events[2], HarnessEventPayloadV1::FileChange(change) if change.status == ToolStatus::Started && change.tool_call_id.as_ref().unwrap().as_str() == "old-patch")
    );
    assert!(
        matches!(&events[3], HarnessEventPayloadV1::FileChange(change) if change.status == ToolStatus::Completed)
    );
    assert!(
        matches!(&events[4], HarnessEventPayloadV1::ToolCall(call) if call.tool_call_id.as_str() == "exec-json" && call.input["command"] == "ls")
    );
    assert!(
        matches!(&events[6], HarnessEventPayloadV1::FileChange(change) if change.changes[0].path == "other.rs")
    );
}

#[test]
fn completed_items_win_over_legacy_records_in_both_orders() {
    let modern = completed(
        json!({"type":"CommandExecution", "id":"same", "command":["pwd"], "aggregated_output":"/repo", "exit_code":0}),
    );
    let legacy = concat!(
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"same\",\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}}\n",
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"same\",\"output\":\"stale\"}}\n",
    );
    let expected = tools(&parse(&modern));
    for body in [
        format!("{legacy}{modern}"),
        format!("{modern}{legacy}"),
        format!("{modern}{legacy}{modern}"),
    ] {
        assert_eq!(tools(&parse(&body)), expected);
    }
    let modern = completed(
        json!({"type":"FileChange", "id":"same", "changes":{"new.rs":{"type":"add","content":"new"}}, "status":"completed"}),
    );
    let legacy = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"patch_apply_end\",\"call_id\":\"same\",\"changes\":{\"old.rs\":{\"type\":\"add\",\"content\":\"stale\"}}}}\n";
    for body in [format!("{legacy}{modern}"), format!("{modern}{legacy}")] {
        assert_eq!(tools(&parse(&body)), tools(&parse(&modern)));
    }
}

#[test]
fn bounded_tail_and_all_page_sizes_match_full_replay() {
    use crate::CodexTranscriptReplay;
    use vertebrae_harness_core::{
        TranscriptReplayPageRequest, sequence_replay_drafts, tail_read_budget,
    };

    let home = tempdir().unwrap();
    let directory = home.path().join(".codex/sessions/2026/01/01");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("rollout-code-mode.jsonl");
    let mut body = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"code-mode\"}}\n".to_owned();
    // A real bounded tail, with old history well outside the window.
    for _ in 0..2000 {
        body.push_str(&json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":"padding".repeat(50)}}).to_string());
        body.push('\n');
    }
    body.push_str(ROLLOUT);
    // The exec wrapper is irrelevant even when it sits in the newest window.
    body.push_str("{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"name\":\"exec\",\"call_id\":\"wrapper\",\"input\":\"redacted\"}}\n");
    body.push_str("{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call_output\",\"call_id\":\"wrapper\",\"output\":\"redacted\"}}\n");
    std::fs::write(&path, &body).unwrap();
    let adapter = CodexTranscriptReplay::new(Some(home.path().to_path_buf()));
    let full = adapter.replay(&request()).unwrap().unwrap();
    let budget = tail_read_budget(2);
    let tail = read_rollout_tail(&path, &request(), budget).unwrap();
    assert!(tail.older_records_exist);
    assert!(tail.bytes_read <= budget && tail.bytes_read < body.len() / 2);
    assert_eq!(tools(&tail.drafts).len(), 5);
    let tail_events = sequence_replay_drafts(&full.projection_key, tail.drafts);
    for (actual, expected) in tail_events.iter().rev().zip(full.events.iter().rev()) {
        assert_eq!(actual, expected);
    }
    for limit in [1, 2, 3, 4, 20, 1000] {
        let mut cursor = None;
        let mut reconstructed = Vec::new();
        loop {
            let page = adapter
                .replay_page(
                    &request(),
                    &TranscriptReplayPageRequest {
                        cursor,
                        limit: Some(limit),
                    },
                )
                .unwrap()
                .unwrap();
            let mut events = page.events;
            events.extend(reconstructed);
            reconstructed = events;
            if !page.has_more {
                break;
            }
            cursor = page.next_cursor;
            assert!(cursor.is_some());
        }
        assert_eq!(reconstructed, full.events, "page size {limit}");
    }
}

#[test]
fn legacy_or_orphan_output_in_tail_defers_to_context_aware_normalization() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    let ignored = json!({"type":"ignored", "padding":"x".repeat(2000)}).to_string() + "\n";
    let helper = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"wait\",\"call_id\":\"helper\",\"arguments\":\"{}\"}}\n";
    let output = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"helper\",\"output\":\"hidden\"}}\n";
    std::fs::write(&path, format!("{helper}{ignored}{output}")).unwrap();
    let tail = read_rollout_tail(&path, &request(), 500).unwrap();
    assert!(tail.older_records_exist && tail.drafts.is_empty());
    assert!(tools(&read_rollout(&path, &request()).unwrap()).is_empty());

    let modern = completed(
        json!({"type":"CommandExecution", "id":"same", "command":["pwd"], "aggregated_output":"/repo"}),
    );
    let legacy = "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"id\":\"same\",\"command\":\"stale\",\"aggregated_output\":\"stale\"}}\n";
    std::fs::write(&path, format!("{modern}{ignored}{legacy}")).unwrap();
    let tail = read_rollout_tail(&path, &request(), 500).unwrap();
    assert!(tail.older_records_exist && tail.drafts.is_empty());
    assert_eq!(
        tools(&read_rollout(&path, &request()).unwrap()),
        tools(&parse(&modern))
    );
}

#[test]
fn pages_resolve_legacy_duplicates_and_helper_outputs_across_tail_boundary() {
    use crate::CodexTranscriptReplay;
    use vertebrae_harness_core::TranscriptReplayPageRequest;

    let home = tempdir().unwrap();
    let directory = home.path().join(".codex/sessions/2026/01/01");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("rollout-code-mode.jsonl");
    let modern = completed(
        json!({"type":"CommandExecution", "id":"same", "command":["pwd"], "aggregated_output":"/repo"}),
    );
    let legacy = "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"id\":\"same\",\"command\":\"stale\",\"aggregated_output\":\"stale\"}}\n";
    let helper = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"js\",\"call_id\":\"helper\",\"arguments\":\"{}\"}}\n";
    let output = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"helper\",\"output\":\"hidden\"}}\n";
    let padding =
        (json!({"type":"ignored", "padding":"x".repeat(2000)}).to_string() + "\n").repeat(100);
    for body in [
        format!("{modern}{padding}{legacy}"),
        format!("{legacy}{padding}{modern}"),
        format!("{helper}{modern}{padding}{output}"),
        format!("{modern}{padding}{modern}"),
    ] {
        std::fs::write(&path, body).unwrap();
        let adapter = CodexTranscriptReplay::new(Some(home.path().to_path_buf()));
        let full = adapter.replay(&request()).unwrap().unwrap();
        let mut cursor = None;
        let mut reconstructed = Vec::new();
        loop {
            let page = adapter
                .replay_page(
                    &request(),
                    &TranscriptReplayPageRequest {
                        cursor,
                        limit: Some(1),
                    },
                )
                .unwrap()
                .unwrap();
            let mut events = page.events;
            events.extend(reconstructed);
            reconstructed = events;
            if !page.has_more {
                break;
            }
            cursor = page.next_cursor;
        }
        assert_eq!(reconstructed, full.events);
        assert_eq!(tools(&read_rollout(&path, &request()).unwrap()).len(), 2);
    }
}

#[test]
fn selected_child_renders_readable_agent_prompts_without_exposing_ciphertext() {
    let header =
        json!({"type":"session_meta","payload":{"id":"code-mode","agent_path":"/root/worker"}})
            .to_string();
    let plain = json!({"type":"response_item","payload":{"type":"agent_message","author":"/root","recipient":"/root/worker","content":[{"type":"input_text","text":"Inspect the parser and report failures."}]}}).to_string();
    let encrypted = json!({"type":"response_item","payload":{"type":"agent_message","author":"/root","recipient":"/root/worker","content":[{"type":"input_text","text":"Message Type: NEW_TASK\nPayload:\n"},{"type":"encrypted_content","encrypted_content":"gAAAA_private_ciphertext"}]}}).to_string();
    let drafts = parse(&format!("{header}\n{plain}\n{encrypted}\n"));
    let prompts = drafts
        .iter()
        .filter_map(|draft| match &draft.payload {
            HarnessEventPayloadV1::TurnInput(input) => Some(input),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(prompts.len(), 2);
    assert_eq!(
        prompts[0].content,
        "Inspect the parser and report failures."
    );
    assert_eq!(prompts[0].provenance, TurnInputProvenance::Agent);
    assert!(prompts[1].content.contains("encrypted"));
    assert!(!prompts[1].content.contains("gAAAA_private_ciphertext"));
}

#[test]
fn incomplete_final_records_are_tolerated_without_a_copied_history_marker() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("child.jsonl");
    let body = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"retained\"}]}}\n{\"partial\":\"";
    let mut bytes = body.as_bytes().to_vec();
    bytes.push(0xc3);
    std::fs::write(&path, bytes).unwrap();
    let full = read_rollout(&path, &request()).unwrap();
    assert!(full.iter().any(|draft| matches!(&draft.payload, HarnessEventPayloadV1::Text(text) if text.text == "retained")));
    let tail = read_rollout_tail(
        &path,
        &request(),
        vertebrae_harness_core::tail_read_budget(10),
    )
    .unwrap();
    assert!(tail.drafts.is_empty());
    assert!(tail.older_records_exist);
}
