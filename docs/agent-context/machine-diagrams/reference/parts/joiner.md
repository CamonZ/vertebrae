## Part: joiner

Choose when the mechanism waits for all, then goes. Family: compute; footprint: M.

Props:

None.

Ports:

- `a`: in, W; tokens: `result`, `data`, `copy`
- `b`: in, W; tokens: `result`, `data`, `copy`
- `out`: out, E; tokens: `result`, `data`

### joiner.wait

a branch result seats in its ring Card: required; tokens: any; default duration: 0.6 s.

Arguments:

- `branch`: `{"type":"string","enum":["a","b"]}` — slot when the card did not arrive on a rail

### joiner.join

same as wait; reads as the arrival that completes the join Card: required; tokens: any; default duration: 0.6 s.

Arguments:

- `branch`: `{"type":"string","enum":["a","b"]}` — slot when the card did not arrive on a rail

### joiner.release

all slots full: one joined card leaves Card: optional; tokens: any; default duration: 0.9 s.

Arguments:

None.

### joiner.fail

Fail the join, close held branch cards and record the reason. Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `reason`: `{"type":"string"}` — e.g. b failed → fail fast

### joiner.cancel

discard the cards still waiting Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
