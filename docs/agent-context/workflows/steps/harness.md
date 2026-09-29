# Harness

Purpose: choose which runtime executes a daemon-run step.
Use this when: the user says "run this on Codex/Claude/TypeSafe", or a step fails to start its runtime.

## How it works
- Each step has a `harness`: `claude` (Claude Code), `codex`
  (Codex App Server) or `typesafe` (TypeSafe structured inference).
- It picks the runtime only. Model, provider and request settings stay in
  their own config (`agent_config` for llm_inference, `config` for
  structured_inference).
- Supported pairs: `claude` and `codex` run `llm_inference`; `typesafe` runs
  `structured_inference`. Backend-side steps (route, wait_children, stop,
  finish, human_input) ignore it.
- The provider must run on the step's harness: `anthropic` → `claude`,
  `openai` → `codex`, a custom `[providers.<id>]` → its configured harness.

## Doing it
`vtb step add "Review" -w <wf> --harness codex --model <m> ...` (`--harness` is
required), `vtb step update <id> --harness typesafe`. `vtb step update` also
requires `--harness` whenever it sets the provider. A harness can be changed but
not cleared.

## Gotchas
Rejected by the CLI when the step is saved:
- `--harness is required when setting the provider`.
- `provider 'anthropic' runs on the claude harness, but the step harness is codex; pass --harness claude`.

Checked by the daemon when the step runs, not when it is saved:
- `step type 'structured_inference' is unsupported by the selected 'codex' harness` (or `claude`).
- `step harness 'typesafe' only supports step type 'structured_inference'`.
- `step harness 'codex' conflicts with agent_config.provider 'anthropic', which runs on the 'claude' harness`:
  the harness and the provider disagree. Fix one of them.
- `provider '<id>' is not configured on this machine`: the custom provider is
  missing from the daemon machine's config.toml ([config](../../setup/config.md)).
- `selected '<h>' harness is unavailable`: the binary or key is missing on the
  daemon's machine (see [setup](../../setup/index.md)).

## Related
[llm_inference settings](llm_inference/settings.md) · [structured_inference](structured_inference/index.md) · [Step types](step-types.md)
