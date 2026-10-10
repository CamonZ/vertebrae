# Loops

Purpose: send work back to an earlier step or workflow, with a bound and feedback.
Use this when: revise-until-good, retry, or escalate-after-N patterns.

## How it works
- A route may target an earlier step (intra) or workflow (inter) like any other target.
- `execution.step_visit_count` counts visits to the route step for the whole
  task, across TaskRuns, not only the current run.
- Use it for a bound: `{"ref":"execution.step_visit_count","op":"lte","value":2}`
  loops; its complement `gt 2` escalates or stops.

## Feedback via handoff
A loop-back handoff tells the earlier step why it is running again:
```json
"handoff": {"feedback": "{{ previous_output.issues }}",
            "attempt": "{{ execution.step_visit_count }}"}
```
The target prompt reads `{{ execution.handoff.feedback }}` and should guard it
with `{% if execution.handoff %}` so the first pass renders cleanly.

## Continuing the conversation
Without a `session` directive the loop-back starts a new conversation, so the
earlier step sees only its prompt and the handoff. Add `"session": {"mode": "resume"}`
to the loop-back rule to continue that step's conversation instead, so it keeps
its earlier turns ([session directives](sessions.md)).

## Gotchas
- Visit counts persist across runs; a task re-run later starts with the old count.
- Visit-count rules are not overlap-checked at save time (see [overlap checks](overlap-checks.md)).
- Every loop needs an exit path that ends in `finish` or `stop`.

## Related
[Handoff templating](../../../templating/handoffs.md) · [Session directives](sessions.md) · [Partitions](partitions.md)
