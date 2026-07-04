use serde_json::{json, Value};

pub(super) fn useful_json_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
        _ => true,
    }
}

pub(super) fn first_value_at(item: &Value, paths: &[&str]) -> Value {
    paths
        .iter()
        .filter_map(|path| item.pointer(path))
        .find(|value| useful_json_value(value))
        .cloned()
        .unwrap_or(Value::Null)
}

pub(super) fn collab_agent_nickname(item: &Value) -> Value {
    first_value_at(
        item,
        &[
            "/newAgentNickname",
            "/receiverAgentNickname",
            "/agentNickname",
            "/nickname",
            "/name",
            "/newAgent/nickname",
            "/newAgent/agentNickname",
            "/receiverAgent/nickname",
            "/receiverAgent/agentNickname",
            "/agent/nickname",
            "/agent/agentNickname",
            "/result/nickname",
            "/result/agentNickname",
            "/result/agent_nickname",
            "/output/nickname",
            "/output/agentNickname",
            "/response/nickname",
            "/response/agentNickname",
        ],
    )
}

pub(super) fn collab_agent_role(item: &Value) -> Value {
    first_value_at(
        item,
        &[
            "/newAgentRole",
            "/receiverAgentRole",
            "/agentRole",
            "/role",
            "/newAgent/role",
            "/newAgent/agentRole",
            "/receiverAgent/role",
            "/receiverAgent/agentRole",
            "/agent/role",
            "/agent/agentRole",
            "/result/role",
            "/result/agentRole",
            "/result/agent_role",
            "/output/role",
            "/output/agentRole",
            "/response/role",
            "/response/agentRole",
        ],
    )
}

pub(super) fn collab_agent_thread_id(item: &Value) -> Value {
    first_value_at(
        item,
        &[
            "/receiverThreadIds/0",
            "/receiverThreadId",
            "/threadId",
            "/thread_id",
            "/agentId",
            "/agent_id",
            "/agentPath",
            "/agent_path",
            "/path",
            "/newAgent/threadId",
            "/newAgent/agentId",
            "/newAgent/agentPath",
            "/receiverAgent/threadId",
            "/receiverAgent/agentId",
            "/receiverAgent/agentPath",
            "/agent/threadId",
            "/agent/agentId",
            "/agent/agentPath",
            "/result/threadId",
            "/result/thread_id",
            "/result/agentId",
            "/result/agent_id",
            "/result/agentPath",
            "/result/agent_path",
            "/result/path",
            "/result/id",
            "/output/agentId",
            "/output/agentPath",
            "/response/agentId",
            "/response/agentPath",
        ],
    )
}

pub(super) fn collab_receiver_thread_ids(item: &Value) -> Value {
    item.get("receiverThreadIds")
        .filter(|value| useful_json_value(value))
        .cloned()
        .unwrap_or_else(|| {
            let thread_id = collab_agent_thread_id(item);
            if useful_json_value(&thread_id) {
                json!([thread_id])
            } else {
                Value::Null
            }
        })
}

pub(super) fn collab_receiver_thread_id_strings(item: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(values) = collab_receiver_thread_ids(item).as_array() {
        ids.extend(values.iter().filter_map(Value::as_str).filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        }));
    }
    ids.sort();
    ids.dedup();
    ids
}

pub(super) fn collab_receiver_agents(item: &Value) -> Value {
    item.get("receiverAgents")
        .filter(|value| useful_json_value(value))
        .cloned()
        .unwrap_or_else(|| {
            let thread_id = collab_agent_thread_id(item);
            let nickname = collab_agent_nickname(item);
            let role = collab_agent_role(item);
            if useful_json_value(&thread_id)
                || useful_json_value(&nickname)
                || useful_json_value(&role)
            {
                json!([{
                    "threadId": thread_id,
                    "agentNickname": nickname,
                    "agentRole": role,
                }])
            } else {
                Value::Null
            }
        })
}

pub(super) fn string_values_at(item: &Value, paths: &[&str]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| item.pointer(path).and_then(Value::as_str))
        .filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
        .collect()
}

