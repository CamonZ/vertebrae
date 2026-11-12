## Part: retry

Choose when the mechanism tries again, then gives up. Family: messaging and flow control; footprint: S.

Props:

- `attempts`: `{"type":"integer","min":1,"max":3,"default":3}`

Ports:

- `out`: out, E; tokens: `request` — request (attempt n)
- `in`: in, E; tokens: `result`

### retry.send

the next attempt leaves for the service Card: required; tokens: request; default duration: 0.6 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","error"]}` — `ok`: the service answers and the lamp turns green

### retry.wait

the attempt failed; back off before the next one Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `seconds`: `{"type":"number","min":0,"default":0.8}`

### retry.retry

back off, then send the same request again Card: required; tokens: request; default duration: 0.8 s.

Arguments:

- `seconds`: `{"type":"number","min":0,"default":0.8}`
- `outcome`: `{"type":"string","enum":["ok","error"]}`

### retry.fail

Give up retrying with the supplied reason. Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `reason`: `{"type":"string"}` — defaults to `gave up after <attempts>`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
