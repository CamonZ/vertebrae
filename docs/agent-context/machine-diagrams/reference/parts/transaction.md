## Part: transaction

Choose when the mechanism all of it or none. Family: data and state; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `data`, `request`, `payload` — staged writes

### transaction.stage

a write is staged; nothing is written until the commit Card: required; tokens: data, request, payload; default duration: 0.9 s.

Arguments:

None.

### transaction.commit

every staged write lands together; another writer's conflict leaves them staged for a retry Card: none; tokens: any; default duration: 0.9 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","conflict"],"default":"ok"}`

### transaction.rollback

every staged write is thrown away and nothing is written Card: none; tokens: any; default duration: 1 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
