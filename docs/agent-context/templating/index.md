# Templating

Pick the guidance for the field containing the template; its resolution rules differ.

- [Context](context.md): every value available (task, execution, steps, workflow, artifacts) and its scope.
  Load when: "what variables can I use", `steps.<name>.output`, `execution.handoff`, `previous_output`, artifact IDs.
- [Prompts](prompts.md): llm_inference prompts use full Liquid; lenient.
  Load when: writing a prompt, loops/conditionals, a value rendered empty, objects printed as `%{...}`.
- [State](state.md): structured_inference state uses a closed `{{ dotted.path }}` grammar; strict.
  Load when: writing `--state`, `step_config_render_failed`, optional `?` references, JSON types.
- [Handoffs](handoffs.md): route handoffs use the same closed grammar over the route's small context.
  Load when: writing a route `handoff`, `route_handoff_template_invalid`, passing feedback to the next step.
- [Execute](../workflows/steps/execute/index.md): Rhai scripts are rendered strictly by Sacrum and the full canonical context is snapshotted as typed namespace variables in this TaskRun.
  Load when: execute script templates and native context bindings, `execution.previous_output`, `steps.<name>.output`, strict render failures.
- [Troubleshooting](troubleshooting.md): symptoms mapped to template failures.
  Load when: a rendered prompt/state looks wrong, or dispatch failed on a template.
