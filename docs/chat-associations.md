# Local chat associations

The left conversation list uses a title row and a compact secondary row,
retaining project group headings. Entries have a 48px minimum height on the 4px spacing grid. The top row
contains only the title. The provider/activity, entity, worktree and trash icons sit on the left
of the lower row; the last-changed timestamp is aligned right.
Association icons appear only for established associations. Hover or keyboard
focus reveals the entity level/ID/title or worktree path/branch. Both icons are
informational, use the default cursor, and perform no action. The chat header
keeps the title without an association info control. Project context appears
in headers only when more than one chat pane is visible.

## Behavior

- A conversation associates with at most one epic, ticket or task, plus one
  worktree. New **user** messages ask the configured decision model about missing
  associations. Selection intent includes discussing, implementing and explicitly
  tying a conversation to any of the three levels; above 0.5 is yes.
- Explicit full UUIDs and unique 8+ character prefixes resolve against the
  conversation's registered project, including entities absent from the UI cache.
  Full UUIDs use a direct read with a project-ownership check and can disambiguate
  a short-ID collision. Prefixes use Sacrum's eight-character resolver and must
  also match the entire supplied reference. Unknown, ambiguous, ineligible or foreign-project IDs keep the
  association with a diagnostic. Explicit references never infer a parent ticket.
- Without an explicit ID and with no existing entity, descriptive selection
  chooses an eligible cached epic, ticket or task, or "unknown". Choice criteria
  include each entity's level and title. Judgment state includes the current and
  explicitly named entities' IDs, titles and levels. Assistant text never selects entities. Tool output can select a newly created
  ticket only through the confirmed creation path described below.
- Known associations change on explicit ID references with selection intent or
  a confirmed ticket creation request.
  Manual correction resolves an exact full/short ID in the conversation project
  without a model call; blank clears it. A correction retires older pending
  decisions. Rebinding across levels clears the previous worktree and pending
  creation snapshot before matching a worktree for the new entity.
- The decision runs when the message arrives, before any worktree exists. A
  "create a worktree" answer records the worktrees that exist at that moment;
  the first later tool event that touches a worktree not in that snapshot binds
  it. Otherwise a touched worktree whose directory or branch contains the
  entity's short ID binds once the entity is known (the last 8 touched
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
- Descriptive candidates come only from existing React Query cache entries for the current
  project generation; nothing is fetched. Eligible: epic, ticket or task, not
  archived, not completed, not in a finish step. Explicit backend lookups apply
  the same eligibility rules. The backend verifies the cache belongs to the
  conversation's project and rejects more than 1024 candidates.
- A disabled, unsupported or failing model keeps the association and shows one
  diagnostic; that message is skipped and the next one is the retry. No
  fallback model.


## Newly created tickets

Every root user message is classified separately for explicit ticket creation
intent, even when the chat already has an entity and worktree. Questions about
how to create tickets, quoted examples, negation and hypothetical requests are
negative cases. A positive intent suppresses existing-entity selection; it only
stores a pending originating user-event marker and project generation.

At successful root turn completion, the driver inspects at most 128 subsequent
messages from that turn. It uses literal syntax from the existing parser worker,
not inferred activity labels. Supported commands are one unconditional `vtb add`
invocation per call, with `--json` and explicit `-l ticket`, `--level ticket` or
`--level=ticket`. Direct Bash/exec_command/shell_command calls, literal shell
`-c` wrappers and single literal `tools.exec_command` calls in functions.exec are
supported. Compound, deferred, dynamic, piped and redirected invocations are
unsupported. Command inputs and results are each limited to 32,000 characters.

Root results must match the tool-call ID. Supported output is the complete CLI
JSON object `{command: "add", status: "created", task_id: "<UUID>"}` or a completed
exec_command JSON envelope with `exit_code: 0`, no live `session_id`, and that
object as its `output` string. Human-readable CLI output and other wrapper output
formats are unsupported and leave the association unchanged with a diagnostic.
The returned UUID is resolved through the existing project-scoped eligible-entity
lookup and must identify a ticket. Assistant claims and arbitrary IDs cannot bind.

The turn must confirm exactly one supported creation. Multiple creations,
failed/cancelled turns or commands, missing/malformed results, child-thread
results and unsupported evidence leave the association unchanged with a diagnostic.
Repeated delivery of the same tool identity uses its latest input/result; the
persisted event cursor makes replay idempotent. Pending intent is retired by a
newer user message, manual correction or project-generation change. Existing
saved records without pending intent or terminal success metadata remain valid;
legacy terminal records cannot confirm a new ticket. Live and provider-replay
transcripts preserve normalized successful turn completion for this check.


## Limits

Per session the record keeps the entity, worktree, pending-creation snapshot,
recent worktrees and the last processed event. One request runs at a time; its
result is dropped if the session changes or a newer user message arrives. Once
both are known, explicit user references and confirmed ticket creations can rebind them.

Existing records retain the legacy `ticketId` and `ticketTitle` keys; these now
hold the selected entity at any level. New associations also persist
`entityLevel` (`epic`, `ticket` or `task`). A missing level means `ticket`, so
existing sessions, worktree paths/branches and processing cursors load unchanged.
Display labels, grouped history headings and correction links use the selected level.

## Investigation and diagnostic logs

See [Detection investigation](vtb://artifact/381dfb40-155d-4501-b0ae-6efed5c30142) for request and
response boundaries, reproducible context failures, diagnostic configuration,
privacy limits and remaining hypotheses. Execution-directory keys include `cwd`,
`workdir`, `working_directory` and `working_dir`; late responses are also retired
when the conversation root or project generation changes.

## Recording branch guard

The branch captured when a worktree is associated is the intended recording
branch. It is sent with the worktree path when a local runtime starts or its
association changes, including when only the intended branch changes. Resuming
a runtime preserves the persisted branch rather than adopting the checkout's
current branch. An association with no branch (including detached HEAD) leaves
recording off until a named branch is explicitly associated.

The delta recorder checks branch identity before opening a tool window, around
checkpoints, and before appending an annotation. A mismatch, detached HEAD or
Git read failure drops the affected windows and clears the baseline. Recording
on return to the intended branch uses a fresh baseline; commits on the intended
branch remain supported. These checks do not lock Git against an external branch
switch, and a switch away and back entirely between checks is not observable.
The Changes view still displays the checkout's current contents; the guard
controls persisted per-tool deltas, not that live workspace browser.

Discarded tool IDs stay retired until the turn ends. A later completion for a
retired tool invalidates the idle checkpoint when no other tool is open, so
late writes cannot be handed to the next tool before filesystem notifications
arrive. Duplicate starts of completed tools do not consume idle checkpoints.
