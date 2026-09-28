# Guardrails

Purpose: limit what an llm_inference agent can do.
Use this when: a step must only read and report (reviews, triage), or must not reach external systems.

## Levers
- `agent_config.disallowed_tools`: tool deny list. On the `codex` harness, entries of the
  form `Bash(<command prefix>*)` become prefix deny rules
  (`Bash(git push*)` blocks `git push ...`). Other entries are not mapped for Codex.
- `agent_config.allowed_tools` (`claude` harness): allow list.
- `agent_config.permission_mode`: on `codex`, `plan` and `dontAsk` map to
  workspace permissions with no approvals; `bypassPermissions` gives full
  access. There is no per-step read-only mode for Codex: `plan` still allows workspace writes.
- `max_budget_usd` caps spend where the harness supports it.
- The prompt: state the boundary explicitly ("do not modify files; report findings only").

## Doing it
A read-only review step on the `codex` harness: deny the mutating commands you care about
(`Bash(git commit*)`, `Bash(git push*)`, `Bash(git reset*)`, `Bash(gh pr merge*)`,
`Bash(gh pr comment*)`, `Bash(gh api*)`, ...) and say so in the prompt.
Keep external side effects (posting a review) in a separate, clearly named step.

## Gotchas
- Prefix rules are best effort: a determined agent can reach the same effect
  another way (another binary, a script). Treat them as guardrails, not a sandbox.
- Setting `--agent-config` replaces the deny list; re-include it.

## Related
[Settings](settings.md) · [Permissions](../../../permissions.md)
