"""Minimal ACP agent. Fail the subprocess on departures from the expected wire exchange."""
import json
import os
import sys

model_mode = sys.argv[1:] == ["--model"]
if not model_mode:
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
result(initialize, protocolVersion=1)
new = receive()
assert new["method"] == "session/new"
assert new["params"] == {"cwd": os.getcwd(), "mcpServers": []}
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
