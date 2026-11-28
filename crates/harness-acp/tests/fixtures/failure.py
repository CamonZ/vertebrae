"""Emit one deliberate ACP failure at a named lifecycle boundary."""
import json
import os
import socket
import sys
import time

mode = sys.argv[1]


def receive():
    return json.loads(sys.stdin.readline())


def send(**message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)


def wait_for_cancel():
    host, port = os.environ["VTB_ACP_CANCEL_CHECKPOINT"].split(":")
    with socket.create_connection((host, int(port))):
        pass
    assert not sys.stdin.readline()
    sys.exit()


initialize = receive()
if mode == "cancel-open":
    wait_for_cancel()
if mode == "stderr":
    print("unrecognized argument private-argument-value", file=sys.stderr, flush=True)
    sys.exit(42)
send(id=initialize["id"], result={"protocolVersion": 2 if mode == "version" else 1})
if mode == "version":
    sys.exit()

new = receive()
if mode == "auth":
    send(id=new["id"], error={"code": -32000, "message": "Authentication required"})
    sys.exit()
if mode == "cancel-settings":
    send(id=new["id"], result={"sessionId": "fixture", "configOptions": [{
        "id": "model", "category": "model", "type": "select", "name": "Model",
        "currentValue": "default", "options": [{"value": "selected", "name": "Selected"}],
    }]})
    assert receive()["method"] == "session/set_config_option"
    wait_for_cancel()
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
