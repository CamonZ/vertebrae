# Recipe: multi-workflow factory

Purpose: split a long process into stages that are easy to read and change.
Use this when: a process has stages with different outcomes.

## Shape
- One workflow per stage, grouped with `--factory-name`. Each stage ends in at
  most one decision (a route), or in `finish` for the last stage.
- Typical stages: `<intake>` (gather and triage), `<work>`, one or more
  `<gate>` stages ([decision gate](decision-gate.md)), and `<outcome>`.
- A route that only leaves its workflow uses workflow transitions and has no
  step transitions. Every other step has exactly one outgoing step transition.
- Author in order: workflows, workflow transitions, steps, step transitions,
  route configs ([authoring order](../workflows/authoring-order.md)).

## Why it works
- One TaskRun spans all the workflows, so later steps can read
  `steps.<name>.output` from earlier stages.
- Each stage's decision is visible in one route config.

## Outcome artifact
- Give the `<outcome>` step an output schema and `persistence_options` with a
  logical name; read it later with `vtb artifact lookup`.
- Use sentinel values for gates that did not run so every outcome has the same shape.
- If an external action can be refused, fall back and still record what was composed.

## Related
[Workflow concepts](../workflows/concepts.md) · [Transitions](../workflows/transitions.md) · [Artifacts](../artifacts.md) · [Output schemas](../workflows/steps/llm_inference/output-schemas.md)
