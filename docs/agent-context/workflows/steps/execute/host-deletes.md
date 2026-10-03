# Deleting tasks and artifacts in execute

Purpose: delete tasks and named artifacts from an execute script.
Use this when: a script cleans up tasks or artifacts it created, or must converge when rerun after deleting.

- `vtb::tasks::delete(id, opts)` deletes the task and returns `()`. Pass `#{}`
  or `#{ cascade: false }` to delete only that task: its children stay,
  detached from it. `#{ cascade: true }` also deletes every descendant.
- `vtb::artifacts::delete(subject, name)` deletes the artifact with that name
  on a task or `"project"` and returns `()`.
- A target that is already gone is `not_found`. Catch only that kind to make
  a rerun converge; rethrow everything else.

Deleting a task also deletes its TaskRuns and step executions, so
`vtb::tasks::delete` refuses with `invalid` when the task is the one running
the script, has an active TaskRun, or (with cascade) has such a task below it.
The check reads run state just before deleting, so a run that starts in
between isn't caught. Deleting a task doesn't delete its artifacts: they stay
readable by ID with `vtb artifact show`, but no task lists them. Delete them
first. Deletes apply immediately; a task or artifact subject in another
project is `not_found` ([limits](limits.md)).

## Example: delete scratch children and their artifacts

Children tagged `scratch` are removed with their named artifacts. A rerun
after a failure finishes the job; a rerun after success finds nothing.

```rhai
let deleted = [];
for child in vtb::tasks::find(#{ parent_id: task.id, tags: ["scratch"], include_archived: true }) {
    let artifacts = vtb::artifacts::list(child.id);
    if artifacts == () { continue; }
    for artifact in artifacts {
        try { vtb::artifacts::delete(child.id, artifact.logical_name); }
        catch (error) { if error.kind != "not_found" { throw error; } }
    }
    try { vtb::tasks::delete(child.id, #{ cascade: false }); }
    catch (error) { if error.kind != "not_found" { throw error; } }
    deleted.push(child.id);
}
#{ deleted: deleted }
```

A scratch child's own children are detached, not deleted; use
`#{ cascade: true }` and delete their artifacts too when they should go.

## Related
[Creating and updating tasks](host-writes.md) ·
[Writing artifacts](host-artifact-writes.md) · [Limits and cancellation](limits.md)
