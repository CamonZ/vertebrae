---
name: gate
description: Read, record, and submit answers to a waiting human_input gate using vtb gate show, set, and submit. Use for field-by-field gate drafts, including revising or clearing answers.
---

# Gate drafts

Use the active project and the full UUID of the run's current waiting
`human_input` execution, not the task, step definition, or TaskRun ID.
Resolve that execution from `vtb show <task>` or the supplied gate context.
`vtb gate --help` and each subcommand's `--help` describe the installed CLI.

```bash
vtb --json gate show <execution-uuid>
vtb --json gate set <execution-uuid> --values '{"approved":true,"reason":"Tested"}'
vtb --json gate set <execution-uuid> --values '{"reason":null}'
vtb --json gate submit <execution-uuid>
```

`set` merges an inline JSON object into the durable draft. Omitted fields
remain unchanged; null clears an answer. Use only the output schema's field
names. A successful set records answers but does not resolve the gate.
Read the returned `values`, `missing`, `invalid` (paths and messages), and
`complete`; Sacrum decides whether the draft is complete. Do not infer
completeness from the conversation or the presence of required fields alone.

Summarize a complete answer and obtain the user's confirmation before
`submit`. A successful submission resolves the gate and lets its existing
run continue. JSON output contains the submitted draft snapshot, including
answers recorded through forms or other clients. Do not issue a workflow
transition or start another run to continue it.

For `draft_incomplete` or `invalid_human_input`, correct only the reported
missing or invalid answers, reread the result, and confirm the revised
complete answer before submitting again. Unknown fields are rejected without
storing them. Transport and permission failures are not evidence that the
gate is non-draftable; report them rather than switching protocols.

If `human_input_not_draftable` is reported, use the gate's configured
whole-artifact submission contract (`vtb artifact add`) instead. If the
execution is no longer waiting, stop submitting to it and inspect the run's
current state. Do not retry under a different project or fabricate IDs.
