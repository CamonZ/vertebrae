# Vertebrae Codex harness

This crate owns the Codex App Server process, websocket transport, JSON-RPC
correlation, provider notification decoding, thread/turn lifecycle, controls,
and bounded cleanup. GUI and daemon crates supply provider configuration and
consume provider-neutral `vertebrae-harness-core` events.
