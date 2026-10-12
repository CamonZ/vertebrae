# Failure table

Purpose: map a failure to its cause and fix.
Use this when: a run failed, stalled, or produced the wrong path.

| Symptom / string | Cause | Fix |
|---|---|---|
| `multiple_outgoing_transitions` | A non-route step has more than one edge | Keep one edge; branch with a route |
| `no_outgoing_transitions` | A non-route, non-finish step has no edge | Add the edge, or end the path with finish/stop |
| `step_config_render_failed ... is missing` | Required state or execute reference is missing in this TaskRun | Check the reference and run scope using the field's [templating rules](../templating/index.md) |
| Prompt has empty values / raw `{% %}` | Lenient Liquid; parse error | [Templating troubleshooting](../templating/troubleshooting.md) |
| `route_no_match` | No rule matched, no default | Add a default or cover the case ([partitions](../workflows/steps/route/partitions.md)) |
| `route_ambiguous_match` | Two rules matched (tags/visit-count rules are not checked at save) | Make them disjoint ([overlap checks](../workflows/steps/route/overlap-checks.md)) |
| `route_config_ambiguous` / `route_config_uncovered` on save | Rules overlap / leave a closed case uncovered | Fix the partition or add a default |
| `route_reference_unknown` / `route_target_invalid` on save | Ref not in predecessor schema / target edge missing | Add the schema field / create the transition first |
| `$.rules[<i>].session...` / `$.default.session...` on save (`route_session_invalid`, `route_config_invalid`) | Session directive with an unknown key or mode, `step_id` with `new`, an intra_workflow destination that is not llm_inference, or a `step_id` outside the workflow, not llm_inference, or on another harness | Fix the directive ([session directives](../workflows/steps/route/sessions.md)) |
| `$.rules[<i>].session.step_id: is required with mode resume or fork` on save | An inter_workflow decision's `resume`/`fork` has no `step_id` (its destination step is chosen at run time) | Name an llm_inference step of the route's own workflow |
| `$.session.mode: must be fork` / `$.session.step_id: is required` / `$.session.step_id: must be an llm_inference step in this workflow` on a `wait_children` save | `--children-session` with `resume` or `new`, without a step, or naming a step outside the parent's workflow or not llm_inference | Use `--children-session fork:<llm-step-of-this-workflow>` ([wait_children](../workflows/steps/wait_children.md)) |
| `$.session` on `vtb step add/update` naming `step transition <from> -> <to>` (`step_transition_session_invalid`) | Edge directive whose destination is not llm_inference, on a transition leaving a route step, or with a `step_id` outside the workflow, not llm_inference, or on another harness | Fix the edge directive, or move it to the route's decision ([session directives](../workflows/steps/route/sessions.md)) |
| `--transition-session names <id>, which is not an outgoing transition` / `transition session names step <id>, which is not an outgoing transition` | The directive names a step the transition list does not include | Add `--transition-to <id>` or fix the ID |
| Run fails `dispatch_failed`, reason is a step id (Sacrum logs `session_not_found`) | A `resume`/`fork` (route decision or edge) names a step with no completed execution in the run it searches, or its latest conversation has no recorded session id. That run is this TaskRun, except: past a `stop` step it is the run that stopped there (or none, if the task was moved onto the stop), and for a `wait_children` child it is the parent run | Enter there only after that step completed in that run, or use `new`; for a stop, make sure the step ran before the boundary |
| Run fails `dispatch_failed`, reason is the entry step id (Sacrum logs `session_requires_llm_inference`) | A `resume`/`fork` reached a step that is not llm_inference: an inter_workflow decision's destination entry step, or a child workflow's first step under `--children-session` | Make that entry step llm_inference, or drop the directive |
| Run fails `dispatch_failed`, reason names `bound` and `step` harnesses (`session_harness_mismatch`) | The conversation was recorded under a different harness than the destination's (harness changed after it ran) | Keep both steps on one harness, or use `new` |
| `No conversation found with session ID: <id>` / `no rollout found for thread id <id>`, then `retry_exhausted` | The provider no longer has the conversation being resumed or forked (deleted, other machine, other `CODEX_HOME`), or a Claude child or post-stop run executes in a different working directory (its own worktree) than the run that recorded the session | Run on the machine and in the directory that holds it, or set the directive to `new` and re-run |
| `child_missing_workflow` | A direct child has no workflow at `wait_children` | Assign workflows to every child |
| Parent run stays `waiting` | A child is incomplete or parked | `vtb list --parent <id>`; fix or finish that child |
| Provider 401 / auth errors, then `retry_exhausted` | Daemon holds a stale or missing key | Update config, then restart the daemon ([setup/daemon](../setup/daemon.md)) |
| `unsupported by the selected '<h>' harness` / `'typesafe' only supports ... structured_inference` | Harness does not match the step type | `claude`/`codex` for llm_inference, `typesafe` for structured_inference ([harness](../workflows/steps/harness.md)) |
| `step harness '<h>' conflicts with agent_config.provider` | Provider runs on a different harness | Fix the harness or `agent_config.provider` |
| `provider '<id>' is not configured on this machine` | Custom provider missing from the daemon's config.toml | Add `[providers.<id>]` and restart the daemon ([config](../setup/config.md)) |
| `model '<m>' is not configured for provider '<id>'` | Model not in the custom provider's `models` list | Add it to `models`, or pick a listed model |
| `invalid agent_config in run_step payload` | Step's agent_config does not parse (e.g. malformed provider ID) | Fix the step's `--agent-config` |
| `selected '<h>' harness is unavailable` | Harness binary or key missing on the daemon machine | Install/log in, or set the key and restart the daemon |
| Codex rejects the output schema | Not strict (optional props, type arrays) | [Output schemas](../workflows/steps/llm_inference/output-schemas.md) |
| `execute fields require explicit step_type='execute'` / `execute run_step must omit ...` | Malformed execute dispatch, or inference-only fields supplied | Use the explicit execute version/script/context/output_schema contract without harness/provider settings ([execute](../workflows/steps/execute/index.md)) |
| `execute requires a resolved context JSON object` / `execute context.<namespace> must be a JSON object` | Missing or malformed immutable context snapshot | Use a backend with the merged context contract; inspect the saved config and dispatch, without supplying authored input/context |
| `Rhai execution failed` | Script syntax, missing context property, incompatible types, or operation budget exceeded | Check the persisted script/context snapshot and the Rhai source position; correct the script or reduce work |
| Execute output violates `output_schema` | Returned JSON does not conform | Check the schema-error instance/schema paths and fix the return value or schema; inference-only schema restrictions do not apply |
| "No vertebrae project found" | `vtb` run outside the project checkout | Run from the project directory |
| Run completes but nothing was posted externally | The external service rejected the action (e.g. reviewing your own PR) | Check the step's output/artifact for the error; adjust the action |

After fixing, recover per [retries and recovery](../running/retries-and-recovery.md).

## Related
[Logs and outcomes](logs-and-outcomes.md)
