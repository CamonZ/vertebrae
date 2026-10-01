# Execution context

Purpose: the data a prompt, state, or execute template can reference.
Use this when: writing templates or deciding where data should come from.

## Namespaces
- `task`: `id`, `title`, `description`, `level`, `tags` (list), `worktree`,
  `code_refs` (list of objects), and section lists (`goals`, `constraints`,
  `testing_criteria`, ...; see [sections](../tasks/sections.md)).
- `execution`:
  - `previous_output`: output of the most recent completed step in this run
    (decoded JSON using that execution's schema, else stored text; absent if none).
  - `handoff`: the object the route that led here passed (absent if none).
  - `run_count`, `completed_count`, `failed_count`: terminal attempts of
    *this step* in *this TaskRun* (`run_count` = completed + failed).
  - `duration_ms`: present duration metadata, when available.
  - `history`: earlier executions in this run, nearest first
    (`step_name`, `status`, `output` as raw text, `duration_ms`).
- `inputs`: caller-supplied input map; empty in normal dispatch today.
- `steps.<step_name>.output`: latest completed output of each named step in
  this run (decoded JSON when schema'd).
- `workflow`: `name`, `current_step`, `current_step_goal`, `step_count`, `output_schema` (if any).
- `artifacts`: IDs only, never bodies: `artifacts.task.<logical_name>.id`,
  `artifacts.project.<name>.id`, `artifacts.task_run.<name>.id`, and
  `artifacts.step_execution.history[i].<logical_name>.id` (nearest-first history).

## Scope rules
- `steps.*` and `execution.*` are scoped to the current TaskRun, across
  workflows within it. A new run (after `stop`, a failure, or a manual start
  mid-workflow) starts empty: references to earlier steps are missing.
- A `route` step produces no output, so right after a route
  `previous_output` has no result value. Read `execution.handoff` or `steps.<name>.output` instead.
- Routes and handoffs do not use this context; they see only
  `previous_output`, `task.level`, `task.tags`, `execution.step_visit_count`.
- Execute snapshots all six namespaces into read-only execution `config.context`
  and binds them directly as `task`, `execution`, `inputs`, `steps`, `workflow`,
  and `artifacts`. Missing optional fields stay absent; present null/false/empty
  values and literal template strings stay data. Sacrum renders script source
  strictly once; the daemon never renders context values. Authored `input` and
  `context` are rejected. See [execute](../workflows/steps/execute/index.md).

## Related
[Prompts](prompts.md) · [State](state.md) · [Execute](../workflows/steps/execute/index.md) · [Artifacts](../artifacts.md)
