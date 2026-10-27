# Codex 0.164 code-mode replay fixtures

`rollout.jsonl` contains minimal real `event_msg/item_completed` records.
Command and file items come from session
`01a17f07-5d7e-70d2-95e4-6144730e158b` (2026-10-27); the MCP item comes from
`01a179d4-d8f3-7e92-804b-e199fb19aac2` (2026-10-26).

`app-server-items.json` contains the corresponding items returned by
`codex app-server` `thread/read` with `includeTurns: true` on 2026-10-27,
using the same item IDs. These are provider-projected history items, **not a
capture of live item/started or item/completed notifications**. The parity
test applies Vertebrae's live projection to these items and compares the
resulting payloads and IDs with rollout replay. A fresh live-notification / GUI
smoke check remains a separate integration verification obligation.

`plumbing.jsonl` preserves real call types, names, namespaces, and call IDs
from local rollouts dated 2026-10-24 through 2026-10-27. Arguments containing
session-specific content are replaced; output records use placeholder bodies.
It includes the parent session's `spawn_agent` and `wait_agent` calls, without
loading child transcripts.

Redaction replaces the scratch directory with `/fixture`, the MCP result
with a short placeholder, and exec/js/spawn arguments with benign samples.
Provider IDs, command argv, file content, statuses, and wire field names stay
intact. Internal metadata and unrelated records are omitted. The three primary
items are combined from two sessions to keep the fixture minimal.

The synthetic cases in `src/rollout/tests.rs` additionally cover failures,
quoting, percent-encoded cwd, add/delete/update/move changes, unsupported items,
legacy records, overlapping representations, and bounded-tail/page boundaries.

## Assignment handoff

Implemented [596bb63c](vtb://task/596bb63c-cbf4-4bf5-9ed9-c4e4c79d07c6)
from master `28a3401b` in branch `596bb63c-codex-rollout-parity`.
Provider parsing stays in harness-codex; no GUI or core contract changes.
Completed items override legacy representations with the same ID, and replay
projection identity is bumped to `codex-v3` to invalidate old cursors.
Ambiguous bounded tails defer to full normalization, using the existing replay
contract, when legacy calls or orphan outputs need earlier context.

Changed implementation files: `src/rollout.rs`, `src/runtime/projection.rs`,
`src/runtime/mod.rs`, and `src/replay.rs` (relative to harness-codex).
Added `src/rollout/tests.rs` and this fixture directory. `Cargo.toml` adds
existing lockfile versions of shlex and url for shell quoting and file-URI
conversion; the workspace `Cargo.lock` changes only their dependency edges.

Verification in `/Users/camonz/Code/code_intelligence/vertebrae-596bb63c`:

- `cargo test --locked -p vertebrae-harness-codex --lib`: 48 passed, 0 failed.
- `scripts/validate.sh rust`: exit 0; formatting, locked workspace Clippy with
  denied warnings, guideline fixtures, and workspace coverage passed.
  Coverage excludes GUI and acceptance crates per the maintained profile;
  total line coverage was 89.51% (75% required).
- `cargo fmt --check` and `git diff --check`: exit 0.

Initial implementation run logs: `/tmp/vtb-596bb63c-focused.log` and
`/tmp/vtb-596bb63c-validation.log`. The initial Rust profile did not include GUI frontend checks or Docker
acceptance. Publication checks are reported on the PR. Fresh live-notification
capture and desktop smoke verification remain unrun, as described above.
Workflow state is unchanged.

### Selected project guidance

Bodies were read through project-scoped artifact lookup for project
`bb747fd8-5395-486f-bc8b-24ccd1615e18`; SHA-256 hashes below match the catalog.
No pinned guidance was supplied with the assignment. No task-local exceptions
were taken. The checks and fixtures provide evidence for the selected rules;
they do not establish blanket guideline compliance.

| Logical name | Artifact ID | SHA-256 | Applicable rules |
| --- | --- | --- | --- |
| `rust-best-practices/protocols-and-events` | `ac0b2a69-a354-48e9-b24c-9257e4c78af6` | `25ccf34746bf0c35b5851dc6e73b7be61c03a40762642395d4c14918344305da` | PROTO-001, PROTO-002, PROTO-003, PROTO-004 |
| `rust-best-practices/testing-and-verification` | `a3380d93-9b27-4edd-8a4d-e23b19a0ac7c` | `72eb24ead8f9da095f29ff630ad4aaac0496aa36e5a19205e7883524df3a8705` | TEST-001, TEST-002, TEST-003, TEST-004, TEST-006 |
| `rust-best-practices/cargo-and-dependencies` | `5b0b3cef-d089-4cfe-99f1-c6829429a5ac` | `1a7a11434f31b7ccb28291e1d9ee22c2445058849fa803d1871cee5f6bfd74eb` | CARGO-001, CARGO-002, CARGO-006, CARGO-008 |
