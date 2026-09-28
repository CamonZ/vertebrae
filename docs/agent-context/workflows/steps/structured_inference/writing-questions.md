# Writing questions

Purpose: write `instructions` and `criteria` that the decision model answers well.
Use this when: drafting questions, or answers look wrong, split, or low-confidence.

## The bar: a one-second judgment
Ask what a knowledgeable person decides in a second, given the right state.
"Does `report.repro_steps` say how to reproduce the bug?" works. "Should we
fix this now?" needs reasoning: split it into questions per factor and let the route
combine them. Reasoning belongs in the upstream llm_inference step.

## Instructions
- Write the complete question; question IDs are not shown to the model.
- The model reads literally: state the exact condition, including scope words
  ("any", "at least one", "only"). If you catch yourself explaining what you
  meant, that explanation belongs in the instruction.
- Name the state field by path with backticks: `` `report.error_message` ``.
- One condition per question. "Is it risky and untested?" is two questions.
- No double negatives or chains ("a property of a property"). Phrase so a high
  value or the first-listed meaning is the positive case.
- Instructions may be an object, e.g. `{"question": "...", "focus": "...",
  "compare": ["a.x", "b.y"]}`; the model sees the key names, so keep them short.

## Criteria by type
- **noul**: often optional. Add `{"true": ..., "false": ...}` when the boundary
  is subtle; `true` must mean yes. The value is a probability of yes, not a
  degree: use a score to measure how much of something there is.
- **choice**: give every option a description that separates it from its
  neighbours. For confusable options use objects such as
  `{"what": ..., "not_for": ..., "examples": [...]}`. Add `other` or `none`
  when the list may not cover every input. Up to 255 options.
- **score**: 2 to 10 levels, low to high. Describe situations, not degrees:
  "broken feature, workaround exists", not "moderate". Each level is judged
  alone; numbers, "worse than the previous level" and the level order mean
  nothing to the model. One dimension per score. Give a rare extreme its own
  level. Examples on levels help only when they resemble real inputs.
- Instructions and criteria must agree. Treat criteria as the rest of the
  instruction.

## Tuning
Low confidence means options overlap, the question asks two things, or the state lacks
the facts. Re-run rewrites on known cases; higher confidence alone doesn't prove them better.

## Related
[Questions](questions.md) · [Model limits](model-limits.md) · [Practices](practices.md)
