## Part: rate limiter

Choose when the mechanism spends tokens to pass. Family: messaging and flow control; footprint: M.

Props:

- `tokens`: `{"type":"integer","min":1,"max":4,"default":4}`

Ports:

- `in`: in, W; tokens: `request`
- `out`: out, E; tokens: `request` — request (token spent)

### rate limiter.send

a card passes by spending a token; none left means it waits Card: required; tokens: request; default duration: 1.1 s.

Arguments:

None.

### rate limiter.wait

Wait the supplied seconds without adding a token; use refill to replenish. Card: none; tokens: any; default duration: 1 s.

Arguments:

- `seconds`: `{"type":"number","min":0,"default":1}`

### rate limiter.refill

the bucket gains a token Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

### rate limiter.fail

no token and no waiting: the card is rejected with a 429 Card: required; tokens: request; default duration: 0.8 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