pub(super) fn is_terminal_child_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed"
            | "complete"
            | "succeeded"
            | "success"
            | "done"
            | "failed"
            | "error"
            | "system_error"
            | "systemerror"
            | "cancelled"
            | "canceled"
            | "timed_out"
            | "timedout"
    )
}

pub(super) fn is_error_child_status(status: &str) -> bool {
    !matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "complete" | "succeeded" | "success" | "done"
    )
}

pub(super) fn string_array_at(item: &Value, paths: &[&str]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| item.pointer(path).and_then(Value::as_array))
        .flat_map(|values| values.iter().filter_map(Value::as_str))
        .filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        })
        .collect()
}

pub(super) fn collab_agent_identity_keys(item: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    keys.extend(string_array_at(
        item,
        &[
            "/receiverThreadIds",
            "/receiver_thread_ids",
            "/result/receiverThreadIds",
            "/result/receiver_thread_ids",
            "/output/receiverThreadIds",
            "/response/receiverThreadIds",
        ],
    ));
    keys.extend(string_values_at(
        item,
        &[
            "/threadId",
            "/thread_id",
            "/receiverThreadId",
            "/receiver_thread_id",
            "/agentId",
            "/agent_id",
            "/agentPath",
            "/agent_path",
            "/path",
            "/id",
            "/newAgent/threadId",
            "/newAgent/thread_id",
            "/newAgent/agentId",
            "/newAgent/agent_id",
            "/newAgent/agentPath",
            "/newAgent/agent_path",
            "/receiverAgent/threadId",
            "/receiverAgent/thread_id",
            "/receiverAgent/agentId",
            "/receiverAgent/agent_id",
            "/receiverAgent/agentPath",
            "/receiverAgent/agent_path",
            "/agent/threadId",
            "/agent/thread_id",
            "/agent/agentId",
            "/agent/agent_id",
            "/agent/agentPath",
            "/agent/agent_path",
            "/item/threadId",
            "/item/thread_id",
            "/item/agentId",
            "/item/agent_id",
            "/item/agentPath",
            "/item/agent_path",
            "/result/threadId",
            "/result/thread_id",
            "/result/agentId",
            "/result/agent_id",
            "/result/agentPath",
            "/result/agent_path",
            "/result/path",
            "/result/id",
            "/output/threadId",
            "/output/agentId",
            "/output/agentPath",
            "/response/threadId",
            "/response/agentId",
            "/response/agentPath",
        ],
    ));
    for path in [
        "/receiverAgents",
        "/receiver_agents",
        "/agentStatuses",
        "/agent_statuses",
        "/result/receiverAgents",
        "/result/agentStatuses",
    ] {
        let Some(values) = item.pointer(path).and_then(Value::as_array) else {
            continue;
        };
        for value in values {
            keys.extend(string_values_at(
                value,
                &[
                    "/threadId",
                    "/thread_id",
                    "/receiverThreadId",
                    "/receiver_thread_id",
                    "/agentId",
                    "/agent_id",
                    "/agentPath",
                    "/agent_path",
                    "/path",
                    "/id",
                ],
            ));
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

/// Derive a stable id for a `collabAgentToolCall` *spawn* (`tool ==
/// "spawnAgent"`) from the agent identity the item already carries --
/// `receiverThreadIds`, `agentId`/`threadId`, or the spawn result's
/// `agent_id`/`agent_path`/`id` (see [`collab_agent_thread_id`]).
///
/// This mirrors the `agent:${agentPath}` convention the TypeScript rollout
/// hydrator synthesizes for the same spawn (`agentToolId` in
/// `conversation.ts`). Before this, the live path used the app-server item
/// id as `tool_id`, which can never equal the hydration-synthesized id, so a
/// single real spawn produced two irreconcilable spawn cards once a session
/// was reloaded from its rollout file. Returns `None` when no identity is
/// resolvable yet (e.g. `item/started` fires before `receiverThreadIds`/
/// `result` are populated); callers should fall back to the item id in that
/// case so the call still gets *some* stable id for the remainder of its
/// (live-only) lifecycle.
pub(super) fn collab_agent_spawn_id(item: &Value) -> Option<String> {
    collab_agent_thread_id(item)
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|agent_path| format!("agent:{agent_path}"))
}

pub(super) fn unresolved_collab_spawn(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("collabAgentToolCall")
        && item
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("spawnAgent")
            == "spawnAgent"
        && collab_agent_spawn_id(item).is_none()
}

pub(super) fn codex_tool_call(item: &Value) -> Option<(String, String, String)> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let item_id = item.get("id").and_then(Value::as_str)?.to_string();
    let (id, tool_name, input) = match item_type {
        "commandExecution" => (
            item_id,
            "Bash".to_string(),
            json!({
                "command": item.get("command").and_then(Value::as_str).unwrap_or_default(),
                "cwd": item.get("cwd").and_then(Value::as_str),
            }),
        ),
        "fileChange" => (
            item_id,
            "apply_patch".to_string(),
            item.get("changes").cloned().unwrap_or(Value::Null),
        ),
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("mcp");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            (
                item_id,
                format!("{server}.{tool}"),
                item.get("arguments").cloned().unwrap_or(Value::Null),
            )
        }
        "dynamicToolCall" => {
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let namespace = item.get("namespace").and_then(Value::as_str);
            let tool_name = namespace
                .map(|namespace| format!("{namespace}.{tool}"))
                .unwrap_or_else(|| tool.to_string());
            (
                item_id,
                tool_name,
                item.get("arguments").cloned().unwrap_or(Value::Null),
            )
        }
        "webSearch" => (
            item_id,
            "web_search".to_string(),
            Value::Object(Default::default()),
        ),
        "collabAgentToolCall" => {
            let tool = item
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("spawnAgent");
            let tool_name = if tool == "spawnAgent" {
                "Agent"
            } else {
                "agent"
            };
            // Only the spawning call itself is reconciled with hydration;
            // wait_agent/close_agent calls are their own tool cards (see
            // `remember_child_thread_parents`'s `or_insert_with` for
            // non-spawn tools) and keep the item id.
            let id = if tool == "spawnAgent" {
                collab_agent_spawn_id(item).unwrap_or(item_id)
            } else {
                item_id
            };
            (
                id,
                tool_name.to_string(),
                json!({
                    "description": item.get("prompt").and_then(Value::as_str).unwrap_or(tool),
                    "collab_tool": tool,
                    "subagent_type": item.get("model").and_then(Value::as_str).unwrap_or("agent"),
                    "agent_nickname": collab_agent_nickname(item),
                    "agent_role": collab_agent_role(item),
                    "receiver_thread_ids": collab_receiver_thread_ids(item),
                    "receiver_agents": collab_receiver_agents(item),
                    "agent_statuses": item.get("agentStatuses").cloned().unwrap_or(Value::Null),
                    "agents_states": item.get("agentsStates").cloned().unwrap_or(Value::Null),
                }),
            )
        }
        // Plan/todo checklist items. Mirrors the daemon's `codex_jsonl`
        // parser and the exec-shape TS parser (`conversation.ts`'s
        // `todo_list` handling), which model these as `{"items":
        // [{"text","completed"}]}` under an `item.started`/`item.updated`/
        // `item.completed` envelope. Neither of those surfaces reasoning
        // items either, and this harness has no dedicated "plan" event
        // (only tool_call/tool_result), so we render the plan as a
        // `TodoWrite` tool call: at least the checklist shows up as a tool
        // row instead of being silently dropped. Accept both the app-server
        // camelCase spelling used by every other item type here and the
        // snake_case spelling documented upstream, since the exact wire
        // casing for this item hasn't been confirmed against a live server.
        "todoList" | "todo_list" => (
            item_id,
            "TodoWrite".to_string(),
            json!({ "todos": item.get("items").cloned().unwrap_or(Value::Null) }),
        ),
        _ => return None,
    };
    Some((
        id,
        tool_name,
        serde_json::to_string(&input).unwrap_or_default(),
    ))
}

