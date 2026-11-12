## Part: cache

Choose when the mechanism answers from memory. Family: data and state; footprint: S.

Props:

None.

Ports:

- `in`: in, W; tokens: `request`, `data`
- `answer`: out, W; tokens: `data`, `result` — a hit, or a miss filled from the origin
- `origin`: out, E; tokens: `request` — a miss goes on to the origin
- `fill`: in, E; tokens: `data`, `result` — the origin's answer fills the cache

### cache.read

look the key up: a cached key answers from memory (a hit), any other goes on to the origin Card: required; tokens: any; default duration: 1.7 s.

Arguments:

- `key`: `{"type":"string","default":"k2"}`

### cache.miss

a lookup that is known to miss (a stale or invalidated key): straight to the origin Card: required; tokens: any; default duration: 1.5 s.

Arguments:

- `key`: `{"type":"string","default":"k2"}`

### cache.record

the origin's answer fills an entry and goes back to the caller Card: required; tokens: data, result; default duration: 1.2 s.

Arguments:

- `key`: `{"type":"string","default":"k2"}`
- `outcome`: `{"type":"string","enum":["ok","error"],"default":"ok"}`

### cache.expire

an entry's time to live runs out and it is dropped Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `key`: `{"type":"string","default":"k2"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
