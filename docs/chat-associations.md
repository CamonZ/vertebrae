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

- New project conversations save the main Git checkout path and branch at
  creation. A project container with several repositories has no single default.
  Reopening a conversation uses its saved association. The initial main
  checkout can be replaced by a later worktree association.

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

## Durable machine catalog

The installer crate provisions a random installation UUID in `chat-installation-id`
in the application data directory. Binary installation calls the same API as
first startup, so upgraded installations keep their existing UUID; concurrent
installers publish one complete ID and corrupt IDs fail without rotation. This
is independent of daemon enrollment, project checkout paths, and provider session IDs. Sacrum's catalog is scoped by owner,
project, and installation. API-token rotation resolves back to the same stable
owner/backend scope; an unfamiliar token must authenticate before local history
is exposed. Existing chat IDs and provider replay identifiers are preserved.

The client installation UUID is separate from `LocalBackendState.installation_id`, which
identifies a GUI-managed backend stack. Missing client identity is provisioned
on first catalog use even when connecting exclusively to an external backend;
that same ID is passed to installation registration and every catalog read/write.

The legacy local session index is retired after verified migration. The scoped
catalog retains a backend snapshot for offline reads, a durable pending-write
outbox, and local-only sidecars for worktree paths, branches, gate protocol details
and association inference cursors. The backend owns catalog metadata; the local
snapshot is not an independent catalog. The complete scoped file must not be
manually discarded while it contains pending writes or local-only sidecars. Only an
explicit allowlist of summary metadata, confirmed entity ID, gate IDs, provider
lineage, and hashed classification decisions is uploaded. Provider transcripts,
raw invocations/results, patches and file metadata never enter that projection.
Provider child grouping continues to use `providerParentResumeId`; catalog parent
links are nullable and are not synthesized from provider identifiers.

Each local change first enters an atomic durable outbox, with a stable mutation
UUID and expected server revision. The backend acknowledges idempotent retries.
Revision conflicts preserve local intent and retry against the returned revision;
terminal remote deletion wins. Explicit deleted IDs produce tombstones; a record
missing from a stale full snapshot does not imply deletion. Imports retry after
restart and retain unmapped legacy chats locally for diagnosis. Initial load,
project selection, reconnect and catalog CDC invalidate the summary cache.
Transient network errors retain pending local edits. Classification decisions
are reused from durable cache after restart, including successful empty labels;
input/model/prompt fingerprint changes invalidate reuse. Inference failure is not
cached. Concurrent additions merge while holding the catalog serialization lock.

Every sync writes `chat-catalog-<scope>.expected.json` beside its outbox in the
application data directory. It contains installation/project/chat IDs, expected
allowlisted payloads and revisions, plus `pending`, `conflicted` and `unmapped`
identity lists. Use the companion Sacrum `scripts/verify_chat_catalog.py` against
that fixture to reconcile every paginated record; any backlog or mismatch fails.
These diagnostic files contain titles and IDs, so keep them local. Structured
logs record chat identity, revision and counters only, never tool sources.

Repeatable local checks (from the repository root):

```sh
cargo test --locked -p gui --lib commands::chat_catalog
cargo test --locked -p gui --lib commands::tool_activity
cd crates/gui
npm test -- --run src/hooks/useChatCatalogSync.test.ts src/utils/localChatPersistence.test.ts src/components/thread/toolActivity/useDecisionActivities.test.tsx
```

The catalog property/model tests generate edit/import/delete/restart and
reordered-event interleavings against an independent final-intent oracle. HTTP
fixtures simulate an acknowledgement lost after commit; restart retries the same
mutation without increasing its revision. Separate account/token fixtures prove
scope stability and isolation. Classifier tests use a counting fake runtime,
serialization/reload, exact ordering and threshold fixtures without live model
requests. Run `scripts/validate.sh` for the maintained completion profile; Docker
acceptance and actual native GUI restart remain separate verification lanes.

At most 1024 distinct invocation identities are admitted per chat. Replacing an
existing identity after fingerprint invalidation is allowed. Once full, a new
classification produces `chat_classification_capacity` and is refused without
evicting any acknowledged decisions; syntax-derived activity remains available.

## Persisted activity

