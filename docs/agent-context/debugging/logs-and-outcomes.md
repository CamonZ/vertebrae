# Logs and outcomes

Purpose: gather evidence about a run.
Use this when: diagnosing, or answering "what happened".

## Where to look
- `vtb show <task>`: current workflow/step and run state; `vtb --json show`
  adds `run_history` (each TaskRun's id, status, start/end) and `run_controls`
  (runnable/stoppable and why not).
- Artifacts: `vtb artifact list --task-id <task>` then `vtb artifact show <id>`,
  the most reliable record of what each step produced.
- The GUI run/trace view: step executions, their outputs and session logs.
- Daemon log (macOS): `~/Library/Logs/vertebrae/daemon.log`, for provider
  errors, harness start failures, auth problems. Read it; never paste secrets from it.

## Doing it
Start from the failing step: its type tells you who failed. Daemon-executed
steps (llm_inference, structured_inference, execute) leave traces in the daemon log;
Backend-side steps (route, wait_children, stop, finish) fail with a coded reason.
Execute persists validated JSON on success and a diagnostic on failure, without
inference model/token/cost metadata or a provider session event stream. Inspect
its immutable execution `config.context` snapshot (separate from audit metadata) for the rendered script and complete context/schema.

## Related
[Failure table](failure-table.md) · [Artifacts](../artifacts.md)
