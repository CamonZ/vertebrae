# Templating troubleshooting

Purpose: map template symptoms to causes.
Use this when: a rendered prompt or state is wrong, or a dispatch failed on a template.

| Symptom | Cause | Fix |
|---|---|---|
| Value renders empty in a prompt | Path wrong, value missing, or step not run in this TaskRun | Check the [context](context.md) path; guard with `{% if %}` |
| Agent received literal `{% ... %}` text | Liquid parse error; raw template sent | Close every tag; check quotes |
| `%{"key" => ...}` in a prompt | An object was printed | Print fields or loop |
| `1two3` | A list printed without a separator | `| join: ", "` |
| Dispatch fails rendering a prompt with a list | List contains objects | Loop over it and print fields |
| `step_config_render_failed ... is missing` | Required state reference missing | Use `?`, or restart the run from the first step so `steps.*` exist |
| `step_config_render_failed ... whole string` | Object/array embedded in text | Make it the whole string value |
| `route_handoff_template_invalid` | Bad reference syntax or unknown output path | Fix the path against the predecessor schema |
| `previous_output` empty after a route | Routes produce no output | Use `execution.handoff` or `steps.<name>.output` |

## Related
[Prompts](prompts.md) · [State](state.md) · [Handoffs](handoffs.md) · [Failure table](../debugging/failure-table.md)
