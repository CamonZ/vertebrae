# Drill-down

A part may have exactly one of `drill: {spec: <complete flow spec>}` or
`drill: {artifact: <actual saved flow artifact UUID>}`. Inline children have
their own IDs, cards, story and layout. The validator rejects recursive YAML
aliases, nesting beyond eight levels and more than 64 inline sub-specs.
Use an artifact to keep a large parent compact; its body and metadata follow
the [saving contract](artifacts.md). See the [inline recipe](recipes/drill.md).

## Viewing

- A part with a target shows a stacked-frames badge outside its top-right
  corner (a shape, not a colour), and its accessible name says it opens a
  deeper diagram.
- Clicking the part, or Enter/Space while it has focus, opens the child in
  the same place, with a breadcrumb: Back returns one level and each ancestor
  in the trail can be selected. Esc stays with the enclosing panel; it does
  not go up a level.
- The parent player stays mounted, hidden and paused, so returning finds its
  beat, arrangement, pinned part and followed card as they were,
  with focus back on the part that was opened.
- Inline children use their compiled per-level layout; artifact children load
  from the current project's artifact presentations and are laid out on their
  own. A child may drill further and may have its own arrangements.
- Missing artifacts, non-flow metadata, load failures and invalid bodies show
  as errors in place of the child; load failures offer Retry.

Reconcile preservation during a morph with the
[change-marking sibling](changes.md) when the two implementations meet.

[Authoring index](../machine-diagrams.md).
