## Attachment: diff

Use for a git diff hunk or range.

- `path`: `{"type":"string"}`
- `patch`: `{"type":"string"}` — unified diff text
- `line`: `{"type":"integer","min":1}`
- `endLine`: `{"type":"integer","min":1}`
- `side`: `{"type":"string","enum":["old","new"],"default":"new"}`
- `base`: `{"type":"string"}`
- `head`: `{"type":"string"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
