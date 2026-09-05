---
name: implement
description: Implement one explicitly assigned unit in the supplied workspace and return evidence.
argument-hint: "[assignment or task-id]"
---

# Assignment-scoped implementation

Implement only the assigned unit in the supplied workspace. Read task context
and acceptance criteria, inspect relevant source, and preserve unrelated edits.
Do not create a hierarchy, provision a worktree, delegate review, or run later
phases unless explicitly assigned.

## Boundary

Durable orchestration owns workflow state. A session may read task context and
record checklist/evidence updates, but must not manage progression: do not call
`transition-to`, assign workflows, run/start TaskRuns, or execute a subsequent
step as ordinary implementation.

Commits, pushes, pull requests, and `/simplify` are opt-in actions. Use the
supplied workspace by default; create a worktree only when explicitly asked.

## Procedure

1. Resolve the assignment and source anchors; state assumptions and exclusions.
2. Use supplied guideline artifacts first, or follow `docs/agent-guidelines.md`
   for selective project-scoped retrieval and provenance.
3. Implement the requested behavior using existing repository interfaces.
4. Run focused checks, then broader checks for the changed surface.
5. Review the diff for scope, regressions, and documentation impact.
6. Return changed files, exact checks/results, guidance/rule IDs and exceptions,
   unrun checks/blockers, residual obligations, and requested handoff state.

Missing or ambiguous context is not permission to substitute another project or
namespace. Diagnose routine failures; retry only when safe and informative. If
an external prerequisite is unavailable, report it precisely and continue
independent work. Never claim review, persistence, injection, model evaluation,
commit, push, or PR activity that did not occur.
