# Artifacts

The `vtb artifact` command manages artifact files in the active project.

## Listing artifacts

List artifacts across the active project:

```bash
vtb artifact list
vtb artifact list --limit 20 --offset 20
vtb --json artifact list
```

List artifacts attached directly to an epic, ticket, or task:

```bash
vtb artifact list --task-id <task-uuid>
vtb artifact list --task-id <8-character-short-id>
vtb --json artifact list --task-id <task-uuid>
vtb artifact list --task-id <task-uuid> --limit 20 --offset 20
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

`--limit` must be greater than zero and `--offset` cannot be negative. Invalid
or nonexistent task IDs fail instead of falling back to a project-wide list.
