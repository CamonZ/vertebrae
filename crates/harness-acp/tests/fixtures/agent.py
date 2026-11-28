"""Minimal ACP agent. Fail the subprocess on departures from the expected wire exchange."""
import json
import os
import sys

model_mode = sys.argv[1:] == ["--model"]
workflow_mode = sys.argv[1:] == ["--workflow", "literal $HOME; value"]
workflow_model = sys.argv[1:] == ["--workflow-model"]
if not (model_mode or workflow_mode or workflow_model):
    assert sys.argv[1:] == ["one argument with spaces", "$HOME; literal", ""]


def receive():
    message = json.loads(sys.stdin.readline())
    assert message["jsonrpc"] == "2.0"
    return message


def send(**fields):
    print(json.dumps({"jsonrpc": "2.0", **fields}), flush=True)


def result(request, **fields):
    send(id=request["id"], result=fields)


def update(kind, **fields):
    send(method="session/update", params={
        "sessionId": "fixture", "update": {"sessionUpdate": kind, **fields}
    })


def prompt(expected):
    request = receive()
    assert request["method"] == "session/prompt"
    assert request["params"] == {
        "sessionId": "fixture", "prompt": [{"type": "text", "text": expected}]
    }
    return request


def request_permission(request_id):
    send(id=request_id, method="session/request_permission", params={
        "sessionId": "fixture",
        "toolCall": {"toolCallId": "fixture-tool", "title": "Read fixture"},
        "options": [
            {"optionId": "read-once", "name": "Allow once", "kind": "allow_once"},
            {"optionId": "block", "name": "Reject", "kind": "reject_once"},
        ],
    })


initialize = receive()
assert initialize["method"] == "initialize"
assert initialize["params"]["protocolVersion"] == 1
assert initialize["params"]["clientCapabilities"] == {}
if workflow_mode or workflow_model:
    result(initialize, protocolVersion=1, agentCapabilities={"sessionCapabilities": {"close": {}}})
else:
    result(initialize, protocolVersion=1)
new = receive()
assert new["method"] == "session/new"
assert new["params"] == {"cwd": os.getcwd(), "mcpServers": []}
if workflow_model:
    result(new, sessionId="fixture")
    turn = receive()
    assert turn["method"] == "session/prompt"
    assert turn["params"]["sessionId"] == "fixture"
    actions, ending = json.loads(turn["params"]["prompt"][0]["text"])
    for index, action in enumerate(actions):
        if action == "text":
            update("agent_message_chunk", content={"type": "text", "text": f"{index} "})
        elif action == "usage":
            update("usage_update", used=index, size=100)
        elif action == "permission":
            request_permission(f"request-{index}")
            assert receive() == {
                "jsonrpc": "2.0", "id": f"request-{index}",
                "result": {"outcome": {"outcome": "cancelled"}},
            }
        else:
            raise AssertionError(action)
    if ending == "eof":
        sys.exit(41)
    if ending == "error":
        send(id=turn["id"], error={"code": -32603, "message": "private fixture detail"})
    elif ending == "complete":
        result(turn, stopReason="end_turn")
        close = receive()
        assert close["method"] == "session/close"
        assert close["params"] == {"sessionId": "fixture"}
        with open("workflow-model-closed", "w") as marker:
            marker.write("closed")
        result(close)
    else:
        if ending == "cancel":
            update("agent_message_chunk", content={"type": "text", "text": "cancel checkpoint"})
            assert receive() == {
                "jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "fixture"},
            }
        else:
            assert ending == "agent-cancel"
        result(turn, stopReason="cancelled")
    # The runtime owns cleanup even if the agent keeps serving requests.
    sys.stdin.readline()
    sys.exit(0)
