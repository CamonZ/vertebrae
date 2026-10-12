# Recipe: parent-child delivery

Purpose: run a parent's children to completion, then evaluate the parent.
Use this when: the user wants a parent task (e.g. an epic) delivered by automation.

## Shape
1. **Child workflow** (assigned to each child): `<do the work>` -> `<verify>` ->
   `finish`. Give each child its own `--worktree` when they change code.
2. **Parent workflow**:
   - a `wait_children` step, with a schema and `persistence_options` if you
     want to keep the snapshot;
   - a structured_inference step over `{{ steps.<wait step>.output }}`;
   - a route: done -> `finish`; needs attention -> a workflow ending in `stop`.

## Children that start from the parent's context
To have each child continue from what the parent already worked out, give the
parent an llm_inference `plan` step before `wait_children` and fork its
conversation into every child:
```bash
vtb step add "Run children" -w <parent-wf> --harness claude --step-type wait_children \
  --children-session fork:<plan-step> --transition-to <evaluate-step>
```
Each child workflow's first step must be llm_inference on the plan step's
harness; it starts in its own fork, so siblings never share turns. To have the
parent's next llm_inference step pick up its own plan conversation after the
children, put `--transition-session <evaluate-step>=resume:<plan-step>` on the
wait step's edge. Claude children need the parent's working directory to find
its session, so skip per-child worktrees when forking on Claude (Codex is not
affected).

## Preparing (with the user's go-ahead)
- Create the children with `--parent <parent>`, `--workflow <child workflow>`,
  and `--depends-on` where order matters.
- Start one TaskRun on the parent, with `--max-concurrency` if needed.

## What happens
Unblocked children start; blocked ones start as their blockers complete; the
parent wakes when all are complete, then evaluates and routes.

## Gotchas
- Any child without a workflow fails `wait_children` (`child_missing_workflow`).
- With `--children-session`, a child whose first step is not llm_inference
  fails its run (`dispatch_failed`, Sacrum logs
  `session_requires_llm_inference`) and keeps the parent waiting.
- A child whose workflow never reaches `finish` keeps the parent waiting.
- The snapshot is taken when the parent enters `wait_children`; check live
  child state if freshness matters.

## Related
[wait_children](../workflows/steps/wait_children.md) · [Parent/child](../tasks/relationships/parent-child.md) · [Concurrency](../running/concurrency.md)
