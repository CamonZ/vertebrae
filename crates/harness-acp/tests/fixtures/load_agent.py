"""ACP agent that restores via session/load and uses legacy permission modes."""
import json
import sys


def send(**fields):
    print(json.dumps({"jsonrpc": "2.0", **fields}), flush=True)


def update(kind, **fields):
    send(method="session/update", params={
        "sessionId": "saved-session", "update": {"sessionUpdate": kind, **fields},
    })


modes = {
    "currentModeId": "ask",
    "availableModes": [
        {"id": "ask", "name": "Ask"},
        {"id": "dangerously-skip-permissions", "name": "Bypass permissions"},
        {"id": "auto", "name": "Auto"},
    ],
}
mode = "ask"
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
    elif method == "session/new":
        result = {"sessionId": "saved-session", "modes": modes}
    elif method == "session/load":
        assert request["params"]["sessionId"] == "saved-session"
        update("agent_message_chunk", content={"type": "text", "text": "history"})
        update("usage_update", used=31, size=200)
        result = {"modes": modes}
    elif method == "session/set_mode":
        mode = request["params"]["modeId"]
        result = {}
    elif method == "session/prompt":
        assert request["params"]["sessionId"] == "saved-session"
        assert mode == request["params"]["prompt"][0]["text"]
        update("usage_update", used=79, size=200)
        update("usage_update", used=41, size=200)
        result = {"stopReason": "end_turn"}
    else:
        raise AssertionError(method)
    send(id=request["id"], result=result)
