# llm_inference sessions

Purpose: let several llm_inference steps of one TaskRun share a provider conversation.
Use this when: a later step should continue where an earlier step's agent left off
(e.g. implement, then fix review findings in the same conversation).

## How it works
- A step's `config.session` is `{name, mode}`. Without it, every dispatch is an
  independent conversation.
- `mode`:
  - `new`: start a new conversation and bind it to the name.
  - `resume`: continue the conversation bound to the name. When the TaskRun
    has no binding yet, the TaskRun fails with outcome `dispatch_failed` and
    reason `<name>`; no execution is created and the provider is never launched.
  - `resume_or_new`: resume the bound conversation, or start a new one when there is none.
- The binding for a name is the conversation of the TaskRun's most recent
  **completed** execution that used that name. Failed or unfinished executions
  never bind, and later `new` steps rebind the name.
- Names are scoped to one TaskRun: other runs, including other runs of the same
  task, never see them.
- A resume must use the same harness that created the conversation; otherwise
  the TaskRun fails with `dispatch_failed` and a reason naming the session, the
  bound harness and the step harness.
- If the provider rejects the resume (the conversation no longer exists), the
  execution fails with that reason; it does not silently start fresh.
- Names: non-blank, at most 255 bytes.

## Doing it
```bash
vtb step add "Implement" -w <wf> --harness claude --prompt "..." \
  --session-name impl --session-mode new
vtb step add "Address review" -w <wf> --harness claude --prompt "..." \
  --session-name impl --session-mode resume
vtb step update <step-id> --session-name impl --session-mode resume_or_new
vtb step update <step-id> --clear-session
```
`--session-name` and `--session-mode` are always given together. Updating
other fields keeps the stored session. `vtb step show` prints it as
`Session: <name> (<mode>)`; `--json` and workflow export carry it as
`config.session`.

## Gotchas
- Parallel steps (e.g. after a fan-out) must not resume the same name
  concurrently; give each branch its own name or serialize them.
- Use `resume_or_new` for a step that may be the first to run on a path
  (loops, optional earlier steps); use `resume` when a missing conversation is a bug.
- Only llm_inference steps accept session flags.

## Related
[Settings](settings.md) · [Harness](../harness.md) · [Running](../../../running/index.md)
