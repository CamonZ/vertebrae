# Portable workflow bundle manifest

The shared V1 contract is implemented by `vertebrae-core::workflow_bundle`.
The deterministic fixture is
`crates/core/tests/fixtures/workflow_bundle_v1.json`.

## Shape and semantics

The top-level object requires `schema_version: 1`. `workflows`, `step_edges`,
and `workflow_edges` are optional arrays whose absent and empty forms mean the
same thing; therefore an empty bundle is valid. A workflow requires
`workflow_ref` and `name`; its `steps` array may be absent or empty. A step
requires `step_ref` and `name`. Workflow refs are unique in the bundle and
step refs are unique within a workflow. A `StepAddress` qualifies every graph
step ref with its workflow ref.

Workflow fields map to Sacrum's exportable fields: `name`, `description`,
`display_order`, `is_default`, `kanban_column`, `factory_name`, `metadata`,
and `initial_step`. Step fields map to `name`, `goal`, `prompt`, `agents`,
`skills`, `agent_config`, `step_type`, `step_order`, `output_schema`,
`persistence_options`, `route_config`, `provider`, `model`, `state`, and
`questions`. Structured inference uses provider/model/state/questions; the
question map is preserved as JSON, while Sacrum resolves state and validates
answers against a schema derived from the questions. `metadata`, agent
configuration, output schema, persistence options, route configuration, state,
and questions preserve nested JSON
without rewriting UUID-looking strings. Agents and skills retain their array
order. A missing/default display order is `0`, `is_default` is `false`, and
`step_type` is `llm_inference`; `prompt` is serialized as `null` when absent, while
`""` remains an empty prompt.

Structural objects reject unknown fields. Consequently persistence ownership
IDs, row IDs, `project_id`/`user_id`, timestamps, task assignments, execution
history, and daemon-only `verbose_daemon_logging` cannot enter a manifest. This
is a deliberate reject policy, not silent field loss. Opaque nested JSON is
allowed to contain such strings because it is not a structural manifest field.

`step_edges` are labeled intra-workflow edges and may branch or cycle.
`workflow_edges` are labeled inter-workflow edges with an optional symbolic
destination step; absent destination means the destination workflow's normal
initial-step behavior. Edge identity follows Sacrum's unique endpoint
constraints: a second edge between the same endpoints is rejected even when
its label differs. Foreign initial steps, cross-workflow step edges,
wrong-workflow destinations, and unresolved refs fail with a stable path and
ref-bearing diagnostic. Validation is pure and runs before any importer or
network call.

For the known Sacrum V1 route envelope, `rules[*].transition` and
`default.transition` use `step_ref` for intra-workflow targets and
`workflow_ref` for inter-workflow targets. Route targets must name an outgoing
manifest edge, as they do in Sacrum. The export helper
`symbolize_route_config` converts only persisted `step_id`/`workflow_id` at
those locations and leaves rule IDs, predicates, handoffs, and other opaque
values unchanged.

Canonical serialization sorts workflows, steps, and graph edges while retaining
the order of agents, skills, route rules, and handoff arrays. JSON object keys
are emitted deterministically by `serde_json`.

## Import contract

`vtb workflow import <path>` uses the same V1 manifest contract. The CLI reads
the file and runs `parse_manifest` before any backend mutation, then performs a
read-only list of destination workflows for create-only name conflict checks.
Names are compared case-insensitively; duplicate names within the bundle are
also conflicts. The importer never overwrites, merges, assigns tasks, or
deletes an existing workflow implicitly.

`--dry-run` stops after local validation and the read-only destination check. It
reports the active-project destination, all workflow/step/edge counts, the
create plan, conflicts, proposed default status, and contract warnings. It does
not reserve names, guarantee a later commit, or invent persistence IDs. A
successful commit submits exactly one bulk mutation through the Sacrum client;
Sacrum remains authoritative for access, graph constraints, default effects,
and races after preflight. Generated workflow and fully-qualified step mappings
are reported only after the mutation response passes protocol validation.

Backend rejection and transport loss are surfaced as failures. The CLI does not
retry an uncertain non-idempotent submission or fall back to incremental
creation, so an uncertain outcome must be reconciled from Sacrum before retrying.
