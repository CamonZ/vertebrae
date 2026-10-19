# Gate chats

Purpose: how the GUI resolves a waiting gate in a chat or a form.
Use this when: explaining Resolve, draft progress, steering, or loop-back.

## Resolve from the GUI
The GUI's Resolve action on a waiting gate opens a chat bound to the run and
step. The chat opens with the gate's role and rendered question and asks for
each schema field in turn. On a draftable gate it records each answer with
`vtb gate set` as the user gives it, reads what is still needed from the
command output, and submits with `vtb gate submit` only after the draft is
complete and the user confirms; it may run only those commands for the bound
execution without an additional prompt. The chat shows each field's progress,
and a conversation that stops moving the draft is steered back: a hidden hint
naming what is still needed, then the remaining fields as a form, then an offer
to keep going or stop the run (thresholds in Settings). On any other gate the
chat drafts the whole artifact and may run only the corresponding `vtb artifact
add` command. Reopening Resolve reopens the same chat; when that chat's session
has ended, a draftable gate continues in a new chat that starts from the
draft. A draftable gate can also be answered directly from a form on the gate,
without a chat.

## Loop back
A route after the gate can send an inadequate answer back to it. The route
handoff becomes `execution.handoff` on the new gate execution, and the gate's
question is re-rendered with that handoff and `step_visit_count`. The
existing bound chat rebinds to the new execution, receives one evaluation turn
with the rejection verdict, and shows `Rejected · attempt n`.

For a complete gate, triage, evaluator, and loop-back workflow, see
[Conversational review gate](../../../recipes/conversational-review-gate/index.md).

## Related
[human_input](index.md) · [Resolution](resolution.md) · [Route loops](../route/loops.md)
