# execute

The daemon runs a deterministic Rhai script against the resolved server context
and persists its validated JSON result. Execute has no provider harness.

- [Settings](settings.md): required config, CLI script/schema flags, definition reads, and transition rules.
  Load when: creating or updating execute, version/script/context/output_schema, CLI or GUI authoring support.
- [Context bindings and output](input-output.md): strict rendering, typed bindings, immutable snapshots, and a transformation example.
  Load when: script templates, canonical namespaces, prior output, JSON types, output validation, persistence, or failures.
- [Reading tasks and artifacts](host-reads.md): `vtb::tasks` and `vtb::artifacts` reads, and a child-outcome rollup example.
  Load when: a script reads tasks, children or artifacts, rolls up child results, or uses `read_json`.
- [Creating and updating tasks](host-writes.md): `vtb::tasks::create`, `update`, `archive` and `unarchive`, and a create-children-from-a-plan example.
  Load when: a script creates child tasks, patches task fields or tags, archives tasks, or must not duplicate tasks on rerun.
- [Deleting tasks and artifacts](host-deletes.md): `vtb::tasks::delete` with or without cascade, `vtb::artifacts::delete`, refusals for running work, and a delete-children-with-their-artifacts example.
  Load when: a script deletes tasks or artifacts, cleans up what it created, or a delete is refused.
- [Editing task content and relationships](host-edits.md): sections, checklist items, code refs, parents and dependencies through `vtb::tasks`, and an add-a-checklist-once example.
  Load when: a script adds or edits sections, checks items, adds code refs, reparents tasks, or adds dependencies.
- [Writing artifacts](host-artifact-writes.md): `vtb::artifacts::put`, `put_json` and `delete` on a task or the project, provenance, and a record-progress example.
  Load when: a script publishes, replaces or deletes a named artifact, shares data through the project, or writes the same name as output persistence.
- [Limits and cancellation](limits.md): daemon-wide capacity settings, unbounded evaluation, cancellation, host-call errors, and command execution (`vtb::cmd`) permissions.
  Load when: script limits, overflow, cancellation, isolation, running commands from a script, or provider requirements.
