# structured_inference

A typed decision provider (TypeSafe, e.g. its Jev model), run by the `typesafe` [harness](../harness.md), answers a fixed set of questions about a state object and returns calibrated JSON.

- [Questions](questions.md): noul, choice and score questions and their criteria.
  Load when: writing `--questions`, choosing a question type, question IDs.
- [Writing questions](writing-questions.md): how to word instructions and criteria so the model answers well.
  Load when: drafting questions, answers look wrong or low-confidence, deciding how much reasoning a question can need.
- [Model limits](model-limits.md): what the decision model is known to get wrong (numbers, dates, lists, literal reading) and the workaround for each.
  Load when: a question touches counts, dates, lists or untrusted text; changing model version.
- [Routable fields](routable-fields.md): the output shape and which fields routes can read.
  Load when: routing on `.noul`, `.choice`, `.confidence`, `.probabilities.<opt>`, `.score`.
- [Practices](practices.md): shaping state, model pinning, size limits, thresholds, the gather-judge-decide pattern.
  Load when: designing a gate, state too large, choosing thresholds.
- [State templating](../../../templating/state.md): the strict `{{ dotted.path }}` grammar for `--state`.
  Load when: building state from prior outputs, `step_config_render_failed`, optional `?` references.
