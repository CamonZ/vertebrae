# Recipe: conversational review gate

Purpose: collect one human answer, evaluate it, and send inadequate answers
back to the same conversational gate.
Use this when: a person must answer a question and the workflow can review
that answer before accepting it.

## Shape
1. `<gate>` (`human_input`): output has `outcome`, `answer`, and `rationale`.
2. `<triage>` (`route`): `rejected_premise` goes to stop; every other outcome
   goes to evaluation.
3. `<evaluate>` (`structured_inference`): sees only the question, human answer,
   and rationale. It returns `verdict`, `reasons`, and `guidance`.
4. `<verdict>` (`route`): `inadequate` loops to the gate with an object handoff
   containing `reasons` and `guidance`; otherwise the run finishes.

Every step except an `execute` step requires `--harness`, including route,
stop, and finish. Build this with a `vtb` binary from current `master`; older
installed binaries may lack the human-input authoring flags.

- [Configuration](configuration.md): gate schema, inference questions, state, role, and rendered question.
  Load when: adapting the answer schema, evaluator inputs, or loop-back template.
- [Route decisions](routes.md): triage and verdict JSON with concrete target IDs.
  Load when: route rules, handoff structure, predecessor schema validation.
- [Authoring commands](authoring.md): create the workflow in an order the backend can validate.
  Load when: copying the runnable authoring sequence.
- [Resolution](resolution.md): exercise the gate from the CLI or GUI and verify loop-back.
  Load when: manual end-to-end testing, waiting execution IDs, schema failures.

## Related
[human_input](../../workflows/steps/human_input.md) · [Route loops](../../workflows/steps/route/loops.md) · [structured_inference questions](../../workflows/steps/structured_inference/questions.md)
