## Part: trace

Choose when the mechanism nested timings. Family: observability; footprint: L.

Props:

None.

Ports:

None.

### trace.span

a leaf span, nested under the open spans Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `name`: `{"type":"string","default":"span"}`
- `seconds`: `{"type":"number","min":0,"default":0.8}`

### trace.stage

open a span that later spans nest inside Card: none; tokens: any; default duration: 0.5 s.

Arguments:

- `name`: `{"type":"string","default":"request"}`

### trace.finish

close every open span and name the outcome Card: none; tokens: any; default duration: 0.6 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","error"],"default":"ok"}`
- `total`: `{"type":"string"}` — elapsed time for the status line, e.g. `3.1 s`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
