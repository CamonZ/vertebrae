# Sections

Purpose: structured task content that people read and prompts can iterate.
Use this when: adding goals, constraints, acceptance criteria or checklists to a task.

## What you can do
Add (`vtb section <id> <type> "<content>"`), list (`vtb sections <id>`), edit
(`vtb update <id> --edit-section <type> <ordinal> "<content>"`), remove
(`vtb unsection`, needs consent), and tick checklist items (`vtb check-item`).

## Section types and their template names
| Type (CLI) | In templates |
|---|---|
| goal | `task.goals` |
| context | `task.context` |
| current_behavior | `task.current_behavior` |
| desired_behavior | `task.desired_behavior` |
| checklist_item | `task.checklist_items` |
| testing_criterion | `task.testing_criteria` |
| anti_pattern | `task.anti_patterns` |
| failure_test | `task.failure_tests` |
| constraint | `task.constraints` |

Each template value is a list of the section contents (strings), in order.
A task with no sections of a type has no key for it, so it renders empty.

## Doing it
In an `llm_inference` prompt:
`{% for c in task.testing_criteria %}- {{ c }}\n{% endfor %}`.
See [templating/prompts](../templating/prompts.md).

## Gotchas
- Use `vtb sections <id>` to find the ordinal before editing or removing a section.
- `structured_inference` state cannot loop; pass the whole list as a
  whole-string reference (`"criteria": "{{ task.testing_criteria? }}"`).

## Related
[Authoring](authoring.md) · [Templating context](../templating/context.md)
