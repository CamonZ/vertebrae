# human_input

Purpose: park a TaskRun until a person supplies validated input.
Use this when: the user asks for a manual approval, answer, or review gate.

## How it works
Sacrum creates a waiting StepExecution instead of dispatching the step. The
execution's rendered config carries `instructions`, the `artifact` logical
name, and the `outputSchema`. Attach an artifact with that logical name to
that exact waiting execution; its JSON body becomes the step output and the
same TaskRun resumes.

A gate is resolvable when it has both an artifact name and a schema. Without
them, the run still waits, but a client cannot know what to submit or validate.

## Authoring
Create and update gates with the dedicated flags:

```sh
vtb step add "Answer question" -w <workflow> --harness claude \
  --step-type human_input \
  --instructions 'Answer: {{ task.title }}' \
  --artifact answer \
  --output-schema '{"type":"object","required":["outcome","answer","rationale"],"properties":{"outcome":{"type":"string","enum":["resolved","rejected_premise"]},"answer":{"type":"string"},"rationale":{"type":"string"}}}'
vtb step update <step> --instructions @instructions.liquid \
  --artifact answer --output-schema @answer.schema.json
```

`--instructions` is rendered when the run parks, so it can show task data and
`execution.handoff`. Exactly one step transition may leave the gate. The GUI
chat shows Accepted only after that transition moves the run onward.

## Resolve from the CLI
Find the waiting execution in `vtb show <task>` or the run trace, then attach
the configured artifact:

```sh
vtb artifact add answer.json --subject-type step_execution \
  --subject-id <waiting-execution> --logical-name answer \
  --body '{"outcome":"resolved","answer":"Yes","rationale":"The premise is valid."}'
```

The body must be JSON and satisfy the schema. A failed attach stores nothing
and leaves the gate waiting. Sacrum reports `invalid_human_input_json` for
non-JSON, `invalid_human_input` with the violating JSON path such as
`#/answer`, and `human_input_execution_not_waiting` when the execution is no
longer the run's current waiting gate.

## Resolve from the GUI
The GUI's Resolve action on a waiting gate opens a chat bound to the run and
step. The chat presents the rendered instructions, drafts the artifact, and is
permissioned to run only the corresponding `vtb artifact add` command without
an additional prompt. Reopening Resolve reopens the same chat.

## Loop back
A route after the gate can send an inadequate answer back to it. The route
handoff becomes `execution.handoff` on the new gate execution, and the gate's
instructions are re-rendered with that handoff and `step_visit_count`. The
existing bound chat rebinds to the new execution, receives one evaluation turn
with the rejection verdict, and shows `Rejected · attempt n`.

For a complete gate, triage, evaluator, and loop-back workflow, see
[Conversational review gate](../../recipes/conversational-review-gate/index.md).

## Edge rules
Exactly one outgoing transition, like other non-route steps. A route must
follow the gate for the GUI chat to report Accepted.

## Related
[Artifacts](../../artifacts.md) · [Route loops](route/loops.md) · [Step types](step-types.md)
