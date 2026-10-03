# Artifacts

Purpose: persist step results and find them later.
Use this when: the user asks where a run's result is, or a workflow should leave a record on the ticket.

## What you can do
- Configure a step to persist its output: `--persistence-options '{"artifact":{"logical_name":"bug_triage"}}'`.
- List a task's artifacts: `vtb artifact list --task-id <id>`.
- Read one: `vtb artifact show <artifact-id>`, or by name:
  `vtb artifact lookup --subject-type task --subject-id <task-id> <logical_name>`.
- Create/update/delete artifacts manually (`vtb artifact add/update/delete`; delete needs consent).
- Write named artifacts from an execute script with `vtb::artifacts::put` and
  `put_json` ([writing artifacts](workflows/steps/execute/host-artifact-writes.md)).

## How it works
- The backend (not the daemon) writes the artifact after the step's output validates.
  The step needs an output schema: llm_inference via `--output-schema`,
  structured_inference via its questions, execute via its required schema,
  wait_children via its schema.
- The output is attached to the task as `<logical_name>.json`. A later write
  with the same logical name replaces it, so loops keep the latest result.
- Not allowed on `finish` or `stop` steps; route decisions are audited, not persisted as artifacts.
- Templates and execute bindings see artifact IDs only (`artifacts.task.<name>.id`), never bodies.

## Doing it
Give every step whose result matters a logical name (e.g. `bug_summary`,
`bug_triage`, `bug_outcome`), and end workflows with one step that composes a
final outcome artifact (decision, reason, key signals) so there is one place to look.

## Gotchas
- Task-scoped listing does not include children's artifacts; list each child.
- A step without an output schema cannot persist; the backend rejects the options when saving.
- Output persistence runs after an execute script returns, so it overwrites an
  artifact the script wrote under the same logical name on the same task.

## Related
[Output schemas](workflows/steps/llm_inference/output-schemas.md) · [Multi-workflow factory](recipes/multi-workflow-factory.md)
