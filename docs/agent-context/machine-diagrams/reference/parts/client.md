## Part: client

Choose when the mechanism asks, then renders. Family: actors; footprint: M.

Props:

None.

Ports:

- `request`: out, E; tokens: `request`, `control`, `payload`
- `result`: in, E; tokens: `result`

### client.send

Send a request and increment the waiting count. Card: required; tokens: request, payload; default duration: 0.45 s.

Arguments:

None.

### client.wait

Keep the client waiting for the supplied seconds. Card: none; tokens: any; default duration: 1 s.

Arguments:

- `seconds`: `{"type":"number","min":0,"default":1}`

### client.render

Render a returned card; outcome selects success or error. Card: required; tokens: any; default duration: 0.5 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","error"],"default":"ok"}`

### client.cancel

Send a control card to cancel the request. Card: required; tokens: control; default duration: 0.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
