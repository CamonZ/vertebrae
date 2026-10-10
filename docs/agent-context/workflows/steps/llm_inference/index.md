# llm_inference

The step's harness (`claude` or `codex`) runs the step's rendered prompt in the task's working directory.

Each execution runs in a provider conversation. The step has no session
settings: it starts a new conversation unless the route decision that led to it
carries a `session` directive to resume or fork one.

- [Prompt templating](../../../templating/prompts.md): Liquid syntax and the variables a prompt can use.
  Load when: writing or debugging the prompt, `{{ task.* }}`, loops over sections, empty values.
- [Output schemas](output-schemas.md): structured JSON output, and Codex strict-mode rules.
  Load when: the step feeds a route, `--output-schema`, schema rejected by Codex, nullable fields.
- [Harness](../harness.md): selecting the `claude` or `codex` runtime for the step.
  Load when: "use Codex/Claude", `--harness`, a harness/provider conflict or unavailable-harness error.
- [Settings](settings.md): model, speed tier, reasoning effort, verbosity, `--agent-config`.
  Load when: model choice, fast mode, deeper reasoning, replacing the agent config.
- [Guardrails](guardrails.md): restricting what the agent may do (tools, permission mode, budget).
  Load when: "don't let it change code/push/comment", `disallowed_tools`, read-only review steps.
- [Session directives](../route/sessions.md): continuing or branching a conversation across steps.
  Load when: "keep the same session", "resume the implementer", parallel branches sharing context.
- [Templating context](../../../templating/context.md): everything available to interpolate.
  Load when: you need to know what data exists (previous output, handoff, other steps' outputs).
