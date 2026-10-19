# human_input

Purpose: park a TaskRun until a person supplies validated input.
Use this when: the user asks for a manual approval, answer, or review gate.

## How it works
Sacrum creates a waiting StepExecution instead of dispatching the step. Its
rendered config carries the `role`, the rendered `question`, the `artifact`
logical name, and the `outputSchema`. Attach an artifact with that logical name
to that exact waiting execution; its JSON body becomes the step output and the
same TaskRun resumes.

A gate is resolvable only with both an artifact name and a schema; without them
the run waits, but a client cannot know what to submit.

## Authoring
Create and update gates with the dedicated flags:

```sh
vtb step add "Answer question" -w <workflow> --harness claude \
  --step-type human_input \
  --role 'You are a careful reviewer answering a question for a teammate.' \
  --question 'Answer: {{ task.title }}' \
  --artifact answer \
  --output-schema '{"type":"object","required":["outcome","answer","rationale"],"properties":{"outcome":{"type":"string","enum":["resolved","rejected_premise"],"description":"Is the question valid, or does it rest on a false premise?"},"answer":{"type":"string","description":"What is the answer?"},"rationale":{"type":"string","description":"Why is that the answer?"}}}'
vtb step update <step> --question @question.liquid \
  --artifact answer --output-schema @answer.schema.json
```

`--role` is stored verbatim and never rendered. It tells the resolving agent how
to behave and what kind of decision this is; without it the chat uses a generic
role. The protocol rules the chat always follows win over the role, so a role
cannot authorize state changes or reveal how the gate works.

`--question` is rendered when the run parks, so it can show task data and
`execution.handoff`. It frames what must be answered and why. `--clear-role`
and `--clear-question` remove them.

Each top-level `properties` entry of the output schema is a field the chat must
collect, and its `description` is the question to ask for that field. Give
every property a description: the chat lists the fields in schema order with
their required/optional status, type or allowed values, and description.

Exactly one transition may leave the gate, and a route must follow it for the
GUI chat to report Accepted.

## Resolve from the CLI
Find the waiting execution in `vtb show <task>`, then attach the artifact:

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
step. The chat opens with the gate's role and rendered question, asks for each
schema field in turn, drafts the artifact, and is permissioned to run only the
corresponding `vtb artifact add` command without an additional prompt.
Reopening Resolve reopens the same chat.

## Loop back
A route after the gate can send an inadequate answer back to it. The route
handoff becomes `execution.handoff` on the new gate execution, and the gate's
question is re-rendered with that handoff and `step_visit_count`. The
existing bound chat rebinds to the new execution, receives one evaluation turn
with the rejection verdict, and shows `Rejected · attempt n`.

For a complete gate, triage, evaluator, and loop-back workflow, see
[Conversational review gate](../../recipes/conversational-review-gate/index.md).

## Related
[Artifacts](../../artifacts.md) · [Route loops](route/loops.md) · [Step types](step-types.md)
