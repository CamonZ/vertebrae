# Code refs

Purpose: attach file and line references to a task.
Use this when: the user wants a ticket to point at specific code, or a prompt needs those paths.

## What you can do
Add (`vtb ref <id> <path[:start[-end]]> --name <label> --desc <text>`), list
(`vtb refs <id>`), remove (`vtb unref`, needs consent), and attach a ref to a
testing criterion (`vtb criterion-ref`). See `vtb ref --help` for the file spec.

## How it works
Prompts see `task.code_refs` as a list of objects with `path`, `name`,
`description`, and `line_start`/`line_end` when set.

## Doing it
`{% for r in task.code_refs %}- {{ r.path }}:{{ r.line_start }} {{ r.description }}\n{% endfor %}`

## Gotchas
- Render fields, not the object: `{{ r }}` prints an Elixir map, and a list that
  contains objects fails to render (see [templating/prompts](../templating/prompts.md)).

## Related
[Sections](sections.md) · [Templating context](../templating/context.md)
