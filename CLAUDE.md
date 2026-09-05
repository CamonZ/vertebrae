# Vertebrae

Vertebrae is a Rust task-management and AI workflow-orchestration system with
CLI, GUI, daemon, harness, and Sacrum components. `AGENTS.md` is a symlink to
this file; keep them as one shared instruction source.

## Start with the assignment

An engineering session executes one explicitly assigned unit in the supplied
workspace. Read the task context, acceptance criteria, source anchors, and
constraints before editing. Preserve unrelated changes and keep the file
scope narrow. Use `docs/agent-session-contract.md` for the canonical input,
boundary, verification, and handoff contract, and `docs/agent-guidelines.md`
for selective project-scoped guideline retrieval and provenance.

- For read-only assessment, inspect and report; do not mutate task state or
  create planning records.
- For an existing assignment, implement only that assignment and report exact
  evidence. Reading or updating task context/checklists does not authorize
  workflow control.
- For an explicit planning request, create or decompose Vertebrae records only
  within the requested scope.

Durable orchestration owns workflow progression. Do not infer the next phase or
call `transition-to`, assign workflows, `run`, or `start-taskrun` as part of
ordinary implementation. Worktree creation, review delegation, `/simplify`,
commits, pushes, and PRs likewise require explicit authorization.

## Architecture constraints

Keep provider wire protocols and translation in adapters; provider selection
belongs in the harness. Core contracts should remain provider-neutral, and
normalized events flow from the harness through the application surfaces.
Sacrum owns durable workflow and TaskRun execution state. Consult
`docs/architecture.md` and `docs/system-overview.md` for detail, and verify
volatile behavior against code and CLI help rather than copying it into root
policy.

## Documentation routes

| Change | Start here |
|---|---|
| CLI commands/tasks/workflows | `docs/vtb-guide.md` |
| GUI state and interaction | `docs/gui-development.md` |
| Provider/live-replay/harness | `docs/architecture.md` |
| Core/Sacrum contracts | `docs/system-overview.md` |
| Packaging and signed updates | `docs/updates.md` |
| Validation and hooks | `docs/testing.md`, `docs/git-hooks.md` |
| Agent assignment and guidance | `docs/agent-session-contract.md`, `docs/agent-guidelines.md` |

The repository's CLI workflow administration documentation remains valid for
explicit administrative requests; it is not a mandatory session lifecycle.

## Verification and handoff

Run focused checks first, then the required checks for the changed surface.
Use `docs/testing.md` as the maintained validation contract. Report changed
files, exact commands and observed results, applicable guidance/rule IDs and
exceptions, unrun checks or blockers, and residual review obligations. Never
claim full guideline compliance from tags or green linters, and never claim a
review, model evaluation, artifact injection, commit, push, or PR that did not
actually run.

## Repository conventions

Use existing APIs and dependency versions. Do not edit personal plugin caches,
production orchestration, or build artifact-injection features as incidental
work. Commit messages use `[<first-8-chars-of-ticket-uuid>] <description>` for
ticket work and `[no-ref] <description>` otherwise. Consult the relevant
documentation before making assumptions.
