# Execute context bindings and output

Purpose: bind the full immutable server context to Rhai and persist a validated result.
Use this when: templates, namespace variables, prior output, snapshots, or schema errors.

Sacrum strictly renders script templates and snapshots the complete typed
PromptContext in `config.context` before dispatch. The daemon consumes
`run_step.context` without rendering data again or fetching mutable definitions.
Each attempt binds six object namespaces in a fresh Engine/Scope:

| Rhai variable | Contents |
|---|---|
| `task` | ID, title, description, level, tags, worktree, code refs, and present section lists |
| `execution` | Present previous output/handoff/duration, terminal attempt counts, nearest-first history |
| `inputs` | Caller-supplied input map; empty in normal dispatch today |
| `steps` | Latest completed named-step outputs in this TaskRun |
| `workflow` | Name, current step/goal, step count, and present output schema |
| `artifacts` | Project/task/TaskRun identities and preceding-execution `history` identity maps; no bodies |

JSON objects, arrays, strings, booleans and null retain their values. Integers
within Rhai's signed 64-bit range remain exact, including values above floating
point's exact integer range; larger JSON integers fail with a JSON pointer.
JSON floating-point values remain floating point. See [limits](limits.md).
Missing optional fields stay absent. Context strings, including template-looking
text, stay data. Namespace mutations are local to an attempt; only the returned
value is persisted. Previous/named outputs use this TaskRun's completed attempts
and snapshot schemas; history outputs remain stored text.

Given prior structured output `{"name":"example","quantity":3,"unit_price":12}`,
author this config without `input` or `context`:

```json
{
  "version": 1,
  "script": "#{ name: execution.previous_output.name, total: execution.previous_output.quantity * execution.previous_output.unit_price }",
  "output_schema": {
    "type": "object",
    "properties": {"name": {"type": "string"}, "total": {"type": "number"}},
    "required": ["name", "total"],
    "additionalProperties": false
  }
}
```

Returned JSON is `{"name":"example","total":36}`; quantity 4 produces total 48.
A consumer reads the number directly as `steps.transform.output.total`.
Use bracket access for names that are not identifiers: `steps["prepare-data"].output`.
Required missing template references fail before dispatch; absent native Rhai map
properties fail during evaluation rather than inventing values.

The returned value is converted to JSON and validated against `output_schema`.
Success persists that JSON through the existing completion path. Syntax,
evaluation, conversion, schema and limit errors fail the attempt with diagnostics.
Execute has no inference model, token, or cost metadata. Sacrum owns progression
and retries. The repository's `docs/testing.md` describes the isolated Docker demo
in `crates/daemon-acceptance/tests/features/execute.feature`.

## Related
[Settings](settings.md) · [Template context](../../../templating/context.md) ·
[Failure table](../../../debugging/failure-table.md)
