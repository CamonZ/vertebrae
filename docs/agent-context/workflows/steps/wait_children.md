# wait_children

Purpose: orchestrate a task's direct children from the parent's workflow.
Use this when: an epic or ticket should run its children and continue after them.

## How it works
- On entry with no children: completes immediately and follows its one edge.
- With children: every direct child must have a workflow
  (else `child_missing_workflow`). The backend creates a child TaskRun for each
  incomplete child, starts those without incomplete blockers, records a
  `waiting` execution, and parks the parent run in `waiting`.
- Blocked children start automatically once their blockers complete (see
  [dependencies](../../tasks/relationships/dependencies.md)).
- Each time a child completes, the backend checks the parent: it wakes when every
  direct child is completed and none has a waiting execution (parked). The
  parent then follows its single outgoing edge.
- Output is a JSON snapshot, `snapshot_type: "wait_children_status"`, with
  `parent`, `counts` (direct and descendant done/in_flight/blocked/parked),
  `direct_children` and `descendants` (id, title, level, workflow, step,
  status, state: done|in_flight|blocked|parked). A following route or
  structured_inference step can read it as `previous_output`.
- Child runs share the root run's `max_concurrency` and daemon.
- Children start new provider conversations unless the step carries a
  `session` (below).

## Children forking the parent conversation
`config.session` (`{"mode": "fork", "step_id": "<step>"}`, authored with
`--children-session fork:<step>`) gives every child run the step creates a fork
of `<step>`'s conversation in the parent run; `<step>` is an llm_inference step
of the parent's workflow. Each child workflow's first step enters with that
fork, so it starts from the parent's context in its own conversation.
- Fork only: children never resume the parent's conversation, so no two runs
  take turns in one provider session. Siblings fork independently, and the
  parent's later turns (for example a resume over the edge leaving this step)
  are unaffected.
- It applies to every child; per-child selection is not supported.
- A child whose first step is not llm_inference fails its run with
  `dispatch_failed` (Sacrum logs `session_requires_llm_inference`); one on
  another harness fails with `session_harness_mismatch`; a parent with no
  completed turn for `<step>` fails children with `session_not_found`. A failed
  child keeps the parent waiting.
- Claude stores sessions per working directory: a Claude child forks only a
  parent conversation it can find from its own directory, so keep children in
  the parent's checkout rather than their own worktree. Codex threads are not
  scoped by directory.
- On save, `resume`, `new` or a missing step is rejected
  (`$.session.mode: must be fork`, `$.session.step_id: is required`), and a step
  outside the workflow or not llm_inference with
  `$.session.step_id: must be an llm_inference step in this workflow`.

## Doing it
`vtb step add "Run children" -w <wf> --harness claude --step-type wait_children --transition-to <next>`.
It may take an output schema and `persistence_options` to store the snapshot as an artifact.
Add `--children-session fork:<plan-step>` to have the children fork the
parent's `plan` conversation; `vtb step update <wait> --clear-children-session`
removes it. `vtb step show` lists it as `Children Session: fork step <id>`.

## Gotchas
- A child that never finishes (failed run, dead-end workflow, missing `finish`)
  keeps the parent waiting. Inspect children with `vtb list --parent <id>`.
- The snapshot is taken on entry; for fresh state after waking, read it again
  in a later step or inspect the children.

## Related
[Parent/child](../../tasks/relationships/parent-child.md) · [Concurrency](../../running/concurrency.md) · [Session directives](route/sessions.md)
