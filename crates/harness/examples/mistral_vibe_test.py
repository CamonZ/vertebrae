#!/usr/bin/env python3
"""Scripted Vibe server and isolated process checks; no credentials or network."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


def fake_server():
    scenario = os.environ["MISTRAL_VIBE_TEST_SCENARIO"]
    capture = Path(os.environ["MISTRAL_VIBE_TEST_CAPTURE"])
    seen = []

    def send(message):
        print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)

    def event(method, **params):
        send({"method": method, "params": {"sessionId": "session", **params}})

    for line in sys.stdin:
        request = json.loads(line)
        method = request["method"]
        seen.append(method)
        capture.write_text(json.dumps({
            "pid": os.getpid(), "home": os.environ["VIBE_HOME"],
            "workspace": os.getcwd(), "seen": seen,
        }))
        if method == "initialize":
            assert seen == ["initialize"]
            if scenario == "malformed":
                print("not JSON", flush=True)
                continue
            if scenario == "oversize":
                print("x" * (1024 * 1024 + 1), flush=True)
                continue
            result = {"serverInfo": {"name": "vibe-app-server", "version": "old" if scenario == "version" else "2.26.1"}}
        elif method == "initialized":
            assert seen == ["initialize", "initialized"]
            continue
        elif method == "session/start":
            assert seen == ["initialize", "initialized", "session/start"]
            config = request["params"]["agentConfig"]
            assert config["enabledTools"] == []
            assert config["autoApprove"] is False
            assert config["trustWorkspace"] is False
            assert config["headless"] is True
            assert Path(config["cwd"]).resolve() == Path.cwd()
            if scenario == "rpc_error":
                send({"id": request["id"], "error": {"code": -32603, "message": "FAKE_SECRET"}})
                continue
            result = {"state": {"session": {"id": "session"}}}
        elif method == "turn/start":
            assert request["params"]["sessionId"] == "session"
            assert request["params"]["message"] == [{"type": "text", "text": "hello"}]
            if scenario == "eof":
                return
            send({"id": request["id"], "result": {"turn": {"id": "turn"}}})
            if scenario in ("interrupt", "timeout"):
                continue
            if scenario == "wrong_id":
                send({"id": 99, "result": {}})
                continue
            if scenario == "callback":
                send({"id": "callback", "method": "callback/call", "params": {}})
                continue
            event("history/entryAdded", entry={
                "id": "z-first", "type": "message", "role": "assistant",
                "generationStatus": "in_progress", "content": [{"type": "text", "text": "hel"}],
            })
            event("history/entryUpdated", entryId="z-first", patch=[
                {"op": "append", "path": "/content/0/text", "value": "lo"},
                {"op": "replace", "path": "/generationStatus", "value": "in_progress" if scenario == "incomplete" else "completed"},
            ])
            event("history/entryAdded", entry={
                "id": "a-second", "type": "message", "role": "assistant",
                "generationStatus": "completed", "content": [{"type": "text", "text": "world"}],
            })
            event("turn/completed", turn={
                "id": "turn", "status": "failed" if scenario == "refusal" else "completed",
                "stopReason": scenario if scenario in ("limit", "length") else None,
                "error": {"code": "refusal", "message": "FAKE_SECRET"} if scenario == "refusal" else None,
            })
            continue
        elif method == "session/stop":
            result = {}
        else:
            raise AssertionError(method)
        send({"id": request["id"], "result": result})
        if method == "session/stop" and scenario == "nonzero_exit":
            sys.exit(7)


def check(binary, scenario):
    with tempfile.TemporaryDirectory() as directory:
        capture = Path(directory) / "capture.json"
        process = subprocess.Popen([binary, "hello"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env={**os.environ,
                                                  "MISTRAL_VIBE_SERVER": str(Path(__file__).resolve()),
                                                  "MISTRAL_VIBE_TEST_SCENARIO": scenario,
                                                  "MISTRAL_VIBE_TEST_CAPTURE": str(capture)})
        if scenario == "interrupt":
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    if "turn/start" in json.loads(capture.read_text())["seen"]:
                        break
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                time.sleep(0.01)
            else:
                process.kill()
                raise AssertionError("fake server never reached turn/start")
            process.send_signal(signal.SIGINT)
        try:
            stdout, stderr = process.communicate(timeout=135 if scenario == "timeout" else 15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise AssertionError(f"{scenario}: POC did not terminate") from None
        assert (process.returncode == 0) == (scenario == "success"), (scenario, stderr)
        assert stdout == ("hello\n\nworld\n" if scenario == "success" else ""), (scenario, stdout)
        assert "FAKE_SECRET" not in stdout + stderr
        state = json.loads(capture.read_text())
        assert not Path(state["home"]).exists(), state
        assert not Path(state["workspace"]).exists(), state
        try:
            os.kill(state["pid"], 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError(f"{scenario}: server still exists after cleanup")
        if scenario in ("success", "limit", "length", "refusal", "callback", "interrupt", "timeout"):
            assert state["seen"][-1] == "session/stop", state
        print(f"PASS {scenario}: outcome, cleanup and diagnostic redaction")


if __name__ == "__main__":
    if os.environ.get("MISTRAL_VIBE_TEST_SCENARIO"):
        fake_server()
    else:
        binary = str(Path(sys.argv[1]).resolve())
        for scenario in ("success", "rpc_error", "eof", "malformed", "oversize", "callback",
                         "limit", "length", "refusal", "interrupt", "incomplete", "wrong_id", "version", "nonzero_exit"):
            check(binary, scenario)
        if "--timeout" in sys.argv[2:]:
            check(binary, "timeout")
