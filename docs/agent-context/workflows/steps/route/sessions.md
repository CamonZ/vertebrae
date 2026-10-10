# Session directives

Purpose: choose how the step a route sends work to enters a provider conversation.
Use this when: a loop should continue the earlier step's conversation, a later
step should pick up where another left off, or parallel branches need their own copy.

## Shape
A rule or the default decision may set `session` beside `transition` and `handoff`:
```json
{"id": "needs_changes",
 "when": {"ref": "previous_output.verdict", "op": "eq", "value": "needs_changes"},
 "transition": {"type": "intra_workflow", "step_id": "<implement-uuid>"},
 "handoff": {"feedback": "{{ previous_output.issues }}"},
 "session": {"mode": "resume"}}
```
- `mode`: `new` starts a fresh conversation; `resume` continues one as its next
  turn; `fork` starts a new conversation branched from one's latest turn,
  leaving the original untouched.
- `step_id`: the step whose conversation is resumed or forked. Defaults to the
  destination; not allowed with `new`.

## How it works
- Every llm_inference execution runs in a conversation. Entering without a
  directive (the first step, a linear transition, a decision without
  `session`) starts a new one, so each execution records a native session id.
- A step's conversation is the one its latest completed execution in this
  TaskRun belongs to; resume continues from that conversation's latest turn,
  whichever step added it. If A starts and B resumes A, resuming A later
  continues after B's turn.
- Only completed executions of the current TaskRun count: other runs and
  failed attempts are never resumed.
- Resume and fork stay on one harness: the destination and `step_id` must be
  llm_inference steps of this workflow on the same harness.
- A retry of a failed step enters its conversation the same way the failed
  attempt did.

## Doing it
Save with `vtb step update <route> --route-config "$(cat route.json)"`. The
backend rejects unknown keys or modes, `step_id` with `new`, a directive whose
destination is not an `intra_workflow` llm_inference step, and a `step_id`
outside this workflow, not llm_inference, or on another harness, with the
`$.rules[<i>].session` or `$.default.session` path. `vtb step show <route>`
lists each decision's directive under `Route Sessions:`.

## Gotchas
- Nothing resumable fails rather than starting fresh: a step with no completed
  execution in the run fails dispatch (`dispatch_failed`), and a provider that
  no longer has the conversation fails the execution.
- One conversation never runs two turns at once. Parallel branches use `fork`,
  not concurrent `resume`s of the same conversation.
- In an exported bundle the directive's step is `session.step_ref`; import
  resolves it back to `session.step_id`.

## Related
[Envelope](envelope.md) · [Loops](loops.md) · [Failure table](../../../debugging/failure-table.md)
