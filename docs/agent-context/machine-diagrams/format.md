# Flow spec format (version 1)

The root requires `version: 1` and a nonempty `parts` array. Optional fields
are `title`, `arrangements`, `baseline`, `rails`, `regions`, `cards`, `story`,
`band`, and `attachments`.
IDs start with an ASCII letter and continue with letters, digits, `_` or `-`;
keep each list's IDs unique. Kind strings may contain spaces. Unknown fields
and unregistered names are errors.

| Object | Fields and meaning |
| --- | --- |
| Arrangements | Names, or `{name, label}`; `baseline` names one (default the first). Absent: Before/After or `current` |
| Part | Required `id`, `kind`; optional `label` (defaults to kind), `job`, `props`, `change`, `changeNote`, `portChanges`, `stageChanges`, `before`, `after`, `in`, `arrangement`, `position`, `scale`, `attachments`, `drill` |
| Rail | Required `id`, `from`, `to` as `partId.port`; optional `label`, `conditional` (dashed conditional lane), `change`, `in`, `attachments` |
| Region | Required `id`, nonempty `parts` (part IDs); optional `label`. A part belongs to at most one region; use for a process, trust zone or container |
| Card | Required `id`, `token`; optional `label` (defaults to ID), `payload`, `origin` (part ID), `attachments` |
| Beat | Optional `id`, `caption`, `steps`, `hold`, `attachments`. Give IDs to beats referenced by band rows |
| Step | Required `verb`, `part`; optional `card`, `via`, `with`, `delay`, `args`, `checkpoint`, `change`, `in` |

`position: {x: 0, y: 100}` places a part's 640×400 cell; omit it to
auto-layout with ELK. `scale` is 0.1–4; defaults follow the part footprint:
S 0.5, M 0.75, L 1. Every arrangement shares placement, rails and canvas.
`change`/`before`/`after` are the Before/After shorthand; `in`/`arrangement`
need named `arrangements` ([changes](changes.md)).
Each deeper level has its own layout.

All built-in kinds have drawings. Extensions register through
`FlowRegistryContext`; a registered custom kind without a drawing shows a plain
frame. Writing a kind name in a spec does not register it. A label renames an
instance, never its kind or ports. The generated `flowSpecJsonSchema(registry)`
describes registered props and arguments; the validator also checks references.

[Authoring index](../machine-diagrams.md); [reference](../machine-diagrams-reference.md).
