# Prompt templating (Liquid)

Purpose: render llm_inference prompts from the [execution context](context.md).
Use this when: writing or debugging a prompt.

## How it works
- Full Liquid (Solid): `{{ x }}`, filters (`upcase`, `join`, `size`, `plus`,
  ...), `{% if %}`, `{% for %}`, `{% unless %}`, `{% assign %}`.
- Lenient: a missing value renders empty, a loop over nothing does nothing, and
  `if` on a missing value is false. No error, no warning.
- A parse error (e.g. an unclosed `{% if %}`) sends the *raw* template text to the agent.

## Objects and lists
- A scalar renders as text; `true`/`false` and numbers render as written.
- An object renders as an Elixir map (`%{"a" => 1}`), not JSON. There is no `json` filter.
- A list of scalars concatenates with no separator (`[1,"a"]` -> `1a`); use `| join: ", "`.
- A list that contains objects fails to render and the dispatch errors.
  Loop and print fields instead.

## Patterns
```liquid
Task: {{ task.title }} ({{ task.level }})
{{ task.description }}
{% if task.testing_criteria %}Acceptance criteria:
{% for c in task.testing_criteria %}- {{ c }}
{% endfor %}{% endif %}
{% if execution.handoff.feedback %}Previous attempt was rejected: {{ execution.handoff.feedback }}{% endif %}
Symptoms: {% for s in steps.summarize.output.symptoms %}
- {{ s.component }}: {{ s.observed }} (expected {{ s.expected }}){% endfor %}
```
Tell the agent where the code is: `Work in {{ task.worktree }}`.

## Related
[Context](context.md) · [Troubleshooting](troubleshooting.md)
