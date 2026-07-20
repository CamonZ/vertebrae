# Vertebrae Codex harness

This crate owns the Codex App Server process, websocket transport, JSON-RPC
correlation, provider notification decoding, thread/turn lifecycle, controls,
and bounded cleanup. GUI and daemon crates supply provider configuration and
consume provider-neutral `vertebrae-harness-core` events.

For temporary App Server diagnostics, set `VERTEBRAE_CODEX_RAW_TRAFFIC=1` when
launching the consumer. The harness then logs every raw WebSocket frame at
info level with `[Codex][raw]` markers. This includes prompts and provider
responses, so leave the setting disabled during normal use.