The backend catalog's `status` reports `working` or `idle`; the existing history
metadata's open/closed status stays separate. `activityStatus` carries this report
through the local index. Busy lifecycle phases, unfinished turns, compaction and
confirmed active background work report working. Completion, errors and closure
report idle. Runtime lifecycle and transcript buffers still remain local.

Activity boundary changes persist through the existing catalog outbox, without
refreshing unrelated pane summaries or saving each streamed text delta. Catalog
load reconciles stale working reports to idle when the local runtime registry no
longer owns that chat, while preserving reports for live runtimes. A persisted
working report never resumes a runtime by itself. It is last-reported activity,
not a server heartbeat or process lease.

The normal backend catalog query excludes chats linked to tasks whose
`completed_at` is set, unless `includeCompleted: true` is passed. Unassociated
chats remain in that view. Recovery synchronization explicitly passes true and
follows every cursor, preserving completed history and tombstones in its durable
cache. Filtered query omissions do not imply chat deletion; this backend default
does not add a GUI history filter control.

## First-start migration and storage responsibilities

On the first authenticated catalog load, legacy session rows are projected into
pending imports. They keep their existing chat IDs and provider replay IDs.
Acknowledging an upload is not enough to delete a source: the client reads every
backend page again and compares IDs, revisions and complete expected payloads,
including classifications and successful empty labels. A missing row, failed page,
conflict or content mismatch retains the original and retries on the next load,
project recovery or reconnect.

The versioned per-row migration checkpoint and local-only sidecar are synced to
disk before removing the verified row from `local-chat-session-index.json`.
Unmapped and other-account rows remain. The file is removed once no legacy rows
remain, and later saves do not recreate retired rows, even for offline edits:
those writes are already durable in the scoped outbox. A restart between
checkpointing and cleanup retries cleanup without another upload. Future index
versions/fields and malformed source data fail closed. Backend-backed loads never
sweep annotation files based on the now-incomplete legacy index. Annotation
removal remains an explicit session-deletion operation.

The only current annotation producer writes `worktree_delta` records into
`local-chat-annotations/<session-id>.jsonl`. These contain local Git details and
must not be uploaded or deleted by catalog migration. Classification decisions
already stored in the scoped catalog participate in upload and reconciliation.
No historical classifier fingerprints are invented for opaque JSONL records.
An inventory reports retained local-only, unsupported and malformed annotation
counts without copying their payloads into diagnostic output. An unreadable
annotation file is reported as unavailable and never blocks durable session
edits or causes deletion of that annotation source. A future backend
annotation contract is required before migrating any unsupported kind.

All of these files are under the shared application data directory:

| File | Responsibility | Retirement |
|---|---|---|
| `chat-installation-id` | Installer-owned stable installation identity, independent of account and API token | Retained across updates/reinstalls |
| `local-chat-session-index.json` | Legacy catalog rows still awaiting verified import | Verified rows removed; empty file removed |
| `chat-catalog-<scope>.json` | Backend snapshot, pending writes, local sidecars and versioned migration checkpoints for one backend/account | Snapshot is recoverable; pending writes and local sidecars must be preserved |
| `chat-catalog-accounts.json` | Maps known connection fingerprints to authenticated backend/account scopes for offline access and token rotation | Retained; contains no raw credentials |
| `chat-catalog-ownership.json` | Records which account claimed each legacy local chat, preventing an account switch from importing another account's sessions | Retained during legacy import/account switching |
| `chat-catalog-<scope>.expected.json` | Reconciliation diagnostic with expected backend projections, pending/verified import IDs and retained annotation counts | Regenerable; never authoritative |
| `.chat-index.lock`, `.chat-catalog.lock` | Advisory process locks; competing GUI writers fail and retry instead of overwriting shared state | Empty coordination files, not migrated data |
| `local-chat-annotations/<session-id>.jsonl` | Local Git/worktree annotations | Retained; explicit session deletion still applies |

Within one GUI, existing async mutexes serialize writes. Advisory locks also
exclude competing GUI processes. Replacement writes use exclusive temporary
files, sync file contents, atomically rename, then sync the parent directory.
Paths are confined to the trusted user-owned app data directory. Verification
uses temporary directories and fake HTTP backends; it does not migrate production
data as part of the test run.
