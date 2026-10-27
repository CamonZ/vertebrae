# Selected subagent conversations (ede0b338)

Child conversations render in their selected Chat Sessions entry. Live child text,
tools, errors and scoped permissions route to that child without selecting it or
adding its content to the parent. Unscoped Sacrum permissions retain their owner.
The existing active indicator is reused; the decorative child dot is removed.

## Provenance and edits

- Codex 0.164.0, captured 2026-10-27: parent thread
  `01a17f07-5d7e-70d2-95e4-6144730e158b`, child thread
  `01a17f07-7376-7ff3-92af-4aa71378c140`. The child command retains provider ID
  `exec-da5af6af-b2f4-4d0a-a158-eb7efab7d140`. Parent SubAgentActivity records
  preserve the spawn and terminal relationship. The child fixture keeps its own
  work records, a minimal session header, and a synthetic parent-only text
  record. The copied-prefix ordinal is adjusted to this reduced fixture.
  Filesystem paths become `/fixture`. Credentials, instructions, encrypted
  content, and unrelated copied context are omitted.
- Claude Code 2.1.311, captured 2026-10-27: parent session
  `68ba7d4f-86bd-4ab6-8a80-38cfd4a43370`, child agent
  `aaeb35c276750cf44`. The adjacent fixtures in
  `crates/harness-claude/tests/fixtures/child-sessions` retain the persisted
  envelope (`agentId`, `sessionId`, `isSidechain`), metadata `toolUseId` and
  `finished`, and Bash ID `toolu_01QSjPiMXuxW7iHTpqQtjxKM`. Text and tool payloads
  are replaced with small deterministic examples; unrelated fields are omitted.
  The parent fixture keeps the corresponding Agent call and its real tool ID.
- Synthetic test records exercise resumed/cancelled work, nested agent linkage,
  missing files, and truncated final JSON writes. These are not live captures.

## Review resolutions and limits

- Discovery reads complete byte records incrementally, skips malformed complete
  records with diagnostics, and retries incomplete final JSON/UTF-8 after append.
  Codex truncation tolerance does not require a copied-history marker.
- Only started activity establishes Codex descendants; peer interactions cannot
  turn the parent into a child. Provider spawn order and nested grouping persist.
- Claude missing `finished` is unknown, not active. Completion metadata, parent
  task notifications/results and child `end_turn` provide terminal evidence.
  Owned interrupt/close clears descendants and pending questions. Turn identity
  guards prevent late terminal events clearing a newer live turn. An externally
  killed provider with no terminal evidence cannot be proven stopped by replay.
- Missing/malformed Claude metadata is diagnostic, with linkage fallback where
  available. Diagnostics are deduplicated. Discovery failures use capped
  exponential retry; changing message timestamps does not cancel in-flight work.
- Background replay preserves loaded state and paging coverage. Page collection
  avoids argument spreading. Visible children use direct live events; initial or
  missing assignment history can still be replayed. No provider is started by
  discovery or selection.
- Readable Codex incoming agent prompts render with Agent provenance, including
  instruction blocks. An encrypted initial prompt can use matching plaintext
  parent spawn arguments. Ciphertext is never shown. For the actual encrypted
  session tested, Codex 0.165.0 read-only App Server `thread/read` with
  `includeTurns: true` returned no decrypted incoming prompt. Such sessions show
  an explicit unavailable notice; full prompt recovery remains provider-limited.
- Completed Codex collaboration waits without output still settle the original
  call. Synthetic completion IDs do not replace spawn IDs.

Caches are bounded: discovery indexes retain 32 entries per provider with a
2 MiB serialized state limit per entry and an 8 MiB record limit; metadata reads
are capped at 64 KiB; tails retain eight entries of at most 128 KiB raw data;
path caches retain 128 scoped entries with 2–30 second negative backoff; targeted
parent-assignment caches retain at most 32 entries and 2 MiB total. Revision and
file identity changes invalidate applicable caches. Tests verify unchanged files
avoid reparsing, tree walks and tail reads; no native performance benchmark ran.
Canonical confinement rejects file/metadata escapes and recursive lookup skips
directory symlinks. Reads are not race-free against hostile directory writers.

Real Claude evidence additionally included persisted completed task notifications
and child assistant `stop_reason: end_turn`; local metadata frequently lacked
`finished` even for old completed children. Synthetic cases cover stop ownership,
invalid bytes, nested replay, paging, ordering and late lifecycle events.

## Selected guidance

Project `bb747fd8-5395-486f-bc8b-24ccd1615e18`; no task-pinned snapshots supplied.
Artifact bodies were read and their SHA-256 hashes computed from exact body bytes.

