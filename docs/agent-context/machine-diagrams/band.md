# Situation band

`band` adds a summary below a fixed divider. Optional `heading`; required
nonempty `rows`. Each row has a nonempty `name`, optional `note`, nonempty
`chips`, and nonempty unique `beats` referencing explicit story beat IDs.
`note` and `chips` accept a single value or one per arrangement by name
(`{before: …, after: …}`, or `{current: …, A: …, B: …}` with named
arrangements), every arrangement required. Rows light during their
referenced beats, not arbitrary times.

The optional `meter` requires `label` and `marker` (a nonempty string or unique
nonempty list of strings), with optional `footnote`. It counts compiler markers
such as `spawn`, `resume`, `close`, `checkpoint`, `arrival`; it is not a freely
authored counter. The default footnote lists each arrangement's count, e.g.
`before: 2  ·  after: 1`.
The divider and band geometry stay shared while contents differ.

The [Before/After recipe](recipes/before-after.md) includes a band whose meter
counts process starts from the session compiler rather than its captions.

[Authoring index](../machine-diagrams.md).
