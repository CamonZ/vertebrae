## Part: pool

Choose when the mechanism a fixed number of seats. Family: compute; footprint: L.

Props:

- `seats`: `{"type":"integer","min":1,"max":3,"default":3}`

Ports:

- `in`: in, W; tokens: `request`, `data`, `payload`
- `out`: out, E; tokens: `result`, `request`

### pool.spawn

a job takes a free seat, or waits outside for one Card: required; tokens: any; default duration: 0.7 s.

Arguments:

None.

### pool.wait

Show current occupancy while waiting the supplied seconds. Card: none; tokens: any; default duration: 1 s.

Arguments:

- `seconds`: `{"type":"number","min":0,"default":1}`

### pool.release

a seated job leaves as its result; the first waiter takes the seat Card: required; tokens: any; default duration: 0.8 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","error"],"default":"ok"}`

### pool.drain

stop taking jobs; report occupancy Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

### pool.close

the pool closes: waiters give up Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
