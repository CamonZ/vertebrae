use super::*;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::sleep;
use tungstenite::Message;

use crate::local_chat::{
    HarnessCreateSessionInput, LocalChatEvent, LocalChatEventSink, LocalChatHarness,
    LocalChatHarnessInfo, LocalChatHarnessKind, LocalChatRuntime, LocalChatSessionEndEvent,
    LocalChatSessionError, LocalChatSessionErrorEvent, LocalChatSessionInitEvent,
    LocalChatSessionUsageEvent, LocalChatSessionWarningEvent, LocalChatTextEvent,
    LocalChatToolCallEvent, LocalChatToolResultEvent,
};
use crate::types::PermissionMode;

use super::launcher::ready_probe;
use super::models::{
    codex_model_options, codex_reasoning_effort_options, parse_codex_model_catalog,
    CODEX_DEFAULT_MODEL_ID, CODEX_DEFAULT_REASONING_EFFORT,
};

fn test_thread_state() -> Arc<StdMutex<CodexThreadState>> {
    Arc::new(StdMutex::new(CodexThreadState::default()))
}

fn test_handler(event_sink: &LocalChatEventSink) -> TurnNotificationHandler {
    let mut handler = TurnNotificationHandler::new(
        "backend-1".to_string(),
        event_sink.clone(),
        test_thread_state(),
    );
    handler.set_thread("parent-thread".to_string(), "gpt-5".to_string());
    handler
}

#[derive(Clone)]
struct TestCodexAppServerLauncher {
    info_error: Option<String>,
    ws_url: String,
}

#[async_trait]
impl CodexAppServerLauncher for TestCodexAppServerLauncher {
    fn info(&self) -> LocalChatHarnessInfo {
        LocalChatHarnessInfo {
            harness: LocalChatHarnessKind::Codex,
            label: "Codex".to_string(),
            available: self.info_error.is_none(),
            unavailable_reason: self.info_error.clone(),
            default_model_id: Some(CODEX_DEFAULT_MODEL_ID.to_string()),
            models: codex_model_options(None),
            default_reasoning_effort: Some(CODEX_DEFAULT_REASONING_EFFORT.to_string()),
            reasoning_efforts: codex_reasoning_effort_options(None),
            supports_resume: true,
        }
    }

    async fn launch(&self) -> Result<LaunchedCodexAppServer, String> {
        if let Some(error) = &self.info_error {
            return Err(error.clone());
        }
        Ok(LaunchedCodexAppServer {
            ws_url: self.ws_url.clone(),
            process: None,
        })
    }
}

#[derive(Clone)]
struct MockScript {
    thread_id: &'static str,
    model: &'static str,
    rpc_error_method: Option<&'static str>,
    server_request_method: Option<&'static str>,
    stale_completion_before_turn_response: bool,
    thread_status_before_thread_response: bool,
    child_status_after_parent_completion: bool,
    turn_response_delay: Duration,
    turn_status: &'static str,
    turn_error: Option<&'static str>,
}

impl Default for MockScript {
    fn default() -> Self {
        Self {
            thread_id: "codex-thread-1",
            model: "mock-codex-model",
            rpc_error_method: None,
            server_request_method: None,
            stale_completion_before_turn_response: false,
            thread_status_before_thread_response: false,
            child_status_after_parent_completion: false,
            turn_response_delay: Duration::from_millis(0),
            turn_status: "completed",
            turn_error: None,
        }
    }
}

#[test]
fn codex_collab_tool_call_preserves_agent_outline_metadata() {
    let item = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "prompt": "Inspect the implementation",
        "model": "gpt-5-codex",
        "newAgentNickname": "Pasteur",
        "newAgentRole": "reviewer",
        "receiverThreadIds": ["thread-pasteur"],
        "receiverAgents": [
            {
                "threadId": "thread-pasteur",
                "agentNickname": "Pasteur",
                "agentRole": "reviewer"
            }
        ],
        "agentStatuses": [
            {
                "threadId": "thread-pasteur",
                "agentNickname": "Pasteur",
                "status": "running"
            }
        ],
        "agentsStates": {
            "thread-pasteur": {
                "status": "running"
            }
        }
    });

    let (tool_id, tool_name, input) = codex_tool_call(&item).expect("tool call");
    let input: Value = serde_json::from_str(&input).expect("json input");

    // The spawn's tool_id is now derived from the agent identity
    // (`agent:{agent_path}`), not the raw item id, so it matches what
    // rollout hydration synthesizes for the same spawn (see
    // `collab_agent_spawn_id`).
    assert_eq!(tool_id, "agent:thread-pasteur");
    assert_eq!(tool_name, "Agent");
    assert_eq!(input["description"], "Inspect the implementation");
    assert_eq!(input["collab_tool"], "spawnAgent");
    assert_eq!(input["subagent_type"], "gpt-5-codex");
    assert_eq!(input["agent_nickname"], "Pasteur");
    assert_eq!(input["agent_role"], "reviewer");
    assert_eq!(input["receiver_thread_ids"][0], "thread-pasteur");
    assert_eq!(input["receiver_agents"][0]["agentNickname"], "Pasteur");
    assert_eq!(input["agent_statuses"][0]["agentNickname"], "Pasteur");
    assert_eq!(
        input["agents_states"]["thread-pasteur"]["status"],
        "running"
    );
}

#[test]
fn codex_collab_tool_call_extracts_agent_nickname_from_spawn_result() {
    let item = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "prompt": "Inspect the implementation",
        "model": "gpt-5-codex",
        "result": {
            "agent_id": "019f1cae-6a6c-71f0-a082-9a2dbd0d074f",
            "nickname": "Faraday",
            "role": "explorer"
        }
    });

    let (_tool_id, _tool_name, input) = codex_tool_call(&item).expect("tool call");
    let input: Value = serde_json::from_str(&input).expect("json input");

    assert_eq!(input["agent_nickname"], "Faraday");
    assert_eq!(input["agent_role"], "explorer");
    assert_eq!(
        input["receiver_thread_ids"][0],
        "019f1cae-6a6c-71f0-a082-9a2dbd0d074f"
    );
    assert_eq!(input["receiver_agents"][0]["agentNickname"], "Faraday");
    assert_eq!(
        input["receiver_agents"][0]["threadId"],
        "019f1cae-6a6c-71f0-a082-9a2dbd0d074f"
    );
}

