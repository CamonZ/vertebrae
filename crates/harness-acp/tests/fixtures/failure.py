"""Emit one deliberate ACP failure at a named lifecycle boundary."""
import json
import sys
import time

mode = sys.argv[1]


def receive():
    return json.loads(sys.stdin.readline())


def send(**message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)


initialize = receive()
send(id=initialize["id"], result={"protocolVersion": 2 if mode == "version" else 1})
if mode == "version":
    sys.exit()

new = receive()
if mode == "auth":
    send(id=new["id"], error={"code": -32000, "message": "Authentication required"})
    sys.exit()
send(id=new["id"], result={"sessionId": "fixture"})
if mode == "idle":
    sys.exit()

receive()
if mode == "invalid-json":
    print("not JSON", flush=True)
elif mode == "oversize":
    print("x" * (1024 * 1024 + 1), flush=True)
elif mode == "cancel-timeout":
    send(
        id=12, method="session/request_permission",
        params={
            "sessionId": "fixture",
            "toolCall": {"toolCallId": "tool", "title": "Read"},
            "options": [{"optionId": "read", "name": "Allow", "kind": "allow_once"}],
        },
    )
    assert receive()["method"] == "session/cancel"
    assert receive()["result"]["outcome"] == {"outcome": "cancelled"}
    time.sleep(30)
