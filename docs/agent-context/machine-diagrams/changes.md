# Arrangements and change marks

One spec can show several arrangements of the same machine; the reader
switches between them in place. Use the Before/After shorthand for one
change, and named arrangements to compare options (A adds x, y and z; B adds
only y and z, wired differently). Keep one shared story and cards, never
unrelated drawings: the difference in outcome is computed.

## Before/After shorthand

Mark parts `unchanged` (default), `added`, `changed` or `removed`. A changed
part may override `props` and `changeNote` inside `before` and `after`; each
side merges with base props and defaults. Overrides require `change: changed`.
Rails accept `unchanged`, `added`, `removed`; mark the owning part for a
changed connection. Added parts/rails are absent Before; removed ones ghost
out After. Any mark compiles the spec to `[before, after]`, `before` the
baseline; a spec with none compiles to one `current` arrangement.

- `portChanges` on a part maps registered port names to marks, e.g.
  `portChanges: {ctl: added, out: changed}`. Unknown ports are rejected.
- `stageChanges` maps stage names to marks for kinds with stages: pipeline
  `props.stages` (first three), saga `reserve stock`, `charge card`, `ship`,
  and TaskRun `props.steps` stations, matched against the After props.
- `change` on a story step: `added` runs only After, `removed` only Before,
  `changed` in both. Marked steps are listed on their beat in After.

## Named arrangements

`arrangements: [current, A, B]` lists names (or `{name, label}` for the
selector's text); `baseline:` names the one the others are marked against
(default the first). Authors write presence, not marks:

- `in: [A, B]` on a part, rail or step: present only there. Default: all; a
  rail defaults to where both its parts are, a step to where its part and
  `via` rail are. Listing an arrangement where they are absent is an error.
- `arrangement: {A: {props, changeNote, portChanges, stageChanges}}` on a
  part overrides it per arrangement.
- Captions, band `note` and `chips` take a map by name; a band map gives
  every arrangement, a caption map may skip one (it continues the last).

Marks are computed against the baseline: added (not in the baseline),
removed (only in the baseline; it ghosts out), changed (resolved props or
`changeNote` differ from the baseline's). Steps are listed + or − on their
beat the same way. The baseline draws no marks. `change`, `before`, `after`
and top-level `portChanges`/`stageChanges` are shorthand-only. See the
[options recipe](recipes/options.md).

Marks read without colour: + is a heavy ink outline or solid tag, ~ corner
brackets or an outlined tag, − dashed grey.

## Switching

The selector lists every arrangement; `b` steps to the next, `⇧B` to the
previous (with two, a toggle). The story beat, pinned part and followed card
stay; where the beat has no caption, the caption it continues shows.
With motion, the switch morphs between any two on the shared layout for
0.6 s: what reads the same stays still, added parts fade in as their outline
draws on, removed parts ghost out, changed parts' brackets flare; band rows
and the meter cross-fade under a still divider. Reduced motion snaps.
Explain the result in captions without depending on motion. A
[drilled-into](drill.md) child keeps its own arrangements. See the
[change recipe](recipes/before-after.md).

[Authoring index](../machine-diagrams.md).
