# State templating

Purpose: build structured_inference state from the [execution context](context.md).
Use this when: writing `--state`.

## How it works
- State is JSON (object, array or string) whose strings may contain
  `{{ dotted.path }}` references. No filters, loops, conditionals or expressions.
- Strict: a missing required reference fails the dispatch before anything runs
  (`step_config_render_failed: required interpolation reference "..." is missing`).
- Append `?` to make a reference optional: `{{ task.constraints? }}` renders
  `null` (whole string) or `""` (embedded) when missing.
- A reference that is the whole string keeps its JSON type:
  `"symptoms": "{{ steps.summarize.output.symptoms }}"` is an array.
- An embedded reference must be a scalar: `"Title: {{ task.title }}"` works;
  embedding an object or array fails.
- Reference syntax is checked when the step is saved; existence is checked at dispatch.

## Doing it
```json
{"issue": {"title": "{{ task.title }}", "summary": "{{ steps.summarize.output.summary }}"},
 "report": "{{ steps.summarize.output }}",
 "criteria": "{{ task.testing_criteria? }}"}
```

## Gotchas
- `steps.<name>.output` exists only if that step completed in *this* run.
  Starting a run mid-workflow breaks these references: restart from the first step.
- Section lists are absent when a task has none; mark them optional.

## Related
[Context](context.md) · [structured_inference](../workflows/steps/structured_inference/index.md)
