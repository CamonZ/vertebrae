# Local chat associations

The left conversation list uses a title row and a compact secondary row,
retaining project group headings. Entries have a 48px minimum height on the 4px spacing grid. The top row
contains only the title. The provider/activity, ticket, worktree and trash icons sit on the left
of the lower row; the last-changed timestamp is aligned right.
Association icons appear only for established associations. Hover or keyboard
focus reveals the ticket ID/title or worktree path/branch. Both icons are
informational, use the default cursor, and perform no action. The chat header
keeps the title without an association info control. Project context appears
in headers only when more than one chat pane is visible.

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
- Registered project roots can be Git checkouts or container directories with
  primary Git repositories as immediate children. Container discovery scans at
  most 512 directory entries, keeps at most 1024 worktrees, and shares one
  five-second Git deadline. Child symlinks, foreign linked checkouts and
  separately registered child projects are excluded. A container itself is a
  valid project/cache root, but only real Git inventory entries can be bound.
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


## Limits

Per session the record keeps the ticket, worktree, pending-creation snapshot,
recent worktrees and the last processed event. One request runs at a time; its
result is dropped if the session changes or a newer user message arrives. Once
both are known nothing more is asked.

## Investigation and diagnostic logs

See [Detection investigation](vtb://artifact/381dfb40-155d-4501-b0ae-6efed5c30142) for request and
response boundaries, reproducible context failures, diagnostic configuration,
privacy limits and remaining hypotheses. Execution-directory keys include `cwd`,
`workdir`, `working_directory` and `working_dir`; late responses are also retired
when the conversation root or project generation changes.
