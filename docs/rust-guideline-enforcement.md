# Rust guideline enforcement

The [JSON audit](rust-guideline-enforcement.json) maps all 209 published rules
from the 31 Rust guides to selected checks and remaining review/test obligations.
JSON matches the project artifact catalogs. Cargo and Clippy settings remain
TOML, which is their native configuration format; YAML is unnecessary here.

## Initial policy

| Check | Rule subset | What it catches |
| --- | --- | --- |
| `await_holding_lock` | ASYNC-004, SYNC-002, SYNC-004 | Supported synchronous lock guards live across `.await` |
| `await_holding_refcell_ref` | ASYNC-004, OWN-006, SYNC-004 | `RefCell` borrow guards live across `.await` |
| `await_holding_invalid_type` | OBS-003 | Configured `tracing::span::Entered` and `EnteredSpan` guards live across `.await` |
| `let_underscore_future` | ASYNC-001, ASYNC-008 | `let _ = future` discarding asynchronous work |
| `dbg_macro` | OBS-001 | Leftover `dbg!` output instead of deliberate diagnostics |

`Cargo.toml` sets these five lints to `deny`; each workspace member inherits the
policy through `[lints] workspace = true`. `clippy.toml` configures the tracing
guards. Four lints are already warn-by-default on the pinned toolchain; explicit
denial documents the policy even outside CI. The newly restricted debug macro
and tracing guard configuration add concrete checks. CI's existing `-D warnings`
also rejects other default Clippy warnings.

These checks enforce **parts** of eight guidelines, not eight complete rules.
For example, `let_underscore_future` cannot prove a spawned task has a cleanup
owner, and forbidding `dbg!` does not prove logs are structured or secret-free.
The lock checks do not cover every guard implementation or prove deadlock
freedom. Prefer lexical guard scopes; explicit `drop` can still produce false
positives in the await-holding analyses.

## Scope and exceptions

The ordinary CI command checks its default targets for the host configuration,
excluding the three Docker acceptance crates. Inheritance applies to acceptance
crates when they are compiled, but their checks are not claimed to run in normal
CI. Inactive platform code, optional features, and every test target are not
implicitly covered. Preserve the existing target matrix unless expanding it is
the intended work.

Use the smallest justified exception when the checker cannot express a valid
case. On the pinned toolchain, prefer `#[expect(clippy::lint_name, reason = "...")]`
so a stale expectation can be reported. Do not blanket-allow entire crates or
tests. A reason should explain the invariant or false positive, not say only
"needed for Clippy". Exceptions are reviewed policy decisions, not automated
proofs. Do not change runtime semantics merely to silence a diagnostic.

Broad `unwrap`/`expect`, indexing, arithmetic/cast restrictions, unsafe-comment
checks and API prohibition lists are recorded as deferred candidates. They need
scoped baselines and meaningful exceptions before enforcement. No entire
`restriction`, `pedantic` or `nursery` group is enabled. Custom compiler plugins
are not required for this rollout.

## Verification and workflow use

Run the normal Clippy command from `docs/testing.md`, followed by:

```sh
python3 scripts/check-rust-guidelines.py
```

This Python 3.11+ script checks 209 unique rule IDs and consistency of explicit-policy mappings, checks
that every declared workspace member inherits the policy, and builds isolated
negative/positive fixtures with actual Clippy. It requires each selected lint to
reject its violation, tests both tracing guards, and verifies a scoped exception.
It does not fetch source artifacts or verify source hashes and default-lint classifications against the published catalog. Those are audit-time checks, not CI guarantees. It uses offline cached dependencies and does not run acceptance tests or access
Sacrum. Build the workspace first so `tracing` is cached.

The published companion artifact is `rust-best-practices/enforcement`. A workflow
can read its checks for the selected guide/rule, execute applicable commands,
and attach diagnostics as evidence. `explicit_policy` means a configured check;
`default_clippy` means an existing default lint; `deferred_candidate` is **not**
enabled by this policy. `none_identified` means this audit selected no precise
check, not that automation is impossible. Never infer full guideline compliance
from a lint pass. Architectural direction, replay, idempotency, cancellation,
resource budgets, authorization and secrecy still require appropriate tests and
review. This change publishes metadata; it does not add an automatic workflow
consumer of that metadata.

Each rule includes its source artifact ID and body hash so drift can be detected.
When guides or the pinned toolchain change, re-audit mappings and fixture behavior.
The audit is an initial set of useful mappings, not an exhaustive inventory of
all possible lint combinations.

## Sources

- [Clippy 1.97 lint reference](https://rust-lang.github.io/rust-clippy/rust-1.97.0/index.html)
- [Clippy configuration](https://doc.rust-lang.org/stable/clippy/lint_configuration.html)
- [Cargo workspace lint inheritance](https://doc.rust-lang.org/stable/cargo/reference/workspaces.html#the-lints-table)
- [Tracing entered span guards](https://docs.rs/tracing/latest/tracing/span/struct.Entered.html)
