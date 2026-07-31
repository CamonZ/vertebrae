---
name: artifact
description: Manage project-scoped file artifacts with the vtb CLI. Use when creating, listing, inspecting, updating, deleting, or attaching filename/body records to projects, tasks, task sections, workflows, TaskRuns, or step executions.
---

# /artifact

Use `vtb artifact` for project-scoped filename/body records. Artifacts are
ordinary files represented by a filename and text body; they are not typed
artifact variants and there is no standalone ArtifactLink CLI resource.

## Before running commands

- Use the active project from `VTB_PROJECT_ID` or the configured project.
- Use full UUIDs for artifact IDs and attachment target IDs.
- Preserve the body exactly, including newlines, when passing it through a
  file or stdin.

## Create

Provide a filename and exactly one body source. If neither `--body` nor
`--body-file` is supplied, the command reads the body from stdin.

```bash
vtb artifact add README.md --body "Project notes"
vtb artifact add report.md --body-file ./report.md
printf '%s\n' "Generated notes" | vtb artifact add notes.md
```

Attach to a supported destination by providing both flags. Omitting both
flags attaches to the active project.

```bash
vtb artifact add task-output.md --body "Result" \
  --subject-type task --subject-id <task-uuid>
```

Supported subject types are `project`, `task`, `task_section`, `workflow`,
`task_run`, and `step_execution`. `--subject-type` and `--subject-id` must be
provided together, and the destination must belong to the active project.

## Read and paginate

```bash
vtb artifact list
vtb artifact list --limit 20 --offset 20
vtb artifact show <artifact-uuid>

# Machine-readable output: put the global flag before the command group.
vtb --json artifact list --limit 20 --offset 0
vtb --json artifact show <artifact-uuid>
```

`list` is scoped to the active project. Human-readable empty results say
`No artifacts found`; JSON list output is an array. The backend caps the list
limit at 50.

## Update

Supply at least one replacement field. The current Sacrum backend requires a
filename when changing the body, so include `--filename` with body updates.

```bash
vtb artifact update <artifact-uuid> --filename revised.md
vtb artifact update <artifact-uuid> \
  --filename revised.md --body "Revised content"
vtb artifact update <artifact-uuid> \
  --filename revised.md --body-file ./revised.md
vtb --json artifact update <artifact-uuid> \
  --filename revised.md --body "Revised content"
```

Do not pass `--body` and `--body-file` together. An update with no fields is
invalid.

## Delete safely

Human-readable deletion asks for confirmation unless `--force`/`-f` is used.
Use `--force` for scripts and JSON workflows.

```bash
vtb artifact delete <artifact-uuid>
vtb artifact delete <artifact-uuid> --force
vtb --json artifact delete <artifact-uuid> --force
```

Deletion removes the artifact and its attachment. Verify a destructive
operation by querying `vtb artifact show` or listing the project afterward.

## Failure handling

Treat invalid UUIDs, missing artifacts, mismatched project scope, invalid
attachment targets, and unauthorized requests as command failures. Do not
retry with another project or fabricate a target ID; first resolve the
current project and destination from Vertebrae.
