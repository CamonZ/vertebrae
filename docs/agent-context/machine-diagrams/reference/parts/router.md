## Part: router

Choose when the mechanism picks one way out. Family: compute; footprint: S.

Props:

- `routes`: `{"type":"string[]","default":["/tasks","/runs","/health"]}` — labels of the r1, r2 and r3 rails
- `fallback`: `{"type":"boolean","default":false}` — unmatched cards take the fallback port instead of failing

Ports:

- `in`: in, W; tokens: `request`
- `r1`: out, E; tokens: `request`
- `r2`: out, E; tokens: `request`
- `r3`: out, E; tokens: `request`
- `fallback`: out, S; tokens: `request`, `result`; conditional/dashed — no match: fallback, or 404 when there is none

### router.route

match the card label (or `path`) against `routes` Card: required; tokens: request; default duration: 1 s.

Arguments:

- `path`: `{"type":"string"}` — defaults to the card label

### router.decide

send the card to a named way out Card: required; tokens: request; default duration: 1 s.

Arguments:

- `to`: `{"type":"string","enum":["r1","r2","r3","fallback","none"],"required":true}`

### router.fail

Report no matching route with the supplied reason. Card: none; tokens: any; default duration: 0.6 s.

Arguments:

- `reason`: `{"type":"string","default":"no route · 404"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
