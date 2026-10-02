# execute

The daemon runs a deterministic Rhai script against the resolved server context
and persists its validated JSON result. Execute has no provider harness.

- [Settings](settings.md): required config, CLI script/schema flags, definition reads, and transition rules.
  Load when: creating or updating execute, version/script/context/output_schema, CLI or GUI authoring support.
- [Context bindings and output](input-output.md): strict rendering, typed bindings, immutable snapshots, and a transformation example.
  Load when: script templates, canonical namespaces, prior output, JSON types, output validation, persistence, or failures.
- [Limits and cancellation](limits.md): daemon-wide capacity settings, unbounded evaluation, cancellation, and host-call errors.
  Load when: script limits, overflow, cancellation, isolation, or provider requirements.