#[test]
fn codex_collab_tool_call_derives_spawn_id_from_result_agent_id() {
    let item = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "result": {
            "agent_id": "019f1cae-6a6c-71f0-a082-9a2dbd0d074f",
            "nickname": "Faraday"
        }
    });

    let (tool_id, _tool_name, _input) = codex_tool_call(&item).expect("tool call");
    assert_eq!(tool_id, "agent:019f1cae-6a6c-71f0-a082-9a2dbd0d074f");
}

#[test]
fn codex_collab_tool_call_falls_back_to_item_id_when_agent_identity_unresolvable() {
    // Mirrors a bare `item/started` for `spawnAgent`, before the
    // app-server has attached `receiverThreadIds`/`result` to the item.
    let item = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "prompt": "Inspect the implementation"
    });

    let (tool_id, _tool_name, _input) = codex_tool_call(&item).expect("tool call");
    assert_eq!(tool_id, "spawn-1");
}

#[test]
fn codex_collab_tool_call_non_spawn_keeps_item_id() {
    // wait_agent/close_agent are their own tool cards; they must not
    // collide with the spawn's derived `agent:{agent_path}` id even
    // though they carry the same agent identity.
    let item = json!({
        "type": "collabAgentToolCall",
        "id": "wait-1",
        "tool": "wait_agent",
        "receiverThreadIds": ["child-thread"]
    });

    let (tool_id, tool_name, _input) = codex_tool_call(&item).expect("tool call");
    assert_eq!(tool_id, "wait-1");
    assert_eq!(tool_name, "agent");
}

#[test]
fn codex_collab_spawn_tool_call_and_tool_result_share_the_same_derived_id() {
    // The same completed item feeds both `codex_tool_call` (re-emitted
    // on item/completed) and `codex_tool_result`; if either used a
    // different id derivation the ToolResult would never reconcile with
    // its ToolCall in the GUI.
    let item = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "status": "completed",
        "receiverThreadIds": ["thread-pasteur"]
    });

    let (call_tool_id, _, _) = codex_tool_call(&item).expect("tool call");
    let (result_tool_id, _, _) = codex_tool_result(&item).expect("tool result");
    assert_eq!(call_tool_id, "agent:thread-pasteur");
    assert_eq!(result_tool_id, call_tool_id);
}

#[test]
fn codex_todo_list_item_maps_to_tool_call_and_result() {
    let item = json!({
        "type": "todoList",
        "id": "plan-1",
        "items": [
            { "text": "step a", "completed": true },
            { "text": "step b", "completed": false }
        ]
    });

    let (tool_id, tool_name, input) = codex_tool_call(&item).expect("tool call");
    let input: Value = serde_json::from_str(&input).expect("json input");
    assert_eq!(tool_id, "plan-1");
    assert_eq!(tool_name, "TodoWrite");
    assert_eq!(input["todos"][0]["text"], "step a");
    assert_eq!(input["todos"][1]["completed"], false);

    let (result_tool_id, result, is_error) = codex_tool_result(&item).expect("tool result");
    assert_eq!(result_tool_id, "plan-1");
    assert_eq!(result, "1/2 steps completed");
    assert!(!is_error);
}

#[test]
fn codex_todo_list_item_snake_case_alias_is_also_recognized() {
    // Defensive alias: the exact wire casing for this item hasn't been
    // confirmed against a live app-server, so both spellings are
    // accepted (see the comment on the `codex_tool_call` match arm).
    let item = json!({
        "type": "todo_list",
        "id": "plan-2",
        "items": []
    });

    let (tool_id, tool_name, _input) = codex_tool_call(&item).expect("tool call");
    assert_eq!(tool_id, "plan-2");
    assert_eq!(tool_name, "TodoWrite");
}

#[test]
fn codex_wait_agent_does_not_reparent_child_thread_from_original_spawn() {
    let event_sink = LocalChatEventSink::inert_for_tests();
    let mut handler = test_handler(&event_sink);
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "receiverThreadIds": ["child-thread"]
    });
    let wait = json!({
        "type": "collabAgentToolCall",
        "id": "wait-1",
        "tool": "wait_agent",
        "receiverThreadIds": ["child-thread"]
    });

    handler.remember_child_thread_parents(&spawn, "spawn-1");
    handler.remember_child_thread_parents(&wait, "wait-1");

    assert_eq!(
        handler
            .thread_state
            .lock()
            .expect("thread state lock")
            .child_thread_parents
            .get("child-thread")
            .map(String::as_str),
        Some("spawn-1")
    );
}

#[test]
fn codex_child_notifications_resolve_parent_from_agent_identity_aliases() {
    let event_sink = LocalChatEventSink::inert_for_tests();
    let mut handler = test_handler(&event_sink);
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "result": {
            "agent_id": "agent-20513969",
            "nickname": "Leibniz"
        }
    });
    let notification = json!({
        "threadId": "different-child-thread",
        "item": {
            "type": "commandExecution",
            "id": "tool-1",
            "agentId": "agent-20513969"
        }
    });

    handler.remember_child_thread_parents(&spawn, "spawn-1");

    assert_eq!(
        handler
            .parent_tool_use_id_for_notification(&notification)
            .as_deref(),
        Some("spawn-1")
    );
}

#[test]
fn codex_child_tool_call_is_not_emitted_into_parent_transcript() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "result": {
            "agent_id": "agent-20513969",
            "nickname": "Leibniz"
        }
    });
    handler.remember_child_thread_parents(&spawn, "spawn-1");

    handler.handle(
        "item/started",
        &json!({
            "threadId": "child-thread-from-server",
            "item": {
                "type": "commandExecution",
                "id": "tool-1",
                "command": "rg --files crates/core",
                "agentId": "agent-20513969"
            }
        }),
    );

    let events = events.lock().expect("events lock");
    assert!(events.is_empty());
}

