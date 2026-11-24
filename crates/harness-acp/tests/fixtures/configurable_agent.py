"""ACP wire oracle for per-model configuration, steering and session recovery."""
import json
import sys
import time
from pathlib import Path


def receive():
    return json.loads(sys.stdin.readline())


def reply(request, **result):
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)


def notify(kind, **fields):
    print(json.dumps({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": "saved-session", "update": {"sessionUpdate": kind, **fields}},
    }), flush=True)


values = {"model": "default-model", "thinking": "low", "mode": "default", "speed_tier": "default"}
choices_by_id = {
    "model": ["default-model", "second-model"],
    "mode": ["default", "accept-edits", "plan"],
    "speed_tier": ["default", "fast"],
}


def option(key, category, choices):
    return {
        "id": key, "category": category, "name": key, "type": "select",
        "currentValue": values[key], "options": [{"value": item, "name": item} for item in choices],
    }


def config_options():
    thinking = ["low", "high"] if values["model"] == "default-model" else ["medium"]
    return [
        option("model", "model", choices_by_id["model"]),
        option("thinking", "thought_level", thinking),
        option("mode", "mode", choices_by_id["mode"]),
        option("speed_tier", "model_config", choices_by_id["speed_tier"] if values["model"] == "second-model" else ["default"]),
    ]


setup = receive()
assert setup["method"] == "initialize"
reply(setup, protocolVersion=1, agentInfo={"name": "Antigravity ACP Server", "version": "1.5.15"},
      agentCapabilities={"sessionCapabilities": {"resume": {}}})
setup = receive()
if setup["method"] == "session/resume":
    assert setup["params"]["sessionId"] == "saved-session"
else:
    assert setup["method"] == "session/new"
reply(setup, sessionId="saved-session", configOptions=config_options())

while line := sys.stdin.readline():
    request = json.loads(line)
    params = request["params"]
    assert params["sessionId"] == "saved-session"
    if request["method"] == "session/set_config_option":
        if sys.argv[1:] == ["config-eof"]:
            break
        if sys.argv[1:] == ["config-invalid"]:
            print("invalid JSON", flush=True)
            time.sleep(60)
        if sys.argv[1:] == ["config-timeout"]:
            time.sleep(60)
        key = params["configId"]
        allowed = next(config["options"] for config in config_options() if config["id"] == key)
        assert params["value"] in [item["value"] for item in allowed]
        values[key] = params["value"]
        if key == "model":
            values["thinking"] = "low" if values["model"] == "default-model" else "medium"
            if values["model"] == "default-model":
                values["speed_tier"] = "default"
        reply(request, configOptions=config_options())
        continue
    assert request["method"] == "session/prompt"
    content = params["prompt"][0]["text"]
    if content.startswith("{"):
        action = json.loads(content)
        if values != action["expected"]:
            Path("oracle-failure").write_text(f'{values} != {action["expected"]}')
            raise AssertionError("incorrect session configuration")
        if action["update"]:
            values["mode"] = "accept-edits"
            notify("config_option_update", configOptions=config_options())
        notify("agent_message_chunk", content={"type": "text", "text": action["marker"]})
        if action["blocked"]:
            print(json.dumps({
                "jsonrpc": "2.0", "id": "pending", "method": "session/request_permission",
                "params": {"sessionId": "saved-session",
                           "toolCall": {"toolCallId": "test", "title": "interrupt"},
                           "options": [{"optionId":"once", "name":"Allow"}]},
            }), flush=True)
            assert receive() == {"jsonrpc":"2.0", "method":"session/cancel", "params":{"sessionId":"saved-session"}}
            assert receive() == {"jsonrpc":"2.0", "id":"pending", "result":{"outcome":{"outcome":"cancelled"}}}
            reply(request, stopReason="cancelled")
            continue
        prompts = [request]
        for index in range(len(action["stops"]) - 1):
            steer = receive()
            assert steer["method"] == "session/prompt"
            assert steer["params"]["prompt"] == [{"type": "text", "text": f"steer {index}"}]
            assert steer["id"] not in [prompt["id"] for prompt in prompts]
            prompts.append(steer)
        for index in action["order"]:
            reply(prompts[index], stopReason=action["stops"][index])
        if action["idle_update"]:
            values["speed_tier"] = "fast" if values["model"] == "second-model" else "default"
            notify("config_option_update", configOptions=config_options())
            print(json.dumps({"jsonrpc":"2.0", "id":"idle-barrier", "method":"test/idle-barrier"}), flush=True)
            assert receive()["id"] == "idle-barrier"
            Path(action["marker"]).touch()
    elif content == "steer this":
        assert values == {"model": "second-model", "thinking": "medium", "mode": "plan", "speed_tier": "fast"}
        notify("agent_message_chunk", content={"type": "text", "text": "ready"})
        follow_up = receive()
        assert follow_up["method"] == "session/prompt"
        assert follow_up["params"] == {
            "sessionId": "saved-session", "prompt": [{"type": "text", "text": "steered input"}],
        }
        assert follow_up["id"] != request["id"]
        # Resolve the newer request first: the client must settle the logical turn once.
        reply(follow_up, stopReason="end_turn")
        reply(request, stopReason="cancelled")
    else:
        assert content in ("after rejection", "after resume")
        reply(request, stopReason="end_turn")
