## Part: event rail

Choose when the mechanism ordered facts. Family: messaging and flow control; footprint: L.

Props:

None.

Ports:

- `in`: in, W; tokens: `event`, `result`, `request`, `signal`
- `out`: out, E; tokens: `event`, `result`, `request`, `signal`

### event rail.send

Carry the named card across the rail, or emit a dot when no card is supplied; record the event name. Card: optional; tokens: any; default duration: 0.7 s.

Arguments:

- `event`: `{"type":"string"}` — event name for the status line
- `role`: `{"type":"string","enum":["dim","ink","amber","green","red"],"default":"ink"}`

### event rail.observe

Show that the event stream is live. Card: none; tokens: any; default duration: 0.5 s.

Arguments:

None.

### event rail.wait

Show a disconnected stream. Card: none; tokens: any; default duration: 1 s.

Arguments:

None.

### event rail.resume

Reconnect from the supplied event offset (or the number already sent), then show caught up. Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `from`: `{"type":"integer","min":0}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