#[test]
fn codex_parent_thread_notifications_are_not_reclassified_as_child_agent_output() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "threadId": "parent-thread",
        "receiverThreadIds": ["child-thread"]
    });
    handler.remember_child_thread_parents(&spawn, "spawn-1");

    let (completion_tx, _completion_rx) = tokio::sync::oneshot::channel();
    handler.begin_turn(1, completion_tx);
    handler.set_expected_turn_id("turn-1");

    handler.handle(
        "item/agentMessage/delta",
        &json!({
            "threadId": "parent-thread",
            "turnId": "turn-1",
            "itemId": "msg-1",
            "delta": "streamed parent reply"
        }),
    );
    handler.handle(
        "item/completed",
        &json!({
            "threadId": "parent-thread",
            "turnId": "turn-1",
            "item": {
                "type": "agentMessage",
                "id": "msg-1",
                "text": "Final parent reply"
            }
        }),
    );
    handler.handle(
        "turn/completed",
        &json!({
            "threadId": "parent-thread",
            "turn": {
                "id": "turn-1",
                "status": "completed",
                "durationMs": 12
            }
        }),
    );

    assert!(handler.active_turn.is_none());
    let events = events.lock().expect("events lock");
    let text_events: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            LocalChatEvent::Text(event) => Some(event),
            _ => None,
        })
        .collect();
    assert_eq!(text_events.len(), 2);
    assert_eq!(text_events[0].text, "streamed parent reply");
    assert!(text_events[0].is_partial);
    assert_eq!(text_events[0].parent_tool_use_id, None);
    assert_eq!(text_events[1].text, "Final parent reply");
    assert!(!text_events[1].is_partial);
    assert_eq!(text_events[1].parent_tool_use_id, None);
    assert!(events
        .iter()
        .any(|event| matches!(event, LocalChatEvent::End(_))));
}

#[test]
fn codex_child_notification_arriving_before_parent_registers_gets_synthetic_parent() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);

    // The child thread's own activity arrives first -- the parent
    // collabAgentToolCall spawn hasn't registered `child_thread_parents`
    // yet. Previously this notification was silently dropped forever.
    handler.handle(
        "item/started",
        &json!({
            "threadId": "child-thread-from-server",
            "item": {
                "type": "commandExecution",
                "id": "tool-1",
                "command": "rg --files crates/core",
                "agentId": "agent-race"
            }
        }),
    );

    let events = events.lock().expect("events lock");
    let synthetic_spawn = events.iter().find_map(|event| match event {
        LocalChatEvent::ToolCall(event) if event.tool_name == "Agent" => Some(event),
        _ => None,
    });
    let synthetic_spawn = synthetic_spawn.expect("synthetic spawn parent");
    assert_eq!(synthetic_spawn.tool_id, "agent:agent-race");
    assert_eq!(synthetic_spawn.parent_tool_use_id, None);

    assert!(!events.iter().any(|event| matches!(
        event,
        LocalChatEvent::ToolCall(LocalChatToolCallEvent { tool_name, .. })
            if tool_name == "Bash"
    )));
}

#[test]
fn codex_child_thread_parent_mapping_survives_across_turn_handlers() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let thread_state = test_thread_state();
    let mut first_turn = TurnNotificationHandler::new(
        "backend-1".to_string(),
        event_sink.clone(),
        thread_state.clone(),
    );
    first_turn.set_thread("parent-thread".to_string(), "gpt-5".to_string());
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "receiverThreadIds": ["child-thread"]
    });
    first_turn.remember_child_thread_parents(&spawn, "agent:child-thread");
    drop(first_turn);

    let mut next_turn =
        TurnNotificationHandler::new("backend-1".to_string(), event_sink.clone(), thread_state);
    next_turn.set_thread("parent-thread".to_string(), "gpt-5".to_string());
    next_turn.handle(
        "item/started",
        &json!({
            "threadId": "child-thread",
            "item": {
                "type": "commandExecution",
                "id": "tool-1",
                "command": "pwd"
            }
        }),
    );

    assert_eq!(
        next_turn
            .parent_tool_use_id_for_notification(&json!({ "threadId": "child-thread" }))
            .as_deref(),
        Some("agent:child-thread")
    );
    assert!(events.lock().expect("events lock").is_empty());
}

#[test]
fn codex_unresolved_spawn_started_waits_for_stable_completed_id() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);
    handler.set_expected_turn_id("turn-1");

    handler.handle(
        "item/started",
        &json!({
            "threadId": "parent-thread",
            "turnId": "turn-1",
            "item": {
                "type": "collabAgentToolCall",
                "id": "spawn-1",
                "tool": "spawnAgent",
                "prompt": "Inspect the implementation"
            }
        }),
    );
    assert!(events.lock().expect("events lock").is_empty());

    handler.handle(
        "item/completed",
        &json!({
            "threadId": "parent-thread",
            "turnId": "turn-1",
            "item": {
                "type": "collabAgentToolCall",
                "id": "spawn-1",
                "tool": "spawnAgent",
                "prompt": "Inspect the implementation",
                "receiverThreadIds": ["child-thread"],
                "status": "completed"
            }
        }),
    );

    let events = events.lock().expect("events lock");
    let agent_calls: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            LocalChatEvent::ToolCall(event) if event.tool_name == "Agent" => Some(event),
            _ => None,
        })
        .collect();
    assert_eq!(agent_calls.len(), 1);
    assert_eq!(agent_calls[0].tool_id, "agent:child-thread");
}

#[test]
fn codex_child_turn_completed_updates_agent_status_without_ending_parent() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "receiverThreadIds": ["child-thread"]
    });
    handler.remember_child_thread_parents(&spawn, "spawn-1");

    handler.handle(
        "turn/completed",
        &json!({
            "threadId": "child-thread",
            "turn": {
                "id": "child-turn",
                "status": "completed",
                "durationMs": 145489
            }
        }),
    );

    assert!(handler.active_turn.is_none());
    let events = events.lock().expect("events lock");
    assert!(!events
        .iter()
        .any(|event| matches!(event, LocalChatEvent::End(_))));
    let tool_call = events.iter().find_map(|event| match event {
        LocalChatEvent::ToolCall(event) => Some(event),
        _ => None,
    });
    let tool_call = tool_call.expect("status update tool call");
    let input: Value = serde_json::from_str(&tool_call.input).expect("json input");
    assert_eq!(tool_call.tool_id, "spawn-1");
    assert_eq!(tool_call.parent_tool_use_id, None);
    assert_eq!(
        input["agents_states"]["child-thread"]["status"],
        "completed"
    );
    let parent_result = events.iter().find_map(|event| match event {
        LocalChatEvent::ToolResult(event) if event.tool_id == "spawn-1" => Some(event),
        _ => None,
    });
    let parent_result = parent_result.expect("parent spawn completion result");
    assert_eq!(parent_result.result, "completed");
    assert!(!parent_result.is_error);
    assert_eq!(parent_result.parent_tool_use_id, None);
}

