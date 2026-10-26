# Local chat associations

A local chat shows, in its header, the ticket being worked on and the Git
worktree it is happening in. This is a narrow prototype.

## Behavior

- Until both a ticket and a worktree are known, each new **user** message is
  sent to the configured decision model with the current association. One
  request asks only the missing questions: "Is this message asking we implement
  a ticket?" (while no ticket is known) and "Is this message asking we create a
  worktree?" (while no worktree is known); above 0.5 is yes.
- If either answer is yes and no ticket is known, a full ID or 8+ character ID
  prefix of one cached ticket in the message selects it; otherwise a choice
  question picks a cached ticket or "unknown". Assistant text and tool output
  never select tickets.
- The decision runs when the message arrives, before any worktree exists. A
  "create a worktree" answer records the worktrees that exist at that moment;
  the first later tool event that touches a worktree not in that snapshot binds
  it. Otherwise a touched worktree whose directory or branch contains the
  ticket's short ID binds once the ticket is known (the last 8 touched
  worktrees are kept for that).
- Tool calls/results are scanned for absolute, `./` and `../` paths (or paths
  whose first component exists), plus `cwd`/`workdir`, and checked against
  `git worktree list`. Inspecting other checkouts never moves the association.
- Candidates come only from existing React Query cache entries for the current
  project generation; nothing is fetched. Eligible: ticket, not archived, not
  completed, not in a finish step. The backend verifies the cache belongs to
  the conversation's project and rejects more than 1024 candidates.
- A disabled, unsupported or failing model keeps the association and shows one
  diagnostic; that message is skipped and the next one is the retry. No
  fallback model.
- The header is responsive by container width: short ID, then title (420px),
  then worktree/branch (640px). The popover shows full details and one
  correction: set the ticket by full or short ID (blank clears).

## Limits

Per session the record keeps the ticket, worktree, pending-creation snapshot,
recent worktrees and the last processed event. One request runs at a time; its
result is dropped if the session changes or a newer user message arrives. Once
both are known nothing more is asked; switching tickets needs the correction.
