# Debugging

Find why a run failed or stalled.

- [Failure table](failure-table.md): error strings and symptoms mapped to causes and fixes.
  Load when: any error code (`dispatch_failed`, `route_*`, `*_outgoing_transitions`, `child_missing_workflow`, 401), or a run that stalls.
- [Logs and outcomes](logs-and-outcomes.md): where to look (run history, GUI, daemon log, artifacts).
  Load when: you need evidence before diagnosing, "what happened in the run".