#[test]
fn codex_parent_agent_completion_waits_for_all_spawned_children() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "receiverThreadIds": ["child-one", "child-two"]
    });
    handler.remember_child_thread_parents(&spawn, "spawn-1");

    handler.handle(
        "turn/completed",
        &json!({
            "threadId": "child-one",
            "turn": {
                "id": "child-turn-one",
                "status": "completed"
            }
        }),
    );
    {
        let events = events.lock().expect("events lock");
        assert!(!events.iter().any(|event| matches!(
            event,
            LocalChatEvent::ToolResult(LocalChatToolResultEvent { tool_id, .. })
                if tool_id == "spawn-1"
        )));
    }

    handler.handle(
        "turn/completed",
        &json!({
            "threadId": "child-two",
            "turn": {
                "id": "child-turn-two",
                "status": "completed"
            }
        }),
    );

    let events = events.lock().expect("events lock");
    let parent_results: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            LocalChatEvent::ToolResult(event) if event.tool_id == "spawn-1" => Some(event),
            _ => None,
        })
        .collect();
    assert_eq!(parent_results.len(), 1);
    assert_eq!(parent_results[0].result, "completed");
    assert!(!parent_results[0].is_error);
}

#[test]
fn codex_child_thread_status_changed_updates_agent_state_from_protocol_shape() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "receiverThreadIds": ["child-thread"]
    });
    handler.remember_child_thread_parents(&spawn, "agent:child-thread");

    handler.handle(
        "thread/status/changed",
        &json!({
            "threadId": "child-thread",
            "status": {
                "type": "active",
                "activeFlags": []
            }
        }),
    );

    let events = events.lock().expect("events lock");
    let tool_call = events.iter().find_map(|event| match event {
        LocalChatEvent::ToolCall(event) => Some(event),
        _ => None,
    });
    let tool_call = tool_call.expect("status update tool call");
    let input: Value = serde_json::from_str(&tool_call.input).expect("json input");
    assert_eq!(tool_call.tool_id, "agent:child-thread");
    assert_eq!(input["agents_states"]["child-thread"]["status"], "running");
}

#[test]
fn codex_child_turn_completed_emits_final_agent_result_without_child_transcript() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);
    let spawn = json!({
        "type": "collabAgentToolCall",
        "id": "spawn-1",
        "tool": "spawnAgent",
        "receiverThreadIds": ["child-thread"]
    });
    handler.remember_child_thread_parents(&spawn, "agent:child-thread");

    handler.handle(
        "item/agentMessage/delta",
        &json!({
            "threadId": "child-thread",
            "turnId": "child-turn",
            "itemId": "child-msg",
            "delta": "streamed child work"
        }),
    );
    handler.handle(
        "item/completed",
        &json!({
            "threadId": "child-thread",
            "turnId": "child-turn",
            "item": {
                "type": "agentMessage",
                "id": "child-msg",
                "text": "Final child report"
            }
        }),
    );
    handler.handle(
        "turn/completed",
        &json!({
            "threadId": "child-thread",
            "turn": {
                "id": "child-turn",
                "status": "completed",
                "durationMs": 25
            }
        }),
    );

    let events = events.lock().expect("events lock");
    assert!(!events
        .iter()
        .any(|event| matches!(event, LocalChatEvent::Text(_))));
    let result_call = events.iter().find_map(|event| match event {
        LocalChatEvent::ToolCall(event) if event.tool_name == "Agent Result" => Some(event),
        _ => None,
    });
    let result_call = result_call.expect("agent result tool call");
    assert_eq!(result_call.tool_id, "agent:child-thread:result:child-turn");
    assert_eq!(result_call.parent_tool_use_id, None);
    let result = events.iter().find_map(|event| match event {
        LocalChatEvent::ToolResult(event)
            if event.tool_id == "agent:child-thread:result:child-turn" =>
        {
            Some(event)
        }
        _ => None,
    });
    let result = result.expect("agent result tool result");
    assert_eq!(result.result, "Final child report");
    assert!(!result.is_error);
    assert_eq!(result.parent_tool_use_id, None);
}

#[test]
fn codex_agent_message_completed_emits_final_text_event() {
    let (event_sink, events) = LocalChatEventSink::capturing_for_tests();
    let mut handler = test_handler(&event_sink);
    handler.set_expected_turn_id("turn-1");

    handler.handle(
        "item/completed",
        &json!({
            "threadId": "parent-thread",
            "turnId": "turn-1",
            "item": {
                "type": "agentMessage",
                "id": "msg-1",
                "text": "Final text",
                "phase": "commentary"
            }
        }),
    );

    let events = events.lock().expect("events lock");
    let text = events.iter().find_map(|event| match event {
        LocalChatEvent::Text(event) => Some(event),
        _ => None,
    });
    let text = text.expect("final text event");
    assert_eq!(text.text, "Final text");
    assert!(!text.is_partial);
    assert_eq!(text.parent_tool_use_id, None);
}

struct MockAppServer {
    ws_url: String,
    requests: Arc<std::sync::Mutex<Vec<Value>>>,
    closed: Arc<std::sync::Mutex<bool>>,
}

