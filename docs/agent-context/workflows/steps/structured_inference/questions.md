# Questions

Purpose: define what a structured_inference step decides.
Use this when: writing or changing `--questions`.

## How it works
`--questions` is a JSON object keyed by question ID (normalized to
snake_case). Each question has `type`, `instructions`, and `criteria`:
| Type | Criteria | Answers |
|---|---|---|
| `noul` | optional `{"true": "...", "false": "..."}` | probability the statement is true |
| `choice` | object `{option: description}`; options are the enum (1-255) | one option plus per-option probabilities |
| `score` | array of 2-10 level descriptions, index = level | an expected level plus per-level probabilities |

`instructions`, option descriptions, levels and noul criteria can each be a
string, object or array. Questions are static: they are not templated, so
dynamic content goes in `--state`. The backend derives the step's output schema
from the questions, so routes, handoffs and artifacts can use the answers
without a separate schema.

## Doing it
```json
{"reproducible": {"type": "noul",
   "instructions": "Does `report.repro_steps` give steps that someone else could follow to see the bug?",
   "criteria": {"true": "Concrete steps, inputs and the observed result are stated",
                "false": "Steps are missing, vague, or only describe the symptom"}},
 "area": {"type": "choice",
   "instructions": "Which part of the product does `report.summary` describe as failing?",
   "criteria": {"ui": "Screens, layout or interaction in the app",
                "api": "Requests, responses or errors from the service",
                "data": "Stored records that are wrong, missing or duplicated",
                "other": "None of the above"}}}
```
`vtb step add "Gate" -w <wf> --step-type structured_inference --harness typesafe --provider typesafe --model <pinned> --state @state.json --questions @questions.json`

## Gotchas
- Ask about facts present in the state; the provider does not browse or run tools.
- One question per decision; routes combine them.
- Changing questions changes the output schema; revalidate routes that read it.

## Related
[Writing questions](writing-questions.md) · [Model limits](model-limits.md) · [Routable fields](routable-fields.md) · [State templating](../../../templating/state.md)
