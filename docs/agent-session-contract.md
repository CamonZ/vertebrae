# Agent session contract

This document is the canonical contract for one engineering session. A durable
workflow may assign a session, but the session implements only the assigned
unit and reports its result. Workflow progression remains the responsibility
of the orchestrator.

## Assignment input

An assignment should identify:

- the task or step ID and a plain-language objective;
- the supplied checkout/worktree and the files or components in scope;
- source context, acceptance criteria, constraints, and failure scenarios;
- supplied guideline artifacts (logical names, IDs, and hashes when available);
- required checks and the expected handoff format; and
- any explicit authorization for planning, worktree creation, review,
  committing, pushing, or opening a pull request.

If a required input is absent, inspect the task context and repository before
asking a question. Ask only when correctness depends on the missing
information; otherwise record the limitation and continue the independent
parts of the assignment.

## Session boundary

The session may read task context, inspect the supplied workspace, change files
within scope, run relevant checks, and record checklist/evidence updates. It
must not infer or manage the next workflow phase. In particular, it does not
call `transition-to`, assign workflows, start or stop TaskRuns, or execute
subsequent phases as part of ordinary implementation. These are durable
orchestration operations.

Planning/decomposition, provisioning a worktree, delegating review, committing,
pushing, and creating a PR are also separate authorized activities. Perform
them only when the assignment or the user explicitly grants that authority.
Reading or updating task context is not authorization to control workflow
state.

## Guidance and implementation

Prefer supplied guidance and retrieve only artifacts relevant to the changed
responsibility. Treat required rules as contracts; defaults are recommendations
that may have a documented task-local alternative. Record selected artifact
logical names, IDs, content hashes (or their absence), applicable rule IDs, and
exceptions. Do not claim compliance from tags or a passing linter alone.

Use the repository's existing APIs and interfaces. Snippets in guidance are
illustrative unless the checkout proves that the interface exists. If an
artifact is missing, ambiguous, stale, or has a mismatched supplied hash, do
not silently substitute another namespace: report the gap and whether it blocks
correctness.

## Verification and handoff

Run the narrowest meaningful checks first, then required broader checks when
the changed surface warrants them. A completion report contains:

1. changed files and observable behavior;
2. exact commands and observed results;
3. applicable guidance, rule IDs, and justified exceptions;
4. unrun checks, environmental blockers, and residual review obligations; and
5. the requested handoff state, without claiming a workflow transition.

Routine failures should be diagnosed, retried only when the retry is safe and
informative, and reported with the failing command and evidence. Do not hide a
failure by weakening a check or replacing it with an unrelated green command.
If a check cannot run because a dependency, credential, service, or tool is
unavailable, state the exact prerequisite and provide any independent evidence
that was collected.

The report describes completion of this assignment only. It does not claim
model-performance improvement, automatic guideline injection, artifact
persistence, review, commit, or PR creation unless that activity actually ran
and was explicitly authorized.
