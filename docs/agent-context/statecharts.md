# Statechart artifacts

Purpose: explain a development workflow with an XState-compatible statechart
attached to its ticket and displayed in chat. The native viewer shows compound
states, parallel regions, final-state markers, initial arrows and event edges.
Select states to inspect them; drag or scroll to pan and use the zoom controls.
Event colors have a legend and a single-color option. The centered container
uses 90% width. Its shared diff-style bottom grip resizes height with dragging
or Up/Down keys (Shift for larger steps). Dragging pans even a fitted chart.

## Supported machine definition: XState v5 JSON

Save a JSON configuration accepted by `createMachine(config)` in XState 5.
The root needs `id` and a nonempty `states` object. State keys and optional IDs
start with an ASCII letter and contain at most 64 ASCII letters, digits,
underscores or hyphens. Reserved object keys are rejected. `description` is
optional. `type` is `atomic`, `compound`, `parallel` or `final`; compound is
inferred when children exist, otherwise atomic. Compound states require an
`initial` direct-child key. Parallel states enter all child regions together
and cannot declare `initial`. Final states cannot have outgoing transitions.

`on` maps event names to a target string, transition object, or nonempty array
of alternatives. Objects accept `target` (one string), optional named `guard`,
`description`, and boolean `reenter`. Targetless objects are internal transitions.
XState resolves sibling targets, `.child` targets, and `#id` / `#id.path` targets.
`always` and `onDone` use the same transition forms. The viewer labels completion
edges `done` and eventless edges `always`; it displays named guards as labels.

Limits: 100 nodes including the machine, eight levels below it, 200 transition
branches and 100,000 body characters. Text fields have 1–200 printable characters.
Unknown fields, missing targets/initials, duplicate IDs and unsupported constructs
are diagnosed. Actions, invocations, context expressions, history, executable
code and multi-target transitions are outside this read-only subset.

The GUI constructs XState's model and uses a native React/SVG hierarchy viewer
with local ELK layout. It never starts an actor, evaluates a guard or executes
artifact-supplied code. There is no Mermaid conversion, simulator, visual editor
or live Sacrum observation. Old `version` / `name` / `transitions` graph objects
are not XState configs and must be rewritten; malformed inputs keep their link
and show a diagnostic. The example can be imported into XState v5 directly.

For the complete machine and metadata files, read the
[published example](statecharts-example.md).

## Save, attach, read back, and reference

Use the actual existing ticket UUID as `TICKET_ID`. Run from the selected
project with the two files in the [published example](statecharts-example.md).
`task` is the API attachment type for tasks, tickets and epics. Saving and
attaching are one command; there is no separate `artifact attach` command:

```bash
vtb --json artifact add workflow.statechart.json --body-file workflow.statechart.json --subject-type task --subject-id "$TICKET_ID" --logical-name workflow-statechart --metadata-file workflow.metadata.json
```

Read the returned `artifact_id` (also `artifact.id`) and use that exact UUID
as `ARTIFACT_ID`. The logical name is local to that ticket. Verify its persisted
body and attachment metadata
by ticket-local lookup; `show` reads the file body by ID without attachment
metadata:

```bash
vtb --json artifact lookup workflow-statechart --subject-type task --subject-id "$TICKET_ID"
vtb --json artifact show "$ARTIFACT_ID"
```

Chat resolves attachments in the active project, including archived tickets.
Project attachments take precedence; otherwise the first task attachment by
UUID supplies metadata if the same file has several attachments. `update` with
a subject moves an artifact's sole attachment; it does not add another one.

Emit `[Ticket delivery](vtb://artifact/<actual-returned-id>)`, substituting the
actual returned UUID. Keep it as an ordinary Markdown link, without a code
fence or an artifact-reference output protocol. In chat, recognized statechart
metadata embeds the chart beside the clickable reference. Other artifact links
stay ordinary links. Missing artifacts keep the link; fetch failures offer a
retry, and malformed statecharts show a diagnostic. A link does not create,
execute, transition or start a workflow. An executable example verifies this
storage/rendering contract, not model instruction-following reliability.