impl MockAppServer {
    async fn start(script: MockScript) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock app-server");
        let ws_url = format!("ws://{}", listener.local_addr().expect("mock addr"));
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let closed = Arc::new(std::sync::Mutex::new(false));
        let server_requests = requests.clone();
        let server_closed = closed.clone();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept websocket");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept websocket handshake");

            while let Some(frame) = socket.next().await {
                let frame = frame.expect("mock websocket frame");
                let Message::Text(text) = frame else {
                    if matches!(frame, Message::Close(_)) {
                        break;
                    }
                    continue;
                };
                let request: Value = serde_json::from_str(&text).expect("request json");
                server_requests
                    .lock()
                    .expect("requests lock")
                    .push(request.clone());

                let Some(method) = request.get("method").and_then(Value::as_str) else {
                    continue;
                };
                let id = request.get("id").cloned();

                if script.rpc_error_method == Some(method) {
                    send_json(
                        &mut socket,
                        json!({
                            "id": id,
                            "error": {
                                "code": -32000,
                                "message": format!("{method} exploded"),
                            },
                        }),
                    )
                    .await;
                    continue;
                }

                match (method, id) {
                    ("initialize", Some(id)) => {
                        send_json(
                            &mut socket,
                            json!({
                                "id": id,
                                "result": {
                                    "userAgent": "mock",
                                    "codexHome": "/tmp/codex",
                                    "platformFamily": "unix",
                                    "platformOs": "macos",
                                },
                            }),
                        )
                        .await;
                        if script.child_status_after_parent_completion {
                            sleep(Duration::from_millis(25)).await;
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "thread/status/changed",
                                    "params": {
                                        "threadId": "child-thread",
                                        "status": {
                                            "type": "idle",
                                        },
                                    },
                                }),
                            )
                            .await;
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "turn/completed",
                                    "params": {
                                        "threadId": "child-thread",
                                        "turn": {
                                            "id": "child-turn-1",
                                            "status": "completed",
                                            "durationMs": 5,
                                            "error": null,
                                        },
                                    },
                                }),
                            )
                            .await;
                        }
                    }
                    ("initialized", _) => {}
                    ("thread/start" | "thread/resume", Some(id)) => {
                        if script.thread_status_before_thread_response {
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "thread/status/changed",
                                    "params": {
                                        "threadId": script.thread_id,
                                        "status": {
                                            "type": "pendingInit",
                                        },
                                    },
                                }),
                            )
                            .await;
                        }
                        send_json(
                            &mut socket,
                            json!({
                                "id": id,
                                "result": {
                                    "thread": { "id": script.thread_id },
                                    "model": script.model,
                                    "modelProvider": "openai",
                                    "cwd": "/tmp/project",
                                },
                            }),
                        )
                        .await;
                        send_json(
                            &mut socket,
                            json!({
                                "method": "thread/started",
                                "params": {
                                    "thread": { "id": script.thread_id },
                                },
                            }),
                        )
                        .await;
                    }
                    ("turn/start", Some(id)) => {
                        if script.stale_completion_before_turn_response {
                            send_json(
                                &mut socket,
                                json!({
                                    "method": "turn/completed",
                                    "params": {
                                        "threadId": script.thread_id,
                                        "turn": {
                                            "id": "stale-turn",
                                            "status": "completed",
                                            "durationMs": 1,
                                            "error": null,
                                        },
                                    },
                                }),
                            )
                            .await;
                        }
                        if script.turn_response_delay > Duration::from_millis(0) {
                            sleep(script.turn_response_delay).await;
                        }
                        send_json(
                            &mut socket,
                            json!({
                                "id": id,
                                "result": {
                                    "turn": {
                                        "id": "turn-1",
                                        "status": "inProgress",
                                        "items": [],
                                        "error": null,
                                    },
                                },
                            }),
                        )
                        .await;
                        if let Some(method) = script.server_request_method {
                            send_json(
                                &mut socket,
                                json!({
                                    "id": 1000,
                                    "method": method,
                                    "params": {
                                        "threadId": script.thread_id,
                                        "turnId": "turn-1",
                                        "itemId": "item-approval-1",
                                        "startedAtMs": 1,
                                    },
                                }),
                            )
                            .await;
                        }
                        send_json(
                            &mut socket,
                            json!({
                                "method": "item/agentMessage/delta",
                                "params": {
                                    "threadId": script.thread_id,
                                    "turnId": "turn-1",
                                    "itemId": "item-1",
                                    "delta": "hello ",
                                },
                            }),
                        )
                        .await;
                        send_json(
                            &mut socket,
                            json!({
                                "method": "item/agentMessage/delta",
                                "params": {
                                    "threadId": script.thread_id,
                                    "turnId": "turn-1",
                                    "itemId": "item-1",
                                    "delta": "world",
                                },
                            }),
                        )
                        .await;
                        send_json(
                            &mut socket,
                            json!({
                                "method": "thread/tokenUsage/updated",
                                "params": {
                                    "threadId": script.thread_id,
                                    "turnId": "turn-1",
                                    "tokenUsage": {
                                        "total": {
                                            "totalTokens": 42,
                                            "inputTokens": 30,
                                            "cachedInputTokens": 0,
                                            "outputTokens": 12,
                                            "reasoningOutputTokens": 0,
                                        },
                                        "last": {
                                            "totalTokens": 42,
                                            "inputTokens": 30,
                                            "cachedInputTokens": 0,
                                            "outputTokens": 12,
                                            "reasoningOutputTokens": 0,
                                        },
                                        "modelContextWindow": 200000,
                                    },
                                },
                            }),
                        )
                        .await;
                        send_json(
                                &mut socket,
                                json!({
                                    "method": "turn/completed",
                                    "params": {
                                        "threadId": script.thread_id,
                                        "turn": {
                                            "id": "turn-1",
                                            "status": script.turn_status,
                                            "durationMs": 17,
                                            "error": script.turn_error.map(|message| json!({ "message": message })),
                                        },
                                    },
                                }),
                            )
                            .await;
                    }
                    _ => {}
                }
            }

            *server_closed.lock().expect("closed lock") = true;
        });

        Self {
            ws_url,
            requests,
            closed,
        }
    }

    fn launcher(&self) -> Arc<dyn CodexAppServerLauncher> {
        Arc::new(TestCodexAppServerLauncher {
            info_error: None,
            ws_url: self.ws_url.clone(),
        })
    }

    fn requests(&self) -> Vec<Value> {
        self.requests.lock().expect("requests lock").clone()
    }

    async fn wait_for_request_count(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while self.requests().len() < count {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("mock server should receive expected requests");
    }

    fn closed(&self) -> bool {
        *self.closed.lock().expect("closed lock")
    }
}