pub(super) fn codex_tool_result(item: &Value) -> Option<(String, String, bool)> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let item_id = item.get("id").and_then(Value::as_str)?.to_string();
    let (id, result, is_error) = match item_type {
        "commandExecution" => {
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                item_id,
                item.get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                matches!(status, "failed" | "declined"),
            )
        }
        "fileChange" => {
            let status = item
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                item_id,
                serde_json::to_string(item.get("changes").unwrap_or(&Value::Null))
                    .unwrap_or_default(),
                matches!(status, "failed" | "declined"),
            )
        }
        "mcpToolCall" => {
            if let Some(error) = item.get("error") {
                (
                    item_id,
                    serde_json::to_string(error).unwrap_or_default(),
                    true,
                )
            } else {
                (
                    item_id,
                    serde_json::to_string(item.get("result").unwrap_or(&Value::Null))
                        .unwrap_or_default(),
                    item.get("status").and_then(Value::as_str) == Some("failed"),
                )
            }
        }
        "dynamicToolCall" => (
            item_id,
            serde_json::to_string(item.get("contentItems").unwrap_or(&Value::Null))
                .unwrap_or_default(),
            item.get("success").and_then(Value::as_bool) == Some(false)
                || item.get("status").and_then(Value::as_str) == Some("failed"),
        ),
        "webSearch" => (item_id, "Web search completed".to_string(), false),
        "collabAgentToolCall" => {
            // Must resolve to the same id `codex_tool_call` assigned to the
            // matching spawn, or the ToolResult never reconciles with its
            // ToolCall in the GUI (see `collab_agent_spawn_id`).
            let tool = item
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or("spawnAgent");
            let id = if tool == "spawnAgent" {
                collab_agent_spawn_id(item).unwrap_or(item_id)
            } else {
                item_id
            };
            (
                id,
                item.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed")
                    .to_string(),
                item.get("status").and_then(Value::as_str) == Some("failed"),
            )
        }
        // See the matching arm in `codex_tool_call` for why plan/todo items
        // are mapped to a tool row rather than dropped. A todo-list update
        // is a status snapshot, not a failure signal, so `is_error` is
        // always `false` here.
        "todoList" | "todo_list" => {
            let items = item
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let completed = items
                .iter()
                .filter(|entry| entry.get("completed").and_then(Value::as_bool) == Some(true))
                .count();
            (
                item_id,
                format!("{completed}/{} steps completed", items.len()),
                false,
            )
        }
        _ => return None,
    };
    Some((id, result, is_error))
}

