# Flow spec format (version 1)

The root requires `version: 1` and a nonempty `parts` array. Optional fields
are `labels`, `title`, `direction`, `arrangements`, `baseline`, `phases`, `rails`, `regions`,
`cards`, `story`, `band`, and `attachments`.
IDs start with an ASCII letter and continue with letters, digits, `_` or `-`;
keep each list's IDs unique. Kind strings may contain spaces. Unknown fields
and unregistered names are errors.

| Object | Fields and meaning |
| --- | --- |
| Arrangements | Names, or `{name, label}`; `baseline` names one (default the first). Absent: Before/After or `current` |
| Phases | Instead of `arrangements`: names, or `{name, label}`, in migration order; no `baseline` |
| Part | Required `id`, `kind`; optional `label` (defaults to kind), `job`, `labels`, `props`, `change`, `changeNote`, `portChanges`, `stageChanges`, `before`, `after`, `in`, `arrangement`, `position`, `scale`, `attachments`, `drill` |
| Rail | Required `id`, `from`, `to` as `partId.port`; optional `label`, `conditional` (dashed conditional lane), `change`, `in`, `attachments` |
| Region | Required `id`, nonempty `parts` (part IDs); optional `label`. A part belongs to at most one region; use for a process, trust zone or container |
| Card | Required `id`, `token`; optional `label` (defaults to ID), `payload`, `origin` (part ID), `attachments` |
| Beat | Optional `id`, `caption`, `phase` (with `phases`: the phase it starts), `steps`, `hold`, `attachments`. Give IDs to beats referenced by band rows |
| Step | Required `verb`, `part`; optional `card`, `via`, `with`, `delay`, `args`, `checkpoint`, `change`, `in` |

`position: {x: 0, y: 100}` places a part's 640×400 cell; omit it to
auto-layout with ELK. `scale` is 0.1–4; defaults follow the part footprint:
S 0.5, M 0.75, L 1. Every arrangement shares placement, rails and canvas.
`change`/`before`/`after` are the Before/After shorthand; `in`/`arrangement`
need named `arrangements` or `phases` ([changes](changes.md)).
Each deeper level has its own layout.

`direction` sets which way cards travel: `right` (default), `left`, `down`
or `up`; anything else is an error. Author parts, rails and `position`
left to right as usual: the whole diagram is turned, so `left` mirrors it and
`down`/`up` transpose it (cells become 400×640, rails and gates run
vertically, returns run beside the parts instead of above or below). Text is
never rotated or mirrored: part titles, status lines, change tabs, rail and
region labels stay upright and are placed beside the turned shapes. Every
built-in kind turns; none falls back. Kinds with a meaningful vertical (the
human gate's reviewer lane, stacked stores) read with their top turned to the
left in `down` and `up`. A drill-down's spec has its own `direction`.

All built-in kinds have drawings. Extensions register through
`FlowRegistryContext`; a registered custom kind without a drawing shows a plain
frame. Writing a kind name in a spec does not register it. A label renames an
instance, never its kind or ports. The generated `flowSpecJsonSchema(registry)`
describes registered props and arguments; the validator also checks references.

[Authoring index](../machine-diagrams.md); [reference](../machine-diagrams-reference.md).

## Part title and subtitle placement

Set `labels: {title: shown, subtitle: below}` at the root to place the job
line below the part name. Each part can override either field with its own
`labels` object; unspecified fields inherit the diagram policy.

- `title`: `shown`, `hover`, or `hidden`.
- `subtitle`: `beside`, `below`, `hover`, or `hidden`.

When a labels object is present, omitted fields resolve to `shown` and
`beside`. Beside puts the job after a middle dot on the name line; below puts
it on a separate line. With the title hidden, the subtitle occupies its own
line. Shown headers sit above the frame, remain readable below full scale,
and reserve auto-layout space. Hover labels reveal on pointer hover or keyboard
focus, paint over the diagram without moving parts or rails, and disappear
when neither hover nor focus remains. The accessible name always includes both
name and job. Hand-given positions remain the author's responsibility.

Omit `labels` at both levels to preserve the original rendering exactly:
`name · job` at full scale, and only the name above smaller frames. This also
preserves existing gallery parity frames. The dev gallery's Title and Subtitle
selectors exercise the same placement policy; default restores the legacy view.
