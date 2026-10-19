# Authoring commands

Purpose: create the workflow in an order the backend can validate.
Use this when: copying or adapting the runnable recipe.

The creation commands print `Created workflow: <id>` and `Created step: <id>`;
the helper captures those IDs. Route configs are saved last because their
references are validated against predecessor schemas and existing transitions.

```sh
vtb_id() { awk '{print $NF}'; }

workflow=$(vtb workflow add "Conversational Review" \
  --factory-name "Human Input Demos" \
  --kanban-column "Review" | vtb_id)

stop=$(vtb step add "Reject premise" -w "$workflow" \
  --harness claude --step-type stop | vtb_id)
finish=$(vtb step add "Accepted" -w "$workflow" \
  --harness claude --step-type finish | vtb_id)
gate=$(vtb step add "answer_question" -w "$workflow" \
  --harness claude --step-type human_input \
  --instructions @gate.liquid --artifact answer \
  --output-schema @answer.schema.json | vtb_id)
evaluate=$(vtb step add "Evaluate answer" -w "$workflow" \
  --harness typesafe --step-type structured_inference \
  --provider typesafe --model jev-1.13 \
  --state @evaluate.state.json --questions @questions.json | vtb_id)
triage=$(vtb step add "Triage answer" -w "$workflow" \
  --harness claude --step-type route \
  --transition-to "$stop" --transition-to "$evaluate" | vtb_id)
verdict=$(vtb step add "Apply verdict" -w "$workflow" \
  --harness claude --step-type route \
  --transition-to "$gate" --transition-to "$finish" | vtb_id)

vtb step update "$gate" --transition-to "$triage"
vtb step update "$evaluate" --transition-to "$verdict"

sed -e "s/<stop>/$stop/" -e "s/<evaluate>/$evaluate/" \
  triage.json > triage.final.json
sed -e "s/<gate>/$gate/" -e "s/<finish>/$finish/" \
  verdict.json > verdict.final.json
vtb step update "$triage" --route-config "$(cat triage.final.json)"
vtb step update "$verdict" --route-config "$(cat verdict.final.json)"
```

## Related
[Configuration](configuration.md) · [Route decisions](routes.md) · [Resolution](resolution.md)
