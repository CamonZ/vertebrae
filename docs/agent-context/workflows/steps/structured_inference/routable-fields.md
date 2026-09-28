# Routable fields

Purpose: know the exact output shape so routes and handoffs reference real fields.
Use this when: writing route rules or handoffs after a structured_inference step.

## Output shape (one entry per question ID)
- noul: `{"type":"noul","noul":0.93}`
- choice: `{"type":"choice","choice":"api","probabilities":{"ui":0.02,...},"confidence":0.81}`
- score: `{"type":"score","score":1.95,"legend":{"0":"...",...},"probabilities":{"0":0.1,...},"confidence":0.6}`

## In routes
| Ref | Kind | Typical use |
|---|---|---|
| `previous_output.<q>.noul` | number 0..1 | threshold (`gte 0.8`) |
| `previous_output.<q>.choice` | closed enum | partition by option, no default needed |
| `previous_output.<q>.confidence` | number 0..1 | require certainty with a choice |
| `previous_output.<q>.probabilities.<opt>` | number 0..1 | threshold on one option |
| `previous_output.<q>.score` | number 0..max | threshold on the expected level |

## Gotchas
- `score` is an expected value (probability-weighted mean), not the most
  likely level: 1.95 can mean "split between 1 and 3". Use
  `probabilities.<level>` when you need "most likely level N".
- Numeric thresholds leave gaps and edges; include a `default`.
- `previous_output` is the immediately preceding completed step. Put the route
  right after the structured_inference step.

## Related
[route](../route/index.md) · [Questions](questions.md)
