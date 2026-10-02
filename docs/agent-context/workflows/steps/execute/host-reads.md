# Reading tasks and artifacts in execute

Purpose: read live tasks and named artifacts from an execute script.
Use this when: rolling up child results, or reading another task or a project artifact from Rhai.

A script can read its execution's project while it runs. `vtb::tasks::get`,
`find`, `parent`, `children`, `dependencies` and `dependents` return task maps;
`vtb::artifacts::list`, `lookup`, `read` and `read_json` read named artifacts.
An artifact subject is a task ID or the literal `"project"`, and the name is the
artifact's logical name. Scripts never pass a project ID; a task in another
project reads as missing.

- Anything missing returns `()`. Other failures raise an error ([limits](limits.md)).
- `read_json` also returns `()` for JSON `null`; use `lookup` to tell them apart.
- Reads see live data, not the `task`/`artifacts` snapshot. Listing order is
  unspecified, so sort when the result must be stable.

## Example: roll up child outcomes

Each child stores its result as an `outcome` artifact. An execute step on the
parent collects them, and persistence stores the summary on the parent as
`children-summary.json`.

`children-summary.rhai`:

```rhai
let reported = [];
let missing = [];
let children = vtb::tasks::children(task.id);
children.sort(|a, b| if a.id < b.id { -1 } else if a.id > b.id { 1 } else { 0 });
for child in children {
    let outcome = vtb::artifacts::read_json(child.id, "outcome");
    if outcome == () {
        missing.push(#{ id: child.id, title: child.title });
    } else {
        reported.push(#{ id: child.id, title: child.title, outcome: outcome });
    }
}
#{ reported: reported, missing: missing }
```

`children-summary.schema.json`:

```json
{
  "type": "object",
  "properties": {
    "reported": {"type": "array", "items": {"type": "object", "required": ["id", "title", "outcome"]}},
    "missing": {"type": "array", "items": {"type": "object", "required": ["id", "title"]}}
  },
  "required": ["reported", "missing"],
  "additionalProperties": false
}
```

```bash
vtb step add "Summarize children" -w <workflow-id> --step-type execute \
  --script @children-summary.rhai \
  --output-schema "$(cat children-summary.schema.json)" \
  --persistence-options '{"artifact":{"logical_name":"children-summary"}}'
```

Children without an outcome, or with a `null` one, are listed under `missing`.
A malformed outcome raises `invalid` and fails the step; nothing is persisted.
Rerunning the step produces the same summary and replaces the artifact. Read it
with `vtb artifact list --task-id <parent-id>`.

## Related
[Settings](settings.md) · [Context bindings and output](input-output.md) ·
[Artifacts](../../../artifacts.md)
