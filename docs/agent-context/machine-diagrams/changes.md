# Before/After and change marks

Mark parts `unchanged` (default), `added`, `changed` or `removed`. A changed
part may override `props` and `changeNote` inside `before` and `after`; each
side merges with base props and defaults. Overrides require `change: changed`.
Rails accept `unchanged`, `added`, `removed`; mark the owning part for a
changed connection. Added parts/rails are absent Before; removed ones ghost
out After. Use a shared story and cards, not two unrelated drawings.

## Ports, stages and story steps

- `portChanges` on a part maps registered port names to marks, e.g.
  `portChanges: {ctl: added, out: changed}`. Unknown ports are rejected.
- `stageChanges` maps stage names to marks for kinds with stages: pipeline
  `props.stages` (first three), saga `reserve stock`, `charge card`, `ship`,
  and TaskRun `props.steps` stations. Names are matched against the After
  props. Other kinds reject `stageChanges`.
- `change` on a story step: `added` runs only After, `removed` only Before,
  `changed` in both. Marked steps are listed on their beat's chapter in After
  (`+ worker · retry`) and in its accessible name.

Like part marks, these are drawn in After only, and any of them makes the spec
compile to two arrangements. Marks read without colour: + is a heavy ink
outline or solid tag, ~ corner brackets or an outlined tag, − dashed grey.

## Toggling

The player switches arrangements at the same beat (button or `b`). With
motion, the switch morphs on the shared layout for 0.6 s: unchanged parts and
rails stay still, added parts fade in as their outline draws on, removed parts
ghost out, changed parts' brackets flare and settle; band rows and the meter
cross-fade under a still divider. Reduced motion snaps to the settled
arrangement. Explain the result in captions without depending on motion. A
[drilled-into](drill.md) child keeps its own Before/After and morph. See the
[change recipe](recipes/before-after.md).

[Authoring index](../machine-diagrams.md).
