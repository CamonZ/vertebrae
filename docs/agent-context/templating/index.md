# Templating

Three places interpolate data, with two different engines. Pick by where the template lives.

- [Context](context.md): every value available (task, execution, steps, workflow, artifacts) and its scope.
  Load when: "what variables can I use", `steps.<name>.output`, `execution.handoff`, `previous_output`, artifact IDs.
- [Prompts](prompts.md): llm_inference prompts use full Liquid; lenient.
  Load when: writing a prompt, loops/conditionals, a value rendered empty, objects printed as `%{...}`.
- [State](state.md): structured_inference state uses a closed `{{ dotted.path }}` grammar; strict.
  Load when: writing `--state`, `step_config_render_failed`, optional `?` references, JSON types.
- [Handoffs](handoffs.md): route handoffs use the same closed grammar over the route's small context.
  Load when: writing a route `handoff`, `route_handoff_template_invalid`, passing feedback to the next step.
- [Troubleshooting](troubleshooting.md): symptoms mapped to causes across all three.
  Load when: a rendered prompt/state looks wrong, or dispatch failed on a template.
