# Harness

Purpose: choose which runtime executes a daemon-run step.
Use this when: the user says "run this on Codex/Claude/TypeSafe", or a step fails to start its runtime.

## How it works
- Each step has an optional `harness`: `claude` (Claude Code), `codex`
  (Codex App Server) or `typesafe` (TypeSafe structured inference).
- It picks the runtime only. Model, provider and request settings stay in
  their own config (`agent_config` for llm_inference, `config` for
  structured_inference).
- Supported pairs: `claude` and `codex` run `llm_inference`; `typesafe` runs
  `structured_inference`. Backend-side steps (route, wait_children, stop,
  finish, human_input) ignore it.
- Omitted, the backend's default applies; old steps still fall back to
  `agent_config.provider` (`anthropic`/`openai`), and to Claude when that is unset too.
- `vtb step list/show` print `harness: server-default` when none is set.

## Doing it
`vtb step add "Review" -w <wf> --harness codex --model <m> ...`,
`vtb step update <id> --harness typesafe`, `vtb step update <id> --clear-harness`.
Prefer an explicit harness on new steps so the runtime is visible in `vtb step list`.

## Gotchas
Checked by the daemon when the step runs, not when it is saved:
- `step type 'structured_inference' is unsupported by the selected 'codex' harness` (or `claude`).
- `step harness 'typesafe' only supports step type 'structured_inference'`.
- `step harness 'codex' conflicts with agent_config.provider 'anthropic'`: the
  harness and a leftover provider disagree. Fix the provider or drop it.
- `selected '<h>' harness is unavailable`: the binary or key is missing on the
  daemon's machine (see [setup](../../setup/index.md)).

## Related
[llm_inference settings](llm_inference/settings.md) · [structured_inference](structured_inference/index.md) · [Step types](step-types.md)
