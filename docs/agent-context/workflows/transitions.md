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

## Doing it
`vtb step update <id> --transition-to <next>` replaces the whole list;
`--clear-transitions` empties it. `vtb workflow transition list` shows workflow edges.

## Gotchas
- `vtb workflow transition delete` takes the two workflow IDs, not a transition ID.
- Adding a "back" edge from a non-route step to allow a manual move makes it
  branch and breaks runs; move tasks with `vtb transition-to --skip-validation` instead (with consent).

## Related
[Authoring order](authoring-order.md) · [Route](steps/route/index.md)
