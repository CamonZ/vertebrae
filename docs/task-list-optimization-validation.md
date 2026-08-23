# Task-list optimization validation

Validation date: 2026-08-23

## Regression checks

The following checks pass on the optimized implementation:

- Sacrum-client query assembly and response conversion tests, including the
  lookup-aware and no-lookup list paths.
- CLI list/show regression tests covering tree, flat, JSON, and full-detail
  output.
- GUI list, blocked-state, relationship, cache-key, realtime, detail, and
  project-switch tests.
- Workspace formatting, clippy, and non-acceptance Rust tests.

The GUI suite passes 198 test files and 2,577 tests. The repository-wide Rust
coverage hook passes with 82.86% line coverage. GUI lint passes with the
repository's existing 21 Fast Refresh warnings and no errors.

## Reproducible query evidence

The baseline is the ticket branch point (`dd963b4d`). The optimized version is
the task-list implementation at `HEAD`.

| Measurement | Baseline | Optimized | Change |
| --- | ---: | ---: | ---: |
| `TaskFields`/`TaskListFields` source fragment bytes | 1,284 | 577 | 55% smaller |
| Scalar/nested selection lines in the fragment | 55 | 23 | 58% fewer |
| GUI list GraphQL requests | 2 (`ListTasks` + `ListWorkflows`) | 1 (`ListTasks`) | 1 fewer request |
| CLI list GraphQL requests | 2 (`ListTasks` + `ListWorkflows`) | 2 (`ListTasks` + `ListWorkflows`) | Preserved CLI names |
| Equivalent unfiltered React Query keys | multiple null-shaped keys | one `null` key | Canonicalized |

The fragment measurements are selection-source measurements, not claimed
server response sizes. The request-count measurements are covered by
WireMock/client tests: the no-lookup path captures exactly one GraphQL body and
does not capture a workflow request; the lookup-aware path still resolves CLI
workflow and step names.

The measurements can be reproduced from the repository root with:

```bash
git show dd963b4d:crates/sacrum-client/src/queries/tasks.rs \
  | awk '/pub const TASK_FIELDS/{capture=1} capture{print} capture && /"#;/{exit}' \
  | wc -c
awk '/pub const TASK_LIST_FIELDS/{capture=1} capture{print} capture && /"#;/{exit}' \
  crates/sacrum-client/src/queries/tasks.rs | wc -c
```

## Live evidence limitation

No representative Sacrum-sized projects were available in the local
environment: the three reachable local stacks each contained only an empty
`scifi-finder` project, and their stored API-token hashes did not provide a
usable test credential. Consequently, paired live cold/warm latency and
serialized response-size measurements remain unresolved. The static selection
and request-count evidence above is intentionally not presented as a
substitute for those measurements.
