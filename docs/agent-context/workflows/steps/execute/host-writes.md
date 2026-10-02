# Creating and updating tasks in execute

Purpose: create, update and archive tasks from an execute script.
Use this when: turning a plan into child tasks, or maintaining task fields from Rhai.

- `vtb::tasks::create(fields)` returns the new task map. Fields: `title`
  (required), `description`, `level` (default `"task"`), `priority`, `tags`,
  `parent_id`, `workflow_id` (default: the project's default workflow),
  `worktree` and `depends_on`. Omitted priority and workflow get the backend
  defaults. Creating a task never starts a TaskRun.
- `vtb::tasks::update(id, patch)` changes `title`, `description`, `level`,
  `priority`, `worktree`, `add_tags` or `remove_tags`. An absent key keeps its
  value and `()` clears `description`, `priority` or `worktree`. It returns
  `()`. Tag changes read the current tags and write the full set, so two
  scripts editing the same task's tags at once can overwrite each other.
- `vtb::tasks::archive(id)` and `unarchive(id)` do nothing when the task is
  already in that state.

Writes apply immediately and are not undone when the script fails later. If
adding `depends_on` fails, the new task stays without its dependencies.
Unknown keys are `invalid`; a task or workflow in another project is
`not_found` ([limits](limits.md)).

## Example: create one child per plan item

The parent has a `plan` artifact listing its work. Each child gets a key tag,
so a rerun after a failure finds the children it already made and creates
only the missing ones.

`plan.json`, attached to the parent with the logical name `plan`:

```json
[{"key": "api", "title": "Build the API"}, {"key": "ui", "title": "Build the UI"}]
```

`plan-children.rhai`:

```rhai
let created = [];
let existing = [];
for item in vtb::artifacts::read_json(task.id, "plan") {
    let key = "plan:" + item.key;
    let found = vtb::tasks::find(#{ parent_id: task.id, tags: [key], include_archived: true });
    if found.len() > 1 { throw "More than one child is tagged " + key; }
    if found.is_empty() {
        created.push(vtb::tasks::create(#{ title: item.title, parent_id: task.id, tags: [key] }).id);
    } else {
        existing.push(found[0].id);
    }
}
#{ created: created, existing: existing }
```

```bash
vtb artifact add plan.json --body-file plan.json --subject-type task \
  --subject-id <parent-id> --logical-name plan
vtb step add "Create plan children" -w <workflow-id> --step-type execute \
  --script @plan-children.rhai \
  --output-schema '{"type":"object","required":["created","existing"]}'
```

The first run lists every child under `created`; a rerun lists them under
`existing` and creates nothing. Archived children still count, so archiving
one doesn't bring it back.

## Related
[Reading tasks and artifacts](host-reads.md) · [Settings](settings.md) ·
[Context bindings and output](input-output.md)
