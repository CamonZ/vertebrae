# Route envelope (V1)

Purpose: the exact shape of a route_config.
Use this when: writing or reading a route.

## Shape
```json
{"version": 1, "match_policy": "exactly_one",
 "rules": [{"id": "api",
            "when": {"ref": "previous_output.area.choice", "op": "eq", "value": "api"},
            "transition": {"type": "inter_workflow", "workflow_id": "<wf-uuid>"},
            "handoff": {"area": "{{ previous_output.area.choice }}"}}],
 "default": {"transition": {"type": "intra_workflow", "step_id": "<step-uuid>"}, "handoff": {}}}
```
- `id`: unique, `[A-Za-z0-9][A-Za-z0-9._-]*`.
- `when`: a predicate `{ref, op, value}` or `{"all": [...]}`, `{"any": [...]}`, `{"not": {...}}`.
- `transition`: `intra_workflow` + `step_id` (must be one of this step's
  transitions) or `inter_workflow` + `workflow_id` (must be a workflow
  transition from this workflow; enters at its target step or the destination's entry).
- `handoff`: optional object, see [handoff templating](../../../templating/handoffs.md). `{}` means none.
- `session`: optional `{"mode": "new" | "resume" | "fork", "step_id"?}` choosing
  how an intra_workflow llm_inference destination enters a conversation, see
  [session directives](sessions.md). Omitted means a new conversation.
- `default`: optional decision used when no rule matches.

## References and operators
| Ref | Operators |
|---|---|
| `previous_output.<path>` (from the predecessor's schema) | eq, neq, in, lt, lte, gt, gte, contains, contains_any, contains_all, by field type |
| `task.level` (`epic`/`ticket`/`task`) | eq, neq, in |
| `task.tags` | contains, contains_any, contains_all |
| `execution.step_visit_count` | eq, neq, lt, lte, gt, gte, in |

## Doing it
Save with `vtb step update <route> --route-config "$(cat route.json)"`.
The backend validates refs against every predecessor's output schema, targets
against existing edges, and coverage/overlap; errors carry the JSON path.

## Gotchas
A missing value at runtime never matches, and `not` of a missing value is
still missing, so such cases fall to `default` (or `route_no_match` without one).

## Related
[Partitions](partitions.md) · [Session directives](sessions.md) · [Transitions](../../transitions.md)
