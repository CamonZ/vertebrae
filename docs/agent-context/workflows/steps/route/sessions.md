# Session directives

Purpose: choose how an llm_inference step enters a provider conversation, from
a route decision, a step transition, or a wait_children step.
Use this when: a loop should continue the earlier step's conversation, a later
step should pick up where another left off, or parallel branches or child runs
need their own copy.

## Route decision, step transition or wait_children
The same directive has three carriers:
- **Route decision**: the continuation depends on the route's outcome (resume
  on `needs_changes`, start fresh on `approved`).
- **Step transition**: a fixed continuation, such as A -> B, two llm_inference
  steps with different prompts in one conversation. No route step is needed.
  See [transitions](../../transitions.md).
- **wait_children step**: forks a parent conversation into every child run
  ([cross-run sessions](cross-run-sessions.md)).

Transitions leaving a route step cannot carry a directive; put it on the
route's decisions instead.

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

On a step transition the same directive is authored per edge:
```bash
vtb step update <draft> --transition-to <revise> --transition-session <revise>=resume
vtb step update <draft> --transition-session <revise>=fork:<other-step>
```

## How it works
- Every llm_inference execution runs in a conversation. Entering without a
  directive (the first step, a transition or decision without `session`)
  starts a new one, so each execution records a native session id.
- A step's conversation is the one its latest completed execution in this
  TaskRun belongs to; resume continues from that conversation's latest turn,
  whichever step added it. If A starts and B resumes A, resuming A later
  continues after B's turn.
- Only completed executions of the directly linked run count: this TaskRun,
  or for a stop step's edge the run that stopped there, or for children the
  parent run ([cross-run sessions](cross-run-sessions.md)). Failed attempts
  and other runs are never resumed.
- Resume and fork stay on one harness: the destination and `step_id` must be
  llm_inference steps on the same harness (checked on save within a workflow,
  at dispatch across workflows or runs).

## Doing it
Save a route's directives with `vtb step update <route> --route-config "$(cat route.json)"`
and an edge's with `--transition-session` (above). The backend rejects unknown
keys or modes, `step_id` with `new`, an `intra_workflow` destination that is
not llm_inference, and a `step_id` outside this workflow, not llm_inference, or
on another harness, at `$.rules[<i>].session`/`$.default.session` (routes) or
`$.session` plus the endpoints (edges). `vtb step show` lists them under
`Route Sessions:` and `Transition Sessions:`.

## Gotchas
- Nothing resumable fails rather than starting fresh: a step with no completed
  execution in the run fails dispatch (`dispatch_failed`), and a provider that
  no longer has the conversation fails the execution.
- One conversation never runs two turns at once. Parallel branches use `fork`,
  not concurrent `resume`s of the same conversation.
- In an exported bundle the directive's step is `session.step_ref` (route
  config, `step_edges[].session`, wait_children `config.session`); import
  resolves it to `session.step_id`. A persisted `session.step_id`, or a
  `step_ref` outside the owning workflow, is rejected.

## Related
[Envelope](envelope.md) · [Loops](loops.md) · [Transitions](../../transitions.md) · [stop](../stop.md) · [wait_children](../wait_children.md) · [Failure table](../../../debugging/failure-table.md)