| Logical name | Artifact ID | SHA-256 | Selected rules |
| --- | --- | --- | --- |
| rust-best-practices/protocols-and-events | ac0b2a69-a354-48e9-b24c-9257e4c78af6 | 25ccf34746bf0c35b5851dc6e73b7be61c03a40762642395d4c14918344305da | PROTO-001–004 |
| rust-best-practices/filesystem-and-persistence | 54b63896-54e1-4c65-80e8-bd85c53a6a9b | 7727a7bd159dad9e7c902c52e87d908978a2183488188b7156bcc78975fbbf6f | FS-003,005,007 |
| typescript-best-practices/realtime-and-replay | 53187d95-e9a3-445a-8044-6c7399d074e0 | c8c3473bc9338d226905a22a762044ee7ac80577108cf39787f123eb85f56415 | TSLIVE-001–004,006 |
| typescript-best-practices/event-subscriptions | 8505277d-e13a-4045-82ae-9772699d3b60 | 77a25dab4ab47c03fca6a069035bbd5c33fc8480ba9fb77881fcd7c3dd0e15cc | TEVENT-001,003,005 |
| typescript-best-practices/tauri-bindings | acc301ef-f9b9-48ca-b171-657d6dac3a69 | 079dfac723d5e9d72517cfe769fb75eedb6f4c17d858f15ea1626b61f72cc7b6 | TBIND-001–006 |

No rule exceptions claimed. Binding generation uses `npm run generate:types`
from `crates/gui`; only generator whitespace noise was removed. Validation
results and any remaining checks are reported in the task handoff; passing
linters alone does not establish guideline compliance.

## Validation and handoff

- `scripts/validate.sh`: passed workspace format, Clippy, guideline fixtures,
  coverage, sidecar preparation/tests, GUI lint/typecheck and all GUI tests.
  Rust line coverage: 89.58% (75% required). Provider library tests included
  Claude 19, Codex 56 and core 25 passing.
- `scripts/validate.sh gui` after further GUI refinements: passed, 3,105 tests
  across 237 files; lint reported 27 warnings and zero errors.
- `cargo test --locked -p gui --lib local_chat::harnesses::shared::tests`:
  six passed, including child lifecycle forwarding.
- Final permission/question lifecycle refinements: `npm run typecheck` passed;
  `npm test -- src/hooks/useChildChatSessions.test.ts src/hooks/useLocalChatEventRouter.test.ts src/stores/chatStore.test.ts`:
  193 passed across three files.
- `cargo build --locked -p gui --bin gui`: passed.
- `git diff --check`: passed.

Additional applicable guidance bodies read during review: Rust errors and
validation (ERR-001,002,004,005), observability (OBS-002,004,005,007), performance
and bounded resources (PERF-001,003,004,006,007), state machines and invariants
(STATE-001,004,006), and TypeScript performance and batching
(TSPERF-002,003,006). No exceptions claimed; green checks do not establish blanket
rule compliance.

No acceptance suite or native desktop smoke was run, and the running app was not
restarted. Fixtures and mocked integration do not establish a fresh desktop
capture. No commit, push, PR or workflow transition was performed. Review should
include native selection, live permission interaction and provider stop behavior.

## Unopened Codex history classification

The app-managed history-index load now asks the harness factory for provider
parent identity. Codex reads only the first session metadata record (64 KiB
maximum), supporting both top-level and source/thread-spawn parent fields.
It does not replay messages. Unreadable headers produce a per-session diagnostic
and do not prevent other index entries loading. The optional neutral
`providerParentResumeId` is retained through index normalization, persistence and
summaries. Existing live discovery supplies activity and richer spawn details.

The panel builds nested child outlines from these summaries before opening
conversations, removes duplicate regular rows, and keeps matching children's
ancestors visible during search before applying the row cap. Missing parents or
cyclic lineage remain accessible as standalone entries. No new caching layer or
provider process is introduced. Changed surfaces: Codex replay header reader,
harness factory, GUI index-load command/generated binding, persistence/store
summary types, history grouping and panel outline utilities.

Regression evidence: adapter test reads lineage despite invalid message data
after the header; GUI tests cover unopened persisted children without any replay
request, child-name search, nesting, orphan/cycle handling and provider scope.
`npm run generate:types` succeeded; generated semantic changes retained with
existing formatting. `scripts/validate.sh` passed: 3,107 GUI tests across 237
files, 89.57% Rust line coverage, 27 GUI lint warnings and zero errors. Final
`npm run typecheck` and the 60-test manager suite passed. `git diff --check`
passed. Native desktop smoke remains unrun; no commit/push/PR or workflow
transition performed. Previously selected guidance applies without exceptions.
