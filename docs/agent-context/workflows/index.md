# Workflows

How work moves: workflows group steps, transitions connect them, step types decide who acts.

- [Concepts](concepts.md): workflow, factory, entry step, and "one decision per workflow boundary".
  Load when: explaining workflows, designing a multi-workflow factory, `vtb workflow add/list/show`.
- [Transitions](transitions.md): step transitions vs workflow transitions, edge rules per step type.
  Load when: "connect these steps", "missing transition", `multiple_outgoing_transitions`, `no_outgoing_transitions`, entry step.
- [Authoring order](authoring-order.md): the sequence for building a workflow graph end to end.
  Load when: building a new workflow or factory from scratch.
- [Steps](steps/index.md): step types and per-type configuration.
  Load when: adding or configuring a step, llm_inference, structured_inference, execute, Rhai, route, wait_children, stop, finish, human_input.
