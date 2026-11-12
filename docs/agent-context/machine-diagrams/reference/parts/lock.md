## Part: lock

Choose when the mechanism one holder at a time. Family: data and state; footprint: S.

Props:

None.

Ports:

- `in`: in, W; tokens: `request` — acquire
- `out`: out, E; tokens: `request`, `result` — the holder, once it releases

### lock.acquire

take the lock, or wait outside for the holder to let go Card: required; tokens: request; default duration: 0.7 s.

Arguments:

None.

### lock.wait

time passes with the lock held Card: none; tokens: any; default duration: 1 s.

Arguments:

- `seconds`: `{"type":"number","min":0,"default":1}`

### lock.release

the holder lets go and leaves; the first waiter takes the latch Card: required; tokens: any; default duration: 0.8 s.

Arguments:

None.

### lock.expire

the holder crashed and its lease runs out: the lock frees itself and the first waiter takes it Card: none; tokens: any; default duration: 1.2 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
