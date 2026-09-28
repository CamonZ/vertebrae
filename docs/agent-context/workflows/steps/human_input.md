# human_input

Purpose: a step where the workflow waits for a person.
Use this when: the user asks for a manual approval or review gate.

## Current state
The backend pauses at a human_input step instead of dispatching it, but there is
no client path yet to submit the human's input and resume. Do not design
workflows that depend on it as a working approval gate.

## Alternatives today
- A `stop` step before the gated work: a person reviews, then starts a new
  TaskRun (see [stop](stop.md)).
- A route that sends low-confidence cases to a workflow ending in `stop`, so
  only uncertain cases wait for a person.
- Record the decision the human needs as an [artifact](../../artifacts.md).

## Edge rules
Exactly one outgoing transition, like other non-route steps.

## Related
[stop](stop.md) · [Step types](step-types.md)
