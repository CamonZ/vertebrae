# Artifacts

The `vtb artifact` command manages artifact files in the active project.

## Listing artifacts

List artifacts across the active project:

```bash
vtb artifact list
vtb --json artifact list
```

List artifacts attached directly to an epic, ticket, or task:

```bash
vtb artifact list --task-id <task-uuid>
vtb artifact list --task-id <8-character-short-id>
vtb --json artifact list --task-id <task-uuid>
```

Epics, tickets, and tasks use the same task ID namespace. Full UUIDs and
8-character task short IDs are accepted; short IDs are resolved before the
artifact query runs.

Task-scoped listing returns artifacts linked directly to the requested task
subject. It does not recursively include artifacts attached to child tasks,
siblings, task sections, workflows, task runs, step executions, or the
project. Omitting `--task-id` keeps the existing project-wide behavior.

The human-readable output contains the artifact ID, filename, and logical name
when present. JSON output returns the artifact array, including body, timestamps,
logical name, and attachment metadata when available. An empty scope prints
`No artifacts found` in human-readable mode and returns `[]` in JSON mode.

Listing returns the complete authorized collection without pagination or a
client-side item cap. `--limit` and `--offset` are not supported. This requires
the Sacrum unpaginated artifact-list contract; older servers may still truncate
argument-free queries. Invalid or nonexistent task IDs fail instead of falling
back to a project-wide list.

## Migration from paginated listing

Deploy Sacrum's unpaginated artifact contract
([Sacrum ticket](vtb://ticket/97127f9a-6498-4a52-9a03-84693e77f120))
before using this client. Queries now request `Project.artifacts` and `Task.artifacts` without arguments and expect
complete, ordered results. Older servers' default page-size clamping is not
compatible with this contract.

Remove `--limit` and `--offset` from scripts. Rust callers use
`ArtifactService::list_artifacts()` or `list_task_artifacts(task_id)`;
`ListArtifactInput` has been removed. Rhai and GUI command signatures are
unchanged, but their listings now return every artifact in the requested scope.
