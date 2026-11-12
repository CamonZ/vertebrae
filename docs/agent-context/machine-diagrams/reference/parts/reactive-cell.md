## Part: reactive cell

Choose when the mechanism tells readers it changed. Family: data and state; footprint: S.

Props:

- `value`: `{"type":"string","default":"3"}`

Ports:

- `in`: in, W; tokens: `data`, `request`, `payload` — a write
- `out1`: out, E; tokens: `control`, `signal` — change notice to the first reader
- `out2`: out, E; tokens: `control`, `signal` — change notice to the second reader

### reactive cell.record

a write sets the value; writing the same value changes nothing and stays quiet Card: required; tokens: any; default duration: 0.8 s.

Arguments:

- `value`: `{"type":"string","default":"4"}`

### reactive cell.notify

send the change notice to one reader (out1 or out2) Card: optional; tokens: control, signal; default duration: 0.8 s.

Arguments:

- `reader`: `{"type":"string","enum":["out1","out2"],"default":"out1"}`
- `outcome`: `{"type":"string","enum":["ok","error"],"default":"ok"}`

### reactive cell.observe

a reader looks at the current value Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
