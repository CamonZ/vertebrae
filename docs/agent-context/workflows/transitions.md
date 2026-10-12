# Transitions

Purpose: the two edge layers and the rules each step type imposes.
Use this when: connecting steps or workflows, or diagnosing a run that stops at a step.

## Two layers
- **Step transitions** (`vtb step add/update --transition-to <step>`): edges
  between steps in one workflow. Intra-workflow routes resolve against them.
- **Workflow transitions** (`vtb workflow transition add <from> <to> --label <l> [--target-step <step>]`):
  edges between workflows, with an optional entry step. Inter-workflow routes
  resolve against them, not against step edges.

A route that only leaves its workflow has no step transitions (empty `transitions_to`).

## Edge rules at runtime
| Step type | Outgoing step transitions |
|---|---|
| llm_inference, structured_inference, execute, human_input, wait_children | exactly one |
| stop | exactly one (the next TaskRun follows it) |
| route | one per intra-workflow target (none if it only exits) |
| finish | none |

The backend saves a graph that breaks these rules; the run fails when it reaches
the step (`multiple_outgoing_transitions`, `no_outgoing_transitions`). A
non-route step never branches: put a `route` after it.

## Session directives on step transitions
A step transition into an llm_inference step may carry a
[session directive](steps/route/sessions.md) `{mode: new|resume|fork, step_id?}`
that decides how the destination enters a conversation when a run follows the
edge. It is how consecutive llm_inference steps share one conversation without
a route between them. Author it with
`--transition-session <to>=<mode>[:<step>]` on `vtb step add/update`; `<step>`
defaults to the destination and is not allowed with `new`. Transitions leaving a
route step cannot carry one: the route's decisions do.

The backend validates it when the transitions are saved, with the same rules
as route directives, and reports `$.session` plus the edge's endpoints.

### Edges leaving a stop step
A [stop](steps/stop.md) step's single edge is followed by the next TaskRun, so
its directive continues a conversation across the run boundary: the
destination resumes or forks `<step>`'s conversation in the run that stopped
at the boundary.
`vtb step update <pause> --transition-session <revise>=resume:<draft>` makes the
post-boundary `revise` continue the pre-boundary `draft` conversation. If that
run has no completed turn for `<step>`, the new run fails with
`dispatch_failed` (Sacrum logs `session_not_found`) instead of starting fresh.
Without a directive the destination starts a new conversation.
`vtb step show` lists directives under `Transition Sessions:`; `step show/list`
JSON maps destination step IDs to them in `transition_sessions`.

## Doing it
`vtb step update <id> --transition-to <next>` replaces the whole list;
`--clear-transitions` empties it. Transitions kept in the new list keep their
label and session directive. `vtb step update <id> --transition-session <next>=resume`
sets one directive without touching the list, and `<next>=none` clears it.
`vtb workflow transition list` shows workflow edges.

## Gotchas
- `vtb workflow transition delete` takes the two workflow IDs, not a transition ID.
- Adding a "back" edge from a non-route step to allow a manual move makes it
  branch and breaks runs; move tasks with `vtb transition-to --skip-validation` instead (with consent).

## Related
[Authoring order](authoring-order.md) · [Route](steps/route/index.md) · [Session directives](steps/route/sessions.md)
