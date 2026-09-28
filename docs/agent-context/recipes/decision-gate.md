# Recipe: decision gate

Purpose: turn messy input into an automated, auditable decision.
Use this when: a workflow must pick a path based on judgment.

## Shape
1. `<gather>` (llm_inference with an output schema): reads the input and writes
   the facts the decision needs as named fields: evidence, the item to judge,
   and any counts or comparisons already worked out.
2. `<judge>` (structured_inference, `--harness typesafe`): state built from
   `{{ steps.<gather>.output }}`; one question per factor.
3. `<decide>` (route): thresholds over the answers, one target per outcome, and
   a default for the uncertain middle.

## Route template
- `act`: `<q1>.noul gte 0.8` and `<q2>.noul gte 0.8` -> `<act target>`,
  handoff `{"decision": "act"}`.
- `dismiss`: `<q2>.noul lte 0.2` -> `<outcome target>`, handoff `{"decision": "dismiss"}`.
- default -> `<outcome target>`, handoff `{"decision": "uncertain"}`.
Disjoint because `act` needs `<q2>` at least 0.8 and `dismiss` at most 0.2.
For a choice question, one rule per option covers the closed enum.

## After the route
`previous_output` is empty after a route. The next step reads the decision
from `execution.handoff` and the facts from `steps.<gather>.output`.

## Gotchas
- Keep reasoning in `<gather>`; questions should be one-second judgments.
- Tune each threshold on real runs; start conservative.
- Conjunctions on tags or visit count are not overlap-checked when saved.

## Related
[structured_inference practices](../workflows/steps/structured_inference/practices.md) · [Writing questions](../workflows/steps/structured_inference/writing-questions.md) · [Partitions](../workflows/steps/route/partitions.md) · [Handoffs](../templating/handoffs.md)
