# Before/After and change marks

Mark parts `unchanged` (default), `added`, `changed` or `removed`. A changed
part may override `props` and `changeNote` inside `before` and `after`; each
side merges with base props and defaults. Overrides require `change: changed`.
Rails accept `unchanged`, `added`, `removed`; mark the owning part for a
changed connection. Added parts/rails are absent Before; removed ones ghost
out After. Use a shared story and cards, not two unrelated drawings.

At this checkout marks are authored on parts and rails only. Ports, internal
stages and story steps have no authored marks. The player toggles arrangements
at the same beat; explain the result in captions without depending on motion.
Reduced motion shows settled states. See the [change recipe](recipes/before-after.md).

## Sibling implementation in progress

The [morph work](vtb://ticket/e0c5dbf0-e611-41ab-990b-88e11a3b537b) extends
marks and transitions. Its current unmerged spec defines:

- `PartSpec.portChanges`: a map of registered port names to change marks.
- `PartSpec.stageChanges`: a map of After-arrangement stage names to marks.
  Stage names come from pipeline `props.stages` (first three), saga's
  `reserve stock`, `charge card`, `ship`, or TaskRun `props.steps` stations.
  A kind without stages rejects `stageChanges`.
- `StepSpec.change`: a story step mark; added is intended for After only,
  removed for Before only, and changed/both for both arrangements.

These use `unchanged`, `added`, `changed`, `removed`. Illustrative unmerged
shape: `portChanges: {in: changed}`, `stageChanges: {parse: added}`, and
`steps: [{verb: stage, part: job, card: requestA, change: added}]`.
This checkout rejects these fields. Verify the sibling's final schema,
compiler and rendering before promoting them to the shipped format reference.
No port/stage object array or per-arrangement inner-mark override is defined.

The intended morph holds unchanged parts and shared band geometry still,
transitions marked parts and band contents, and snaps under reduced motion.
Reconcile with [drill-down](drill.md) when both land, including drilling during
a morph and a child with its own Before/After story.

[Authoring index](../machine-diagrams.md).
