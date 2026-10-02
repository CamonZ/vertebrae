# Editing task content and relationships in execute

Purpose: edit sections, checklist items, code refs, parents and dependencies from an execute script.
Use this when: filling in a task's assignment details, or wiring tasks together from Rhai.

- `vtb::tasks::add_section(id, #{ type, content })` returns the stored section.
  `goal`, `context`, `current_behavior` and `desired_behavior` replace the
  existing one and do nothing when the content is already the same. Other
  types append, so check `get(id).sections` before adding one. A
  `checklist_item` also takes `done` (default `false`).
- `edit_section(id, type, order, content)`, `check_item(id, order)` and
  `uncheck_item(id, order)` address a section by its stored `order`, never its
  position in the array. Removing a section doesn't renumber the others. A
  missing order is `invalid`. They return the section.
- `add_code_ref(id, ref)` and `remove_code_ref(id, ref)` take
  `#{ path, line_start, line_end, name, description }`, only `path` required.
  A ref matches only when all five fields are equal.
- `set_parent(id, parent_id)`, `remove_parent(id)`,
  `add_dependency(id, depends_on_id)` and `remove_dependency(id, depends_on_id)`
  return `()`. A self-edge, a dependency cycle, or a parent that is the task or
  one of its descendants is `invalid`. Adding a dependency never starts or
  advances a TaskRun.

Each edit reads the task first and writes only when the requested state
doesn't already hold, so rerunning a script converges; appending a section is
the exception. Writes apply immediately and are not undone when the script
fails later. A task in another project is `not_found`
([limits](limits.md)). Sections can't be removed from Rhai.

## Example: add an assignment checklist once

```rhai
let id = task.id;
let have = vtb::tasks::get(id).sections
    .filter(|s| s.type == "checklist_item")
    .map(|s| s.content);
for item in ["Tests pass", "Docs updated"] {
    if !have.contains(item) {
        vtb::tasks::add_section(id, #{ type: "checklist_item", content: item });
    }
}
#{ checklist: vtb::tasks::get(id).sections.filter(|s| s.type == "checklist_item").len() }
```

## Related
[Creating and updating tasks](host-writes.md) ·
[Reading tasks and artifacts](host-reads.md) · [Settings](settings.md)
