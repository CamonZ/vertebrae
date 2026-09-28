# Recipes

Generic patterns to adapt. Names in angle brackets are placeholders; IDs are
omitted. Design the concrete workflow with the user.

- [Decision gate](decision-gate.md): gather facts with an LLM, judge them with structured_inference, route on thresholds.
  Load when: automating a judgment (triage, review, approval), mixing llm_inference + structured_inference + a route.
- [Multi-workflow factory](multi-workflow-factory.md): split a process into workflows that each end in at most one decision, then record one outcome.
  Load when: designing a factory, stages with different outcomes, a final outcome artifact.
- [Parent-child delivery](parent-child-delivery.md): run a parent's children to completion with `wait_children`, then evaluate.
  Load when: parent/child automation, wait_children in practice, delivering an epic's tickets.
