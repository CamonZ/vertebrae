# Vertebrae Codex harness

This crate owns the Codex App Server process, websocket transport, JSON-RPC
correlation, provider notification decoding, thread/turn lifecycle, controls,
and bounded cleanup. GUI and daemon crates supply provider configuration and
consume provider-neutral `vertebrae-harness-core` events.

Every launched App Server is placed in a provider-owned process group on Unix.
Session close first interrupts active turns and settles pending JSON-RPC
controls, then closes the WebSocket and terminates/reaps the complete process
tree with a bounded graceful-to-forced fallback. The runtime emits diagnostic
records for the process-close boundary; callers must still await the returned
session or run outcome before releasing their live ownership.

`CodexTranscriptReplay` owns discovery and normalization of durable rollout
JSONL under the Codex sessions and archived-sessions stores. It projects
message, tool, reasoning, plan, file-change, and diagnostic records into the
same `HarnessEventV1` contract used by the live App Server runtime.

For temporary App Server diagnostics, set `VERTEBRAE_CODEX_RAW_TRAFFIC=1` when
launching the consumer. The harness then logs every raw WebSocket frame at
info level with `[Codex][raw]` markers. This includes prompts and provider
responses, so leave the setting disabled during normal use.
