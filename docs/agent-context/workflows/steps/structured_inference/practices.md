# Practices

Purpose: get reliable decisions out of structured_inference.
Use this when: designing a gate, shaping state, or tuning thresholds.

## Gather, judge, decide
1. An llm_inference step does the reasoning and writes the facts as structured
   output: evidence quotes, a chosen item to judge, counts and date comparisons.
2. structured_inference makes one-second judgments on those facts.
3. A route combines the answers with explicit thresholds and picks the next step.
The LLM reasons over messy input; the decision model judges steadily; the route
keeps the policy visible and editable. If a question needs reasoning, move that
reasoning into step 1's output schema ([model limits](model-limits.md)).

## State
- Use an object with descriptive field names, and refer to them by path in the
  instructions. Build it from prior structured outputs with whole-string
  references (`"report": "{{ steps.summarize.output }}"`) so JSON keeps its type.
- Send only what the questions need; unrelated detail lowers accuracy.
- Size (jev-1.13): 32k tokens for state plus the longest question, 64k for the
  whole request. English gets the best accuracy.
- State is data, not instructions, but the model does not treat it as hostile.
  Summaries of untrusted text (issue bodies, comments) are safer than raw text.

## Models
Set `--harness typesafe` explicitly. Pin an exact model version for reproducible decisions; update deliberately.
Recheck [model limits](model-limits.md) and thresholds when you change versions.
The provider needs its API key configured on the daemon (see [setup/config](../../../setup/config.md)).

## Thresholds
- Set them per question from the cost of a wrong answer: raise the bar when a
  false yes is expensive, lower it when a missed yes is expensive.
- Start conservative (e.g. `gte 0.8` to act, `lte 0.2` to dismiss, default for
  the uncertain middle). Adjust from the artifacts of real runs.
- On a choice, pair the option with `confidence` to require a clear winner.

## Related
[Writing questions](writing-questions.md) · [Routable fields](routable-fields.md) · [Decision gate](../../../recipes/decision-gate.md)
