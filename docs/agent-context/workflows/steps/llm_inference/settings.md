# llm_inference settings

Purpose: configure the model and request for an llm_inference step.
Use this when: the user names a model, or wants faster, deeper or cheaper runs.

## How it works
- The runtime is chosen by the step's [harness](../harness.md) (`claude` or
  `codex`). The settings below shape the request that runtime sends.
- `model`: any model the harness accepts. When `--provider` is also given, the
  CLI checks the pair. Do not hard-code model IDs; ask, or check `vtb step add --help`.
- `speed_tier`: `default` or `fast` (Codex priority tier / Claude fast mode).
- `reasoning_effort` (Codex only): `low`, `medium`, `high`, `xhigh`.
- `verbosity` (Codex only), `personality` (model-dependent), and
  `codex_model_provider` for a custom Codex upstream from `~/.codex/config.toml`.
- `agent_config.provider` (`anthropic`/`openai`) is the legacy runtime
  selector. With a harness set it is optional, but if present it must match.
- Harness CLIs authenticate themselves (`claude login`, `codex login`);
  Vertebrae stores no provider secrets.

## Doing it
`vtb step update <id> --harness codex --model <m> --speed-tier fast --reasoning-effort high`.
Or set the whole agent config at once with `--agent-config '<json>'`, which
replaces it; shortcut flags then overlay individual fields.

## Gotchas
- `--agent-config` drops fields you do not repeat (e.g. `disallowed_tools`); include them.
- `--provider` and `--model` do not set the harness.
- Speed tier and reasoning effort are independent settings.

## Related
[Harness](../harness.md) · [Guardrails](guardrails.md) · [Output schemas](output-schemas.md)
