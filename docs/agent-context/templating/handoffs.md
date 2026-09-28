# Handoff templating

Purpose: pass structured data from a route to the next step.
Use this when: writing a rule's or default's `handoff`.

## How it works
- A handoff is a JSON object; strings may contain `{{ dotted.path }}`
  references with the same rules as [state](state.md): whole-string keeps type,
  embedded must be scalar, `?` makes a reference optional (renders `null`).
- The context is only the route's: `previous_output.<path>`, `task.level`,
  `task.tags`, `execution.step_visit_count`.
- Output references are validated when the route is saved, against every
  predecessor's output schema.
- The receiving step reads it as `execution.handoff.<key>` (prompts, state).
  `{}` means no handoff.

## Uses
- Forward context: carry the decision and the evidence it rested on, e.g.
  `{"action": "request_changes", "assessment": "relevant", "risk": "{{ previous_output.risk.score }}"}`.
- Loop-back feedback: when routing back to an earlier step, pass what was
  wrong so the retry can fix it (see [loops](../workflows/steps/route/loops.md)).
- Constants per branch: literal values tell the next step which branch fired.

## Gotchas
- A handoff reaches only the next dispatched step; persist anything needed later as an artifact.
- The route has no access to `steps.*`; reshape data in the predecessor's output schema.

## Related
[Route](../workflows/steps/route/index.md) · [Context](context.md)