async fn wait_for_event<F>(events: &Arc<std::sync::Mutex<Vec<LocalChatEvent>>>, predicate: F)
where
    F: Fn(&LocalChatEvent) -> bool,
{
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            {
                let events = events.lock().expect("events lock");
                if events.iter().any(&predicate) {
                    break;
                }
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("expected local chat event");
}

async fn send_json(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    value: Value,
) {
    socket
        .send(Message::Text(value.to_string()))
        .await
        .expect("send mock frame");
}

fn create_input(
    backend_session_id: &str,
    initial_prompt: Option<&str>,
    provider_resume_id: Option<&str>,
) -> HarnessCreateSessionInput {
    HarnessCreateSessionInput {
        backend_session_id: backend_session_id.to_string(),
        working_dir: Some("/tmp/project".to_string()),
        initial_prompt: initial_prompt.map(str::to_string),
        provider_resume_id: provider_resume_id.map(str::to_string),
        model_id: Some(CODEX_DEFAULT_MODEL_ID.to_string()),
        reasoning_effort: Some(CODEX_DEFAULT_REASONING_EFFORT.to_string()),
        permission_mode: None,
    }
}

#[test]
fn codex_harness_info_reports_default_model_metadata() {
    let harness =
        CodexLocalChatHarness::with_launcher_for_tests(Arc::new(TestCodexAppServerLauncher {
            info_error: Some("codex missing".to_string()),
            ws_url: "ws://127.0.0.1:1".to_string(),
        }));

    let info = harness.info();

    assert_eq!(info.harness, LocalChatHarnessKind::Codex);
    assert_eq!(info.label, "Codex");
    assert!(!info.available);
    assert_eq!(info.unavailable_reason, Some("codex missing".to_string()));
    assert_eq!(info.default_model_id, Some("default".to_string()));
    assert!(info.models.iter().any(|model| model.id == "gpt-5.5"));
    assert!(info.models.iter().any(|model| model.id == "gpt-5.4"));
    assert_eq!(info.default_reasoning_effort, Some("default".to_string()));
    assert!(info
        .reasoning_efforts
        .iter()
        .any(|effort| effort.id == "xhigh"));
    assert!(info.supports_resume);
}

#[test]
fn codex_catalog_options_keep_default_and_order_visible_models_by_priority() {
    let catalog = parse_codex_model_catalog(
        r#"{
            "models": [
                {
                    "slug": "later-model",
                    "display_name": "Later model",
                    "visibility": "list",
                    "priority": 20,
                    "supported_reasoning_levels": [
                        {"effort": "high"},
                        {"effort": "medium"}
                    ]
                },
                {
                    "slug": "first-model",
                    "display_name": "First model",
                    "visibility": "list",
                    "priority": 1,
                    "supported_reasoning_levels": [
                        {"effort": "medium"},
                        {"effort": "max"},
                        {"effort": "ultra"}
                    ]
                },
                {
                    "slug": "hidden-model",
                    "display_name": "Hidden model",
                    "visibility": "hidden",
                    "priority": 0,
                    "supported_reasoning_levels": [{"effort": "low"}]
                }
            ]
        }"#,
    )
    .expect("valid Codex catalog");

    let models = codex_model_options(Some(&catalog));
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["default", "first-model", "later-model"]
    );
    assert_eq!(
        models
            .iter()
            .find(|model| model.id == "first-model")
            .and_then(|model| model.supported_reasoning_effort_ids.as_ref())
            .map(|efforts| efforts.iter().map(String::as_str).collect::<Vec<_>>()),
        Some(vec!["medium", "max", "ultra"])
    );
    assert_eq!(
        models
            .iter()
            .find(|model| model.id == "later-model")
            .and_then(|model| model.supported_reasoning_effort_ids.as_ref())
            .map(|efforts| efforts.iter().map(String::as_str).collect::<Vec<_>>()),
        Some(vec!["high", "medium"])
    );

    let efforts = codex_reasoning_effort_options(Some(&catalog));
    assert_eq!(
        efforts
            .iter()
            .map(|effort| effort.id.as_str())
            .collect::<Vec<_>>(),
        vec!["medium", "max", "ultra", "high"]
    );
}

#[test]
fn malformed_or_failed_codex_catalog_uses_static_picker_fallback() {
    assert!(parse_codex_model_catalog("not JSON").is_err());
    assert!(super::launcher::load_catalog_output(|| Err("Codex failed".to_string())).is_err());

    assert!(codex_model_options(None)
        .iter()
        .any(|model| model.id == "gpt-5.5"));
    assert_eq!(
        codex_reasoning_effort_options(None)
            .iter()
            .map(|effort| effort.id.as_str())
            .collect::<Vec<_>>(),
        vec!["low", "medium", "high", "xhigh"]
    );
}

#[test]
fn codex_error_message_reads_common_error_payload_shapes() {
    assert_eq!(
        codex_error_message(&json!({ "message": "plain failure" })),
        Some("plain failure".to_string())
    );
    assert_eq!(
        codex_error_message(&json!({ "error": { "message": "nested failure" } })),
        Some("nested failure".to_string())
    );
    assert_eq!(
        codex_error_message(&json!({
            "type": "error",
            "status": 400,
            "error": {
                "type": "invalid_request_error",
                "message": "The model is not supported.",
            }
        })),
        Some("The model is not supported.".to_string())
    );
    assert_eq!(
        codex_error_message(&json!({ "turn": { "error": { "message": "turn failure" } } })),
        Some("turn failure".to_string())
    );
    assert_eq!(
        codex_error_message(&json!({ "error": { "code": "bad_model" } })),
        Some(json!({ "code": "bad_model" }).to_string())
    );
}

#[tokio::test]
async fn create_session_initializes_starts_thread_and_emits_initial_turn_events() {
    let server = MockAppServer::start(MockScript::default()).await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(
            create_input("backend-1", Some("first prompt"), None),
            runtime,
        )
        .await
        .expect("create codex session");

    assert!(harness.has_session("backend-1").await);
    server.wait_for_request_count(4).await;
    wait_for_event(&events, |event| {
        matches!(
            event,
            LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id,
                ..
            }) if backend_session_id == "backend-1"
        )
    })
    .await;

    let requests = server.requests();
    assert_eq!(requests[0]["method"], "initialize");
    assert_eq!(requests[1]["method"], "initialized");
    assert_eq!(requests[2]["method"], "thread/start");
    assert_eq!(requests[2]["params"]["cwd"], "/tmp/project");
    assert!(requests[2]["params"].get("model").is_none());
    assert!(requests[2]["params"].get("effort").is_none());
    assert_eq!(requests[3]["method"], "turn/start");
    assert_eq!(requests[3]["params"]["threadId"], "codex-thread-1");
    assert_eq!(requests[3]["params"]["input"][0]["text"], "first prompt");

    let events = events.lock().expect("events lock").clone();
    assert!(
        events.contains(&LocalChatEvent::Init(LocalChatSessionInitEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Codex,
            provider_resume_id: Some("codex-thread-1".to_string()),
            model: "mock-codex-model".to_string(),
            tools: Vec::new(),
        }))
    );
    assert!(events.contains(&LocalChatEvent::Text(LocalChatTextEvent {
        backend_session_id: "backend-1".to_string(),
        harness: LocalChatHarnessKind::Codex,
        text: "hello ".to_string(),
        is_partial: true,
        parent_tool_use_id: None,
    })));
    assert!(
        events.contains(&LocalChatEvent::Usage(LocalChatSessionUsageEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Codex,
            model: "mock-codex-model".to_string(),
            context_tokens: 42,
            context_window: 200000,
        }))
    );
    assert!(
        events.contains(&LocalChatEvent::End(LocalChatSessionEndEvent {
            backend_session_id: "backend-1".to_string(),
            harness: LocalChatHarnessKind::Codex,
            duration_ms: 17,
            cost_usd: 0.0,
            num_turns: 1,
            result: "hello world".to_string(),
            is_error: false,
            context_tokens: 42,
            context_window: 200000,
        }))
    );
    assert!(!events.iter().any(|event| matches!(
        event,
        LocalChatEvent::ToolCall(LocalChatToolCallEvent { tool_id, .. })
            if tool_id == "agent:codex-thread-1"
    )));
}

