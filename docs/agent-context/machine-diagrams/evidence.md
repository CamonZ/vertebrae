# Attachments and evidence

Attach evidence at the root, part, rail, card or beat using `attachments`.
Every entry requires `kind`; optional common fields are `id`, `title`,
`status` (`verified` or `inferred`, default inferred), and `source` (`scenario`
or `trace`, default scenario). Verified means the author checked the claim
against code or a run. A file path alone does not verify it. A trace comes
from a recorded run; label invented traffic and timings scenario even when
the code claim is verified. The viewer displays labels without checking evidence.

Choose `note` for explanation, `ref` for source, `diff` for a patch/range,
`formula` for a calculation, `payload comparison` for expected versus actual,
`ui crop` for a screenshot, `timing` for a duration, `schema diff` for a config
change, and `test summary` for test counts. Read each kind's required fields
and bounds in the [attachment reference](reference/attachments.md).

Ref line numbers start at 1; `endLine` must be at least `line`. Diff requires
`patch` or `base` (provide `head` too for a useful range); schema diff requires
`before` or `after`. Source navigation opens in Changes when its host supports
that capability. A test summary reports actual commands and results; it does
not run tests or prove a claim automatically.

[Authoring index](../machine-diagrams.md).
