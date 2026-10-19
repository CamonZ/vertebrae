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

- [Authoring](authoring.md): role, question, artifact and output schema flags, and field questions.
  Load when: creating or updating a gate, `--role`, `--question`, `--artifact`, `--output-schema`, field descriptions.
- [Resolution](resolution.md): attaching the artifact, or answering a draftable gate field by field with `vtb gate`.
  Load when: resolving a gate from the CLI, `vtb gate set/show/submit`, `draft_incomplete`, `unknown_draft_field`, `invalid_human_input`.
- [Gate chats](gui.md): Resolve in the GUI, draft progress, steering, Answer directly, and loop-back.
  Load when: the GUI's Resolve chat, a stalled gate chat, `Rejected · attempt n`, a gate chat whose session ended.

## Related
[Artifacts](../../../artifacts.md) · [Route loops](../route/loops.md) · [Step types](../step-types.md)
