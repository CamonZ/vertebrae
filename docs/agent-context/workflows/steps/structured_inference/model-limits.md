# Model limits

Purpose: avoid questions the decision model is known to get wrong.
Use this when: a question involves numbers, dates, lists, or untrusted text.

Source: TypeSafe's jev-1.13 jaggedness list (reviewed 2026-09-17), at
<https://docs.typesafe.ai/model-jaggedness/jev-1.13>. Recheck it when you pin a newer model.

| Weak at | In a vtb workflow, do this instead |
|---|---|
| Literal reading: answers what you wrote, not what you meant | State the exact condition; put edge cases in criteria ([writing questions](writing-questions.md)) |
| Counting, arithmetic, numeric closeness | Have the llm_inference step output the number; compare it in a route (`gte`, `lt`) |
| Dates as ordered values (before, after, within a window) | Have the llm_inference step output the comparison or the parts; route on them |
| Multi-step reasoning, double negatives | One step per question; name the state field by path |
| Large state with irrelevant detail | Send only the fields the questions need |
| Hostile content in state (injected instructions, text arguing for a label) | Explicit criteria; treat user-submitted text, diffs and comments as untrusted; test edge cases |
| Instructions and criteria that disagree | Make the criteria continue the instruction |
| Consistency across questions | Don't expect P(x) + P(not x) = 1, or a noul and a choice to agree. Ask each decision one way |
| Generating text | Use llm_inference; turn extraction into a choice over known options |

## Consequences for routes
- Tune thresholds per question. A threshold that works for a noul does not
  carry over to a choice's `probabilities.<opt>`.
- A choice is relative (which option fits best); a noul is absolute (it can be
  low for every option). Use a noul when "none of these" must be detectable.
- Questions in one step are independent: one answer is never context for
  another. When a question depends on an answer, use a second step.
- Avoid questions over whole lists ("does every item..."). They are
  counting in disguise. Have the llm_inference step pick the item to judge
  (e.g. `top_item`) or emit a per-item flag, then judge that.

## Related
[Writing questions](writing-questions.md) · [Practices](practices.md) · [Routable fields](routable-fields.md)