if workflow_mode:
    assert os.environ["VTB_ACP_WORKSPACE"] == os.getcwd()
    if "VTB_ACP_PATH_HEAD" in os.environ:
        assert os.environ["PATH"].split(os.pathsep)[0] == os.environ["VTB_ACP_PATH_HEAD"]
    model = {
        "type": "select", "id": "agent-model", "name": "Model", "category": "model",
        "currentValue": "default",
        "options": [{"value": name, "name": name} for name in ["default", "selected"]],
    }
    result(new, sessionId="fixture", configOptions=[model])
    setting = receive()
    assert setting["method"] == "session/set_config_option"
    assert setting["params"] == {"configId": "agent-model", "sessionId": "fixture", "value": "selected"}
    result(setting, configOptions=[dict(model, currentValue="selected")])
    turn = receive()
    assert turn["method"] == "session/prompt"
    content = turn["params"]["prompt"][0]["text"]
    assert content in {"complete", "cancel", "fail", "large"}
    request_permission("workflow-permission")
    assert receive() == {
        "jsonrpc": "2.0", "id": "workflow-permission",
        "result": {"outcome": {"outcome": "cancelled"}},
    }
    update("agent_message_chunk", content={"type": "text", "text": "Hello "})
    if content == "cancel":
        assert receive() == {
            "jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "fixture"},
        }
        result(turn, stopReason="cancelled")
    elif content == "fail":
        send(id=turn["id"], error={"code": -32603, "message": "private provider detail"})
    else:
        if content == "large":
            for _ in range(3):
                update("agent_message_chunk", content={"type": "text", "text": "x" * (400 * 1024)})
        else:
            update("agent_message_chunk", content={"type": "text", "text": "workflow"})
        result(turn, stopReason="end_turn")
    if content in {"complete", "large"}:
        close = receive()
        assert close["method"] == "session/close"
        assert close["params"] == {"sessionId": "fixture"}
        with open("close-ack", "w") as marker:
            marker.write(content)
        result(close)
    # Successful tests should also settle against a process that stays alive.
    sys.stdin.readline()
    sys.exit(0)
result(new, sessionId="fixture")

def run_model():
    turn_index = 0
    while line := sys.stdin.readline():
        request = json.loads(line)
        assert request["method"] == "session/prompt"
        assert request["params"]["sessionId"] == "fixture"
        scenario, count = json.loads(request["params"]["prompt"][0]["text"])
        request_id = turn_index if turn_index % 2 == 0 else f"rpc-{turn_index}"
        options = [
            {
                "optionId": f"option-{turn_index}-{i}",
                "name": "Same label",
                "kind": "allow_once",
            }
            for i in range(count)
        ]
        expected = {"outcome": "cancelled"}
        if scenario == "select":
            expected = {"outcome": "selected", "optionId": options[count // 2]["optionId"]}
        elif scenario == "duplicate":
            options[-1]["optionId"] = options[0]["optionId"]

        send(id=request_id, method="session/request_permission", params={
            "sessionId": "fixture",
            "toolCall": {"toolCallId": f"tool-{turn_index}", "title": scenario},
            "options": options,
        })
        if scenario == "interrupt":
            assert receive() == {
                "jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "fixture"}
            }
        assert receive() == {
            "jsonrpc": "2.0", "id": request_id, "result": {"outcome": expected}
        }
        result(request, stopReason="cancelled" if scenario == "interrupt" else "end_turn")
        turn_index += 1


if model_mode:
    run_model()
    sys.exit(0)

turn = prompt("first")
update("agent_message_chunk", content={"type": "text", "text": "Hello "})
update("tool_call", toolCallId="fixture-tool", title="Read fixture", status="pending")
request_permission("approval-1")
permission = receive()
assert permission["id"] == "approval-1"
assert permission["result"]["outcome"] == {"outcome": "selected", "optionId": "read-once"}
update("tool_call_update", toolCallId="fixture-tool", status="completed", rawOutput="data")
update("agent_message_chunk", content={"type": "text", "text": "world"})
result(turn, stopReason="end_turn")

turn = prompt("stop")
request_permission(900)
cancel = receive()
assert cancel == {
    "jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "fixture"}
}
permission = receive()
assert permission["id"] == 900
assert permission["result"]["outcome"] == {"outcome": "cancelled"}
result(turn, stopReason="cancelled")

turn = prompt("follow up")
update("agent_message_chunk", content={"type": "text", "text": "Same session"})
result(turn, stopReason="end_turn")
assert not sys.stdin.readline()
