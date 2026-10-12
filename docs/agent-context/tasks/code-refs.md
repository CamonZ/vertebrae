# Code refs

Purpose: attach file and line references to a task.
Use this when: the user wants a ticket to point at specific code, or a prompt needs those paths.

## What you can do
Add (`vtb ref <id> <file-spec> --name <label> --desc <text>`), list
(`vtb refs <id>`), remove (`vtb unref`, needs consent), and attach a ref to a
testing criterion (`vtb criterion-ref`, same file spec).

## How it works
Prompts see `task.code_refs` as a list of objects with `path`, `name`,
`description`, and `line_start`/`line_end` when set.

## File spec
- `src/auth.rs`: the whole file.
- `src/auth.rs:L42`: one line.
- `src/auth.rs:L42-60`: a line range.

The `L` is required. Without it (`src/auth.rs:42-60`) the CLI stores the whole
string as a path to a file that does not exist and only prints a warning.

## Doing it
`{% for r in task.code_refs %}- {{ r.path }}:{{ r.line_start }} {{ r.description }}\n{% endfor %}`

## Gotchas
- A `Warning: file '...' does not exist` after `vtb ref` means the spec was
  stored as a bad path, usually because the `L` was left out. Remove that ref
  with `vtb unref <id> "<exact stored path>"` (needs consent) and add it again
  with the `L`.
- Render fields, not the object: `{{ r }}` prints an Elixir map, and a list that
  contains objects fails to render (see [templating/prompts](../templating/prompts.md)).

## Related
[Sections](sections.md) · [Templating context](../templating/context.md)
