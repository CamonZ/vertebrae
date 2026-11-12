# Drill-down

A part may have exactly one of `drill: {spec: <complete flow spec>}` or
`drill: {artifact: <actual saved flow artifact UUID>}`. Inline children have
their own IDs, cards, story and layout. The validator rejects recursive YAML
aliases, nesting beyond eight levels and more than 64 inline sub-specs.
Use an artifact to keep a large parent compact; its body and metadata follow
the [saving contract](artifacts.md). See the [inline recipe](recipes/drill.md).

The schema, compiler and per-level layout support references at this checkout.
The [drill-down sibling](vtb://ticket/5bcac569-a55b-4f74-a0fc-679f152d978c)
currently implements the following viewer behavior in its unmerged worktree:

- Parts with targets get a non-color-only affordance; click or keyboard
  activation opens a child in the same viewport, with a breadcrumb and Back.
- Parent players stay mounted, hidden and paused so returning preserves beat,
  arrangement, pinned part and followed card. Esc goes up after the player
  has no local selection/help to clear; breadcrumb ancestors can be selected.
- Inline children use their compiled per-level layout; artifact children load
  from the current project's artifact presentations and use their own layout.
- Missing artifacts, non-flow metadata, loading failures and invalid bodies
  show in-place errors; fetch failures offer Retry.

These navigation details are not shipped in this checkout; verify that
implementation and tests before claiming availability. A child may have its
own Before/After. Reconcile preservation during a morph with the
[change-marking sibling](changes.md) when the two implementations meet.

[Authoring index](../machine-diagrams.md).
