# Writing artifacts in execute

Purpose: publish named artifacts on a task or the project from an execute script.
Use this when: a script leaves a record on another task, shares data through the project, or hands results to a later step by name.

- `vtb::artifacts::put(subject, name, body)` stores `body`, a string, exactly
  as given, in `<name>.txt`. `put_json(subject, name, value)` stores the
  value as JSON in `<name>.json`; `()` is stored as `null`. Key order and
  number formatting aren't kept.
- The subject is a task ID in the project or the literal `"project"`; the
  name is the artifact's logical name. Both return the artifact's info map
  (`id`, `filename`, `logical_name`, `metadata`, timestamps), never the body.
- A write replaces an existing artifact with that name on that subject, or
  creates it. Rerunning the same writes converges on one artifact per name,
  so no existence check is needed. A later read in the same script sees the
  new value.
- The metadata records the writer: `origin: "rhai"`, `format` (`text` or
  `json`), and `execution_id`, `task_run_id` and `task_id` under
  `extensions`. A replacement records the latest writer.

Writes apply immediately and stay if the script fails later. A task in
another project or a missing one is `not_found`. A blank body, a blank
name, or a value JSON can't hold (a function, an infinite number) is
`invalid`. An artifact that is also attached to another subject can't be
replaced: the write is `invalid` and nothing changes. After a `transport`
error the write may still have happened, so read it back before retrying.

The step's own output persistence runs after the script returns. If it uses
the same logical name on the same task, it replaces the body and filename of
the artifact `put` wrote but keeps the metadata `put` recorded. Use different
names when both should survive.

## Example: record a task's progress

```rhai
let children = vtb::tasks::children(task.id);
let completed = children.filter(|child| child.completed_at != ()).len();
let progress = #{ children: children.len(), completed: completed };
let info = vtb::artifacts::put_json(task.id, "progress", progress);
#{ progress: progress, filename: info.filename }
```

Running it again replaces the same `progress` artifact. Read it with
`vtb artifact lookup --subject-type task --subject-id <task-id> progress`.

## Related
[Reading tasks and artifacts](host-reads.md) · [Context bindings and output](input-output.md) ·
[Artifacts](../../../artifacts.md)
