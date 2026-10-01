# execute settings

Purpose: configure a deterministic Rhai transformation.
Use this when: creating or updating execute, script/schema flags, or definition reads.

## How it works

- Execute runs in the daemon without a provider harness.
- Its definition contains `version: 1`, a non-empty `script`, and a required
  `output_schema` JSON Schema object. Inference-only schema restrictions do not
  apply. Script templates are rendered by the backend before dispatch; see
  [context bindings and output](input-output.md).
- `context` is a server-written execution snapshot, null on definitions. It is
  separate from the mutable execution metadata field `StepExecution.context`.
- Execute has exactly one outgoing transition; use a subsequent route for
  branching and finish for task completion ([transitions](../../transitions.md)).

## Doing it

```bash
vtb step add "Transform" -w <workflow-id> --step-type execute \
  --script @transform.rhai --output-schema '{"type":"object"}'
vtb step update <step-id> --script @transform.rhai
vtb step update <step-id> --output-schema '{"type":"number"}'
vtb step show <step-id>
```

`--script` accepts inline Rhai or `@path` to read a UTF-8 file. Creation requires
both script and output schema and sets `version=1`. `vtb --json step show <step-id>`
preserves the definition's config; runtime context is stored on the execution.

## Gotchas

- Updates preserve omitted config fields; the required output schema cannot be
  cleared. Script syntax and result validity are checked when the step runs.
- Do not pass `--harness`, prompt, provider, model, agent, or skill flags for execute.
- Do not author `context` or obsolete `input`; the backend rejects both.
- The GUI reads execute configs but has no script editor; use the CLI to author them.

## Related

[Context bindings and output](input-output.md) · [Limits and cancellation](limits.md) ·
[Transitions](../../transitions.md)
