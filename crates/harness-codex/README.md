# Vertebrae Codex harness

This crate owns attachment to the Codex App Server, websocket transport,
JSON-RPC correlation, provider notification decoding, thread/turn lifecycle,
controls, and bounded cleanup. GUI and daemon crates supply provider
configuration and consume provider-neutral `vertebrae-harness-core` events.

## Managed App Server daemon

Every session (new, resumed, or one-shot) is a thread on Codex's machine-wide
managed daemon, shared by the `vtb-daemon`, the GUI, and the user's own Codex
clients. `ManagedCodexAppServerLauncher` runs `codex app-server daemon
version` on each attach (honoring `CODEX_HOME` from the provider environment)
and `codex app-server daemon start` only when it is not running, then speaks
WebSocket JSON-RPC over the reported Unix control socket. The harness never
stops, restarts, or updates the daemon, and no per-session App Server
processes exist.

The daemon's environment comes from whichever process started it, so nothing
request-specific or secret is passed through it. Instead each `thread/start`
and every `thread/resume` (Codex does not persist per-thread config) carries a
`config` table with:

- `model_providers.<id>` for a custom provider, with the credential as
  `experimental_bearer_token` (an `env_key` would be resolved in the daemon's
  environment);
- `model_verbosity` when requested;
- `shell_environment_policy` with `inherit = "all"` and `set` holding the
  surface, custom-provider, and request environment plus the request PATH.
  Variables whose names contain `KEY`, `SECRET`, or `TOKEN` are withheld,
  matching Codex's default exclusion for inherited variables. Codex still
  prepends its own directories (`~/.cargo/bin` and its codex-path directory)
  to PATH in tool execution.

The daemon broadcasts `thread/started` and `thread/status/changed` for every
thread to every connection; the reader admits them only for the session's
root thread and the subagent threads it spawned.

Daemon restarts and auto-updates drain in-flight turns and then close
connections. Requests rejected with `Server is draining` are retried after
reattaching; a turn whose connection drops is reconciled after reattaching and
re-sending `thread/resume`: a terminal turn is finished from `thread/read`
history (its final agent message is authoritative), a still-running turn keeps
streaming on the new connection, and anything else fails explicitly. An
absent or killed daemon is started again on the next attach.

Session close interrupts an active turn, settles pending JSON-RPC controls,
sends `thread/unsubscribe`, and closes the WebSocket. Callers must still await
the returned session or run outcome before releasing their live ownership.

`CodexTranscriptReplay` owns discovery and normalization of durable rollout
JSONL under the Codex sessions and archived-sessions stores. It projects
message, tool, reasoning, plan, file-change, and diagnostic records into the
same `HarnessEventV1` contract used by the live App Server runtime.

For temporary App Server diagnostics, set `VERTEBRAE_CODEX_RAW_TRAFFIC=1` when
launching the consumer. The harness then logs every raw WebSocket frame at
info level with `[Codex][raw]` markers. This includes prompts and provider
responses, so leave the setting disabled during normal use.
