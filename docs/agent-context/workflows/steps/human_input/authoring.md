# Authoring human_input

Purpose: configure what a gate asks and the response it accepts.
Use this when: creating or updating a human_input step.

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

## Related
[human_input](index.md) · [Resolution](resolution.md) · [Gate chats](gui.md)
