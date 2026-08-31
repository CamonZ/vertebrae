# Claude harness runtime

`vertebrae-harness-claude` is the reusable Claude Code CLI adapter for
`vertebrae-harness-core`. It owns provider-specific executable discovery,
configuration translation, process lifetime, live stream-json decoding, and
neutral `HarnessEventV1` production.

Provider processes are launched in their own process group on Unix. Shutdown
uses a bounded graceful-then-forced group cleanup and reaps the provider child,
so CLI wrappers and helper descendants cannot survive a terminal session,
cancellation, or daemon shutdown path.

Surface crates construct `ClaudeProviderConfig` with their Claude executable,
plugin/installed-skills roots, permission transport, environment compatibility,
and cleanup policy. Provider-owned arguments that must precede request overrides
belong in `ClaudeProviderPrelude` (including synthesized `--settings`); truly
trailing compatibility arguments remain in `extra_args`. Portable request
behavior stays in `RequestConfig`.

Real Claude init records may omit their transcript path. A surface that needs
canonical root thread declarations supplies a `ClaudeRootLocatorResolver` that
maps the newly revealed conversation id to the opaque locator discovered by
that surface. The decoder buffers root records until this value is available;
it does not guess Claude project-directory encoding or amend declarations.

The runtime supports:

- persistent stdin/stdout stream-json sessions, resume, multi-turn sends,
  interruption, and close;
- one-shot `--print --output-format stream-json` runs and cancellation;
- exact human and delegated-agent `TurnInput` events;
- canonical Claude conversation, agent-thread, spawn lineage, and opaque
  transcript locator declarations;
- partial text/reasoning, plans, tools, controls, usage, diagnostics, and
  terminal outcomes on independently sequenced root/subagent streams.

The crate also owns durable Claude transcript discovery and replay through
`ClaudeTranscriptReplay`. It searches the Claude project store, feeds each
JSONL record through the same neutral decoder used by the live runtime, and
returns sequenced `HarnessEventV1` events. The home directory is injectable for
tests and alternate deployments; the GUI never parses or locates these files.
