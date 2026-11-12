## Part: store

Choose when the mechanism keeps records. Family: data and state; footprint: M.

Props:

- `rows`: `{"type":"integer","min":0,"max":8,"default":4}`

Ports:

- `in`: in, W; tokens: `data`, `request`, `payload`
- `out`: out, E; tokens: `data`, `result`

### store.record

insert a record; a duplicate key is rejected and bounces back Card: required; tokens: any; default duration: 0.7 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","conflict"],"default":"ok"}`

### store.read

read a row: it leaves as data, or the read finds nothing and stops Card: optional; tokens: any; default duration: 0.9 s.

Arguments:

- `row`: `{"type":"string","default":"row 2"}`
- `outcome`: `{"type":"string","enum":["ok","missing"],"default":"ok"}`

### store.delete

remove a record Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

### store.snapshot

note the rows as they are now Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
