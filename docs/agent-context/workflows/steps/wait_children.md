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

## Doing it
`vtb step add "Run children" -w <wf> --harness claude --step-type wait_children --transition-to <next>`.
It may take an output schema and `persistence_options` to store the snapshot as an artifact.

## Gotchas
- A child that never finishes (failed run, dead-end workflow, missing `finish`)
  keeps the parent waiting. Inspect children with `vtb list --parent <id>`.
- The snapshot is taken on entry; for fresh state after waking, read it again
  in a later step or inspect the children.

## Related
[Parent/child](../../tasks/relationships/parent-child.md) · [Concurrency](../../running/concurrency.md)