pub(super) fn child_thread_status_label(status: &str) -> Option<&'static str> {
    match status {
        "active" | "inProgress" | "in_progress" | "running" => Some("running"),
        "idle" | "notLoaded" | "not_loaded" => Some("pendingInit"),
        "systemError" | "system_error" | "error" => Some("failed"),
        "failed" => Some("failed"),
        "cancelled" | "canceled" => Some("cancelled"),
        "completed" => Some("completed"),
        _ => None,
    }
}

pub(super) fn child_thread_status_from_params(params: &Value) -> Option<&'static str> {
    [
        "/status/type",
        "/status/status",
        "/status",
        "/thread/status/type",
        "/thread/status/status",
    ]
    .into_iter()
    .find_map(|path| {
        params
            .pointer(path)
            .and_then(Value::as_str)
            .and_then(child_thread_status_label)
    })
}

pub(super) fn codex_error_message(params: &Value) -> Option<String> {
    [
        "/message",
        "/error/message",
        "/turn/error/message",
        "/error",
        "/turn/error",
    ]
    .into_iter()
    .find_map(|pointer| {
        let value = params.pointer(pointer)?;
        match value {
            Value::String(message) if !message.is_empty() => Some(message.clone()),
            Value::Object(_) | Value::Array(_) => Some(value.to_string()),
            _ => None,
        }
    })
}

pub(super) fn value_to_u32(value: Option<&Value>) -> Option<u32> {
    value
        .and_then(Value::as_u64)
        .map(|value| value.min(u32::MAX as u64) as u32)
}
