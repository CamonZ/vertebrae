# route

A backend-side step that evaluates a deterministic `route_config` and moves the task to one target, optionally with a handoff. No prompt, no daemon.

- [Envelope](envelope.md): the V1 config shape, references, operators, targets.
  Load when: writing a route_config from scratch, `route_config_invalid`, `route_reference_unknown`, `route_target_invalid`.
- [Partitions](partitions.md): designing rules that match exactly one case, and when a default is required.
  Load when: rule design, thresholds, `route_no_match`, `route_ambiguous_match`, "does this leave a blind spot".
- [Overlap checks](overlap-checks.md): what the backend proves when you save and what it leaves to runtime.
  Load when: `route_config_ambiguous`, `route_config_uncovered`, save accepted but run failed.
- [Loops](loops.md): routing back to an earlier step or workflow, visit counts, feedback.
  Load when: retry/revise loops, `execution.step_visit_count`, "send it back with feedback".
- [Handoff templating](../../../templating/handoffs.md): passing data to the next step.
  Load when: `handoff`, `execution.handoff` in prompts, `route_handoff_template_invalid`.