#[tokio::test]
async fn create_session_registers_before_initial_turn_finishes() {
    let server = MockAppServer::start(MockScript {
        turn_response_delay: Duration::from_millis(250),
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    tokio::time::timeout(
        Duration::from_millis(100),
        harness.create_session(
            create_input("backend-async-start", Some("slow prompt"), None),
            runtime,
        ),
    )
    .await
    .expect("create_session should not wait for the initial turn")
    .expect("create codex session");

    assert!(harness.has_session("backend-async-start").await);
    server.wait_for_request_count(4).await;
    wait_for_event(&events, |event| {
        matches!(
            event,
            LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id,
                ..
            }) if backend_session_id == "backend-async-start"
        )
    })
    .await;
}

#[tokio::test]
async fn send_message_returns_before_turn_finishes() {
    let server = MockAppServer::start(MockScript {
        turn_response_delay: Duration::from_millis(250),
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(create_input("backend-async-send", None, None), runtime)
        .await
        .expect("create codex session");

    tokio::time::timeout(
        Duration::from_millis(100),
        harness.send_message("backend-async-send", "slow prompt"),
    )
    .await
    .expect("send_message should not wait for the turn to finish")
    .expect("send codex message");

    server.wait_for_request_count(4).await;
    wait_for_event(&events, |event| {
        matches!(
            event,
            LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id,
                ..
            }) if backend_session_id == "backend-async-send"
        )
    })
    .await;
}

#[tokio::test]
async fn send_message_returns_session_not_found_without_spawning_turn() {
    let harness =
        CodexLocalChatHarness::with_launcher_for_tests(Arc::new(TestCodexAppServerLauncher {
            info_error: None,
            ws_url: "ws://127.0.0.1:1".to_string(),
        }));

    let result = harness.send_message("missing-session", "hello").await;

    assert_eq!(
        result,
        Err(LocalChatSessionError::SessionNotFound(
            "missing-session".to_string()
        ))
    );
}

#[tokio::test]
async fn permission_mode_is_forwarded_to_thread_and_turn_requests() {
    let server = MockAppServer::start(MockScript::default()).await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, _events) = LocalChatRuntime::capturing_for_tests();
    let mut input = create_input("backend-permissions", None, None);
    input.permission_mode = Some(PermissionMode::Plan);

    harness
        .create_session(input, runtime)
        .await
        .expect("create codex session");
    harness
        .send_message("backend-permissions", "plan this")
        .await
        .expect("send codex message");
    server.wait_for_request_count(4).await;

    let requests = server.requests();
    assert_eq!(requests[2]["method"], "thread/start");
    assert_eq!(requests[2]["params"]["approvalPolicy"], "never");
    assert_eq!(requests[2]["params"]["permissions"], ":read-only");
    assert_eq!(requests[3]["method"], "turn/start");
    assert_eq!(requests[3]["params"]["approvalPolicy"], "never");
    assert_eq!(requests[3]["params"]["permissions"], ":read-only");
}

#[tokio::test]
async fn selected_model_and_reasoning_effort_are_forwarded_to_thread_start() {
    let server = MockAppServer::start(MockScript::default()).await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, _events) = LocalChatRuntime::capturing_for_tests();
    let mut input = create_input("backend-model-effort", None, None);
    input.model_id = Some("gpt-5.5".to_string());
    input.reasoning_effort = Some("medium".to_string());

    harness
        .create_session(input, runtime)
        .await
        .expect("create codex session");

    let requests = server.requests();
    assert_eq!(requests[2]["method"], "thread/start");
    assert_eq!(requests[2]["params"]["model"], "gpt-5.5");
    assert_eq!(requests[2]["params"]["effort"], "medium");
}

#[tokio::test]
async fn default_model_and_effort_omit_app_server_overrides() {
    let server = MockAppServer::start(MockScript::default()).await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, _events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(create_input("backend-default-options", None, None), runtime)
        .await
        .expect("create codex session");

    let requests = server.requests();
    assert_eq!(requests[2]["method"], "thread/start");
    assert!(requests[2]["params"].get("model").is_none());
    assert!(requests[2]["params"].get("effort").is_none());
}

