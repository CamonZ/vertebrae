# Route decisions

Purpose: triage the human outcome and apply the evaluator verdict.
Use this when: adapting route targets or the structured loop-back handoff.

## Triage
`triage.json`, with concrete step IDs for `<stop>` and `<evaluate>`:
```json
{"version":1,"match_policy":"exactly_one","rules":[{"id":"rejected-premise","when":{"ref":"previous_output.outcome","op":"eq","value":"rejected_premise"},"transition":{"type":"intra_workflow","step_id":"<stop>"},"handoff":{}}],"default":{"transition":{"type":"intra_workflow","step_id":"<evaluate>"},"handoff":{}}}
```

## Verdict
`verdict.json`, with concrete step IDs for `<gate>` and `<finish>`:
```json
{"version":1,"match_policy":"exactly_one","rules":[{"id":"inadequate","when":{"ref":"previous_output.verdict.choice","op":"eq","value":"inadequate"},"transition":{"type":"intra_workflow","step_id":"<gate>"},"handoff":{"reasons":"{{ previous_output.reasons.choice }}","guidance":"{{ previous_output.guidance.choice }}"}}],"default":{"transition":{"type":"intra_workflow","step_id":"<finish>"},"handoff":{}}}
```

## Constraints
- Every step except `execute` needs `--harness`, including finish and route.
- Save a route config only after its predecessor output schema and target
  transitions exist; for this recipe, after gate -> triage and evaluate -> verdict.
- A loop-back handoff should be a JSON object, not a string, so the gate chat's
  verdict arrives as structured data.
- Put a route after the gate: the chat can show Accepted only when submission
  can move the run to another step.

## Related
[Configuration](configuration.md) · [Authoring commands](authoring.md) · [Route loops](../../workflows/steps/route/loops.md)
