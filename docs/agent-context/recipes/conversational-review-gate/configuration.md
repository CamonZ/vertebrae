# Configuration

Purpose: define the gate response and the bounded evidence the evaluator sees.
Use this when: adapting this recipe's schema, questions, state, role, or gate question.

## Gate response
`answer.schema.json`:
```json
{"type":"object","required":["outcome","answer","rationale"],"properties":{"outcome":{"type":"string","enum":["resolved","rejected_premise"],"description":"Is the question valid, or does it rest on a false premise?"},"answer":{"type":"string","minLength":1,"description":"What is the answer to the question?"},"rationale":{"type":"string","minLength":1,"description":"Why is that the answer?"}}}
```

Property descriptions are the questions: the gate chat asks for each field in
schema order using its description, so write every description as the question
the human should be asked.

## Evaluator questions
`questions.json`:
```json
{
  "verdict": {"type":"choice","instructions":"Is state.answer a complete, accurate response to state.question, as supported by state.rationale?","criteria":{"adequate":"The answer addresses the question and the rationale supports it","inadequate":"The answer is incomplete, inconsistent with the rationale, or does not address the question"}},
  "reasons": {"type":"choice","instructions":"If inadequate, what is the primary defect?","criteria":{"incomplete":"Required information is missing","inconsistent":"The answer and rationale conflict","off_topic":"The answer does not address the question"}},
  "guidance": {"type":"choice","instructions":"If inadequate, what should the human do next?","criteria":{"supply_missing_information":"Add the specific missing information","resolve_contradiction":"Make the answer and rationale agree","answer_the_question":"Reply directly to the question asked"}}
}
```

## Bounded evaluator state
`evaluate.state.json` exposes only the question, human answer, and rationale:
```json
{
  "question": "{{ task.title }} — {{ task.description }}",
  "answer": "{{ steps.answer_question.output.answer }}",
  "rationale": "{{ steps.answer_question.output.rationale }}"
}
```

## Gate role
`gate.role.md` is stored verbatim and never rendered. It sets how the resolving
agent behaves; the chat's fixed protocol rules always win over it:
```text
You are a careful assistant helping a person answer a question accurately.
Challenge a premise that looks false instead of inventing an answer.
```

## Gate question
`gate.liquid` is the gate's `--question`; it renders the first attempt and later loop-backs:
```liquid
Question: {{ task.title }}
{{ task.description }}

{% if execution.handoff %}
Attempt {{ execution.step_visit_count }} was rejected.
Reasons: {{ execution.handoff.reasons }}
Guidance: {{ execution.handoff.guidance }}
{% endif %}

Reply through the answer artifact with outcome, answer, and rationale.
```

## Related
[Route decisions](routes.md) · [Authoring commands](authoring.md) · [Resolution](resolution.md)
