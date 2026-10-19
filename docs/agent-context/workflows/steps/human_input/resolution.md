# Resolving human_input

Purpose: resolve a waiting gate from the CLI.
Use this when: attaching a gate's artifact or answering it field by field.

## Attach the artifact
Find the waiting execution in `vtb show <task>`, then attach the artifact:

```sh
vtb artifact add answer.json --subject-type step_execution \
  --subject-id <waiting-execution> --logical-name answer \
  --body '{"outcome":"resolved","answer":"Yes","rationale":"The premise is valid."}'
```

The body must be JSON and satisfy the schema. A failed attach stores nothing
and leaves the gate waiting. Sacrum reports `invalid_human_input_json` for
non-JSON, `invalid_human_input` with the violating JSON path such as
`#/answer`, and `human_input_execution_not_waiting` when the execution is no
longer the run's current waiting gate.

## Answer field by field
A gate is draftable when every top-level schema property is a string, number,
integer or boolean, a string `enum`, or an array of string `enum`. Its waiting
execution keeps a durable draft that Sacrum checks:

```sh
vtb gate set <waiting-execution> --values '{"outcome":"resolved"}'
vtb gate show <waiting-execution>
vtb gate submit <waiting-execution>
```

`set` merges the values (null clears a field) and stores nothing when any key
is unknown (`unknown_draft_field`) or invalid (`invalid_human_input`). Each
command prints what is still needed, or that the draft is complete. `submit`
fails with `draft_incomplete` while a required field is unset; otherwise it
resolves the gate exactly as attaching its artifact does. On loop-back the new
execution's draft starts from the previous attempt's still-valid answers.

## Related
[human_input](index.md) · [Gate chats](gui.md) · [Artifacts](../../../artifacts.md)