#[tokio::test]
async fn server_approval_requests_are_denied_with_warning() {
    let server = MockAppServer::start(MockScript {
        server_request_method: Some("item/commandExecution/requestApproval"),
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(create_input("backend-approval", None, None), runtime)
        .await
        .expect("create codex session");
    harness
        .send_message("backend-approval", "run command")
        .await
        .expect("send codex message");

    server.wait_for_request_count(5).await;
    let requests = server.requests();
    assert!(requests.iter().any(|request| {
        request.get("id") == Some(&json!(1000))
            && request.pointer("/result/decision") == Some(&json!("decline"))
    }));
    assert!(events
        .lock()
        .expect("events lock")
        .iter()
        .any(|event| matches!(
            event,
            LocalChatEvent::Warning(LocalChatSessionWarningEvent { warning, .. })
                if warning.contains("command execution approval")
        )));
}

#[tokio::test]
async fn stale_turn_completion_before_turn_response_is_ignored() {
    let server = MockAppServer::start(MockScript {
        stale_completion_before_turn_response: true,
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(create_input("backend-stale", None, None), runtime)
        .await
        .expect("create codex session");
    harness
        .send_message("backend-stale", "current turn")
        .await
        .expect("send codex message");
    wait_for_event(&events, |event| {
        matches!(
            event,
            LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id,
                ..
            }) if backend_session_id == "backend-stale"
        )
    })
    .await;

    let events = events.lock().expect("events lock").clone();
    let end_events: Vec<_> = events
        .iter()
        .filter_map(|event| {
            if let LocalChatEvent::End(event) = event {
                Some(event)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(end_events.len(), 1);
    assert_eq!(end_events[0].duration_ms, 17);
    assert_eq!(end_events[0].result, "hello world");
}

#[tokio::test]
async fn codex_child_thread_notifications_after_parent_turn_completion_are_still_processed() {
    let server = MockAppServer::start(MockScript {
        child_status_after_parent_completion: true,
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(
            create_input("backend-child-after-parent", None, None),
            runtime,
        )
        .await
        .expect("create codex session");
    harness
        .send_message("backend-child-after-parent", "spawn and return")
        .await
        .expect("send codex message");

    wait_for_event(&events, |event| {
        matches!(
            event,
            LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                tool_id,
                tool_name,
                input,
                ..
            }) if tool_id == "agent:child-thread"
                && tool_name == "Agent"
                && serde_json::from_str::<Value>(input)
                    .ok()
                    .and_then(|value| value
                        .pointer("/agents_states/child-thread/status")
                        .and_then(Value::as_str)
                        .map(str::to_string))
                    .as_deref()
                    == Some("completed")
        )
    })
    .await;
}

#[tokio::test]
async fn create_session_resumes_provider_thread_and_send_message_uses_same_thread() {
    let server = MockAppServer::start(MockScript {
        thread_id: "existing-thread",
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, _events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(
            create_input("backend-resume", None, Some("existing-thread")),
            runtime,
        )
        .await
        .expect("resume codex session");
    harness
        .send_message("backend-resume", "next message")
        .await
        .expect("send resumed message");
    server.wait_for_request_count(4).await;

    let requests = server.requests();
    assert_eq!(requests[2]["method"], "thread/resume");
    assert_eq!(requests[2]["params"]["threadId"], "existing-thread");
    assert_eq!(requests[2]["params"]["excludeTurns"], true);
    assert_eq!(requests[3]["method"], "turn/start");
    assert_eq!(requests[3]["params"]["threadId"], "existing-thread");
    assert_eq!(requests[3]["params"]["input"][0]["text"], "next message");
}

#[tokio::test]
async fn resume_seeds_thread_before_early_status_notification() {
    let server = MockAppServer::start(MockScript {
        thread_id: "existing-thread",
        thread_status_before_thread_response: true,
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(
            create_input("backend-resume-race", None, Some("existing-thread")),
            runtime,
        )
        .await
        .expect("resume codex session");

    let events = events.lock().expect("events lock");
    assert!(
        !events.iter().any(|event| matches!(
            event,
            LocalChatEvent::ToolCall(LocalChatToolCallEvent {
                tool_id,
                tool_name,
                ..
            }) if tool_id == "agent:existing-thread" && tool_name == "Agent"
        )),
        "the resumed parent thread must not be synthesized as a child Agent"
    );
}

#[tokio::test]
async fn json_rpc_errors_surface_as_start_failures() {
    let server = MockAppServer::start(MockScript {
        rpc_error_method: Some("thread/start"),
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    let result = harness
        .create_session(create_input("backend-error", None, None), runtime)
        .await;

    assert_eq!(
        result,
        Err(LocalChatSessionError::StartFailed(
            "thread/start exploded (-32000)".to_string()
        ))
    );
    assert!(!harness.has_session("backend-error").await);
    assert!(events
        .lock()
        .expect("events lock")
        .contains(&LocalChatEvent::Error(LocalChatSessionErrorEvent {
            backend_session_id: "backend-error".to_string(),
            harness: LocalChatHarnessKind::Codex,
            error: "thread/start exploded (-32000)".to_string(),
        })));
}

#[tokio::test]
async fn failed_turn_emits_error_and_end_after_send_returns_ok() {
    let server = MockAppServer::start(MockScript {
        turn_status: "failed",
        turn_error: Some("model failed"),
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(create_input("backend-failed-turn", None, None), runtime)
        .await
        .expect("create codex session");
    let result = harness
        .send_message("backend-failed-turn", "please fail")
        .await;

    assert_eq!(result, Ok(()));
    wait_for_event(&events, |event| {
        matches!(
            event,
            LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id,
                error,
                ..
            }) if backend_session_id == "backend-failed-turn" && error == "model failed"
        )
    })
    .await;
    wait_for_event(&events, |event| {
        matches!(
            event,
            LocalChatEvent::End(LocalChatSessionEndEvent {
                backend_session_id,
                is_error: true,
                ..
            }) if backend_session_id == "backend-failed-turn"
        )
    })
    .await;
    let events = events.lock().expect("events lock").clone();
    assert!(
        events.contains(&LocalChatEvent::Error(LocalChatSessionErrorEvent {
            backend_session_id: "backend-failed-turn".to_string(),
            harness: LocalChatHarnessKind::Codex,
            error: "model failed".to_string(),
        }))
    );
    assert!(events.iter().any(|event| matches!(
        event,
        LocalChatEvent::End(LocalChatSessionEndEvent {
            result,
            is_error: true,
            ..
        }) if result == "model failed"
    )));
}

#[tokio::test]
async fn turn_start_rpc_failure_after_send_returns_ok_surfaces_error_event() {
    let server = MockAppServer::start(MockScript {
        rpc_error_method: Some("turn/start"),
        ..MockScript::default()
    })
    .await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(
            create_input("backend-turn-start-error", None, None),
            runtime,
        )
        .await
        .expect("create codex session");
    let result = harness
        .send_message("backend-turn-start-error", "please fail")
        .await;

    assert_eq!(result, Ok(()));
    wait_for_event(&events, |event| {
        matches!(
            event,
            LocalChatEvent::Error(LocalChatSessionErrorEvent {
                backend_session_id,
                error,
                ..
            }) if backend_session_id == "backend-turn-start-error"
                && error == "turn/start exploded (-32000)"
        )
    })
    .await;
}

#[tokio::test]
async fn close_session_cleans_up_live_registry_and_socket() {
    let server = MockAppServer::start(MockScript::default()).await;
    let harness = CodexLocalChatHarness::with_launcher_for_tests(server.launcher());
    let (runtime, _events) = LocalChatRuntime::capturing_for_tests();

    harness
        .create_session(create_input("backend-close", None, None), runtime)
        .await
        .expect("create codex session");
    assert!(harness.has_session("backend-close").await);

    harness
        .close_session("backend-close")
        .await
        .expect("close codex session");
    assert!(!harness.has_session("backend-close").await);

    tokio::time::timeout(Duration::from_secs(1), async {
        while !server.closed() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("mock server should observe websocket close");
}

#[tokio::test]
async fn ready_probe_handles_status_line_split_across_reads() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind readiness probe listener");
    let addr = listener.local_addr().expect("read readiness probe addr");

    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept readiness probe");
        let mut request = [0_u8; 128];
        let _ = stream.read(&mut request).await;
        stream.write_all(b"HT").await.expect("write split status");
        sleep(Duration::from_millis(10)).await;
        stream
            .write_all(b"TP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .await
            .expect("write remainder");
    });

    assert!(ready_probe(addr).await.expect("readiness probe"));
}
