# Step types

Purpose: choose the right step type and know who executes it.
Use this when: designing a workflow or explaining a step.

## Pick by intent
| You want to... | Use |
|---|---|
| Have an agent read code, run tools, write or summarize | llm_inference |
| Get a calibrated yes/no, category or score from gathered facts | structured_inference |
| Compute or reshape JSON with a deterministic Rhai script | [execute](execute/index.md) |
| Branch on a prior result, level, tags or loop count | route |
| Run a task's children and continue when they finish | wait_children |
| End this run here and continue from the next step later | stop |
| Mark the task done | finish |
| Wait for a person | human_input (limited, see its doc) |

## Comparison
| Type | Handled by | Output | Outgoing edges |
|---|---|---|---|
| llm_inference | daemon, `claude` or `codex` harness | text, or JSON with output_schema | 1 |
| structured_inference | daemon, `typesafe` harness | JSON derived from questions | 1 |
| execute | daemon, bounded Rhai worker; no harness | JSON validated against output_schema | 1 |
| route | backend | none (audited decision + handoff) | per intra target |
| wait_children | backend | `wait_children_status` snapshot | 1 |
| stop | backend | none | 1 |
| finish | backend | none | 0 |
| human_input | backend | none | 1 |

## Pattern
Gather with llm_inference, judge with structured_inference, decide with route.
The LLM turns messy input into facts; the decision provider scores them; the
route applies explicit thresholds.

For deterministic arithmetic or JSON reshaping, use execute between the producer
and consumer. It consumes this TaskRun's resolved JSON and returns validated JSON;
the backend continues to own progression and retries.

## Gotchas
- Step type is fixed after creation; create a new step to change it.
- Inference types pick their runtime with [harness](harness.md). Execute must omit
  the harness and provider settings; use `--step-type execute --script @file.rhai`
  and `--output-schema` to create it, then `step update --script` to edit it.

## Related
[Transitions](../transitions.md) · [Templating](../../templating/index.md)
