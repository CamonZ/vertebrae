## Part: document

Choose when the mechanism edited in place. Family: data and state; footprint: M.

Props:

- `line`: `{"type":"integer","min":1,"max":10,"default":5}`

Ports:

- `in`: in, W; tokens: `data`, `request`, `payload` — an edit (patch)

### document.read

read the document as it is now Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

### document.record

a patch edits a line in place; when the line has moved it does not apply and bounces back Card: required; tokens: any; default duration: 1.3 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","conflict"],"default":"ok"}`

### document.version

mark the current content as a version Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
