# Cross-run session directives

Purpose: continue or fork a conversation in another workflow, after a stop
step, or in child runs.
Use this when: the next workflow should pick up the implementer's
conversation, work resumes after a pause with its context, or children should
start from the parent's context.

## How it works
- **inter_workflow decision**: the run stays the same, so the next workflow's
  entry step may resume or fork a conversation of the route's own workflow. The
  entry step is chosen at route time, so `step_id` is required and names an
  llm_inference step of the route's workflow:
  ```json
  {"id": "handoff",
   "when": {"ref": "previous_output.verdict", "op": "eq", "value": "ready"},
   "transition": {"type": "inter_workflow", "workflow_id": "<review-wf-uuid>"},
   "session": {"mode": "resume", "step_id": "<implement-uuid>"}}
  ```
  An entry step that is not llm_inference fails the run (`dispatch_failed`,
  Sacrum logs `session_requires_llm_inference`).
- **Stop step**: `vtb step update <pause> --transition-session <revise>=resume:<draft>`.
  The next TaskRun bypasses the stop and `revise` resumes `draft`'s
  conversation from the run that stopped there; if that run has no completed
  `draft` turn, it fails with `session_not_found`.
- **Children**: `vtb step add "Run children" ... --step-type wait_children --children-session fork:<plan>`.
  Every child's first step forks `plan`'s conversation in the parent run.
  Children only fork (never resume), so no two runs take turns in one
  conversation; siblings and the parent's later turns are unaffected.
  Claude finds sessions by working directory, so a Claude child must run in
  the parent's directory (no per-child worktree) to fork it; Codex threads are
  not tied to a directory.
- A retry of a failed step enters its conversation the same way the failed
  attempt did.

## Doing it
`--children-session fork:<step>` on `vtb step add/update` sets a wait_children
step's session (`--clear-children-session` removes it); `vtb step show` lists
it as `Children Session:`. Saving rejects an `inter_workflow` `resume`/`fork`
without `step_id` (`$.rules[<i>].session.step_id: is required with mode resume
or fork`), a wait_children session that is not `fork` (`$.session.mode`) or has
no step (`$.session.step_id`), and a step outside the owning workflow or not
llm_inference (`must be an llm_inference step in this workflow`).

## Gotchas
- Each carrier searches only its linked run: the same run, the run that
  stopped at the boundary, or the parent run. A step with no completed turn
  there fails with `session_not_found`, never a fresh conversation.
- The destination's harness and step type are checked only at dispatch for
  these carriers, so a mismatch surfaces as a failed run, not a save error.

## Related
[Session directives](sessions.md) · [stop](../stop.md) · [wait_children](../wait_children.md) · [Transitions](../../transitions.md) · [Failure table](../../../debugging/failure-table.md)
