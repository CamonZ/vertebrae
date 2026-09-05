# Agent guidance evaluation

This is a bounded static walkthrough, not a model-performance measurement.
The evaluated revision is the current ticket branch; the supplied artifacts
are `docs/agent-session-contract.md`, `docs/agent-guidelines.md`, and the
assignment-scoped implementation skill. No durable TaskRun, workflow
transition, push, or PR action was performed as an evaluation side effect.

## Scenario matrix

| Family | Assignment and expected scope | Expected evidence | Static result |
|---|---|---|---|
| CLI | Change argument parsing in `crates/cli`; only parser/tests/docs in scope | focused parser test, then Rust profile | Pass: contract limits edits and requires exact checks |
| GUI | Fix project-isolated async state; GUI state/tests only | targeted GUI lint/typecheck/test | Pass: TypeScript guidance is selected by responsibility |
| Rust/provider | Change cancellation or replay lifecycle; adapter/core files named by assignment | focused Rust tests and relevant rule IDs | Pass: provider/core ownership and partial guideline limits are explicit |

Each family was considered in both direct-request and supplied durable-step
forms. A durable step supplies scope and context; it does not grant workflow
control. A direct request does not imply hierarchy creation, worktree
provisioning, commit, or PR authority.

## Failure variants

Missing relevant artifact: report a coverage gap; never substitute another
project. Mismatched content hash: report that the body is not the pinned
version. Missing `/simplify`: perform in-scope self-review or report the helper
as unavailable. Arbitrary surrounding step name: ignore it unless assigned
scope makes it relevant. Unrelated dirty file: preserve it. Explicit commit
authorization: commit only the assigned changes with the requested prefix.
Failed validation: report the failing command and do not claim completion.
Unavailable external prerequisite: record the prerequisite and independent
checks performed.

## Result and limitations

The offline consistency check is the available static evidence:
`python3 scripts/check-docs.py`. Model evaluation was **not run** because no
authorized isolated session runner and fixed model/version fixture were
available. Therefore this report contains no performance score, latency,
context-size, or clarification-count claim. Before claiming improved model
behavior, run the same matrix with a recorded runner, model/version, fixed
inputs, isolated workspace, and captured tool/evidence trace.

The evaluation fixture is documentation-only: it cannot prove that a session
selected the expected guide or avoided an unauthorized tool call. Those
assertions remain acceptance criteria for a future authorized runner trial.
