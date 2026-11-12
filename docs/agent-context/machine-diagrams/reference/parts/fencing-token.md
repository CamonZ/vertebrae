## Part: fencing token

Choose when the mechanism stops a stale holder writing. Family: distributed systems; footprint: L.

Props:

None.

Ports:

- `in`: in, W; tokens: `request`, `data`
- `out`: out, E; tokens: `result`, `data`

### fencing token.fence

Give holder B the specified lease token. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

- `token`: `{"type":"integer","min":0,"max":1000000,"default":34}`

### fencing token.record

Compare the supplied token (or current lease token) with the maximum accepted token; accept equal or newer tokens as results, consume stale writes. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `token`: `{"type":"integer","min":0,"max":1000000}`

### fencing token.fail

Explicitly reject and consume a stale-token write. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
