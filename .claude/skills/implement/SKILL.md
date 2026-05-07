---
name: implement
description: End-to-end ticket implementation — creates a worktree, runs the ticket-implementer agent, simplifies the code, commits, and creates a PR. Use when the user wants to implement a ticket hands-off.
argument-hint: "[ticket-id]"
---

# /implement

Implement a ticket end-to-end: worktree, agent, simplify, commit, PR.

## Arguments

- `$ARGUMENTS` — optional ticket ID (short or full UUID). If omitted, infer from current conversation context.

## Steps

Execute these steps in order. If any step fails, stop and report the error.

### 1. Resolve the ticket

If a ticket ID was provided (`$ARGUMENTS`), use it. Otherwise, determine the ticket from conversation context (e.g., the ticket we've been discussing or the next ready ticket).

Run `vtb show <ticket-id>` to confirm the ticket exists and get its full details.

### 2. Create a worktree

Create a git worktree for the ticket:

```bash
git worktree add ../vertebrae-<short-id> -b <short-id>-<slugified-title>
```

Where `<short-id>` is the first 8 characters of the ticket UUID and `<slugified-title>` is the ticket title lowercased with spaces replaced by hyphens (max 60 chars).

### 3. Implement the ticket

Launch the `ticket-implementer` agent to work on the ticket in the worktree directory. Pass it:

- The full ticket ID
- The worktree path
- Instructions to run `vtb show <ticket-id>` for ticket details
- Instructions to run the relevant Vertebrae checks after implementation:
  - Rust changes: `cargo test --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance`
  - Rust lint/format: `cargo clippy --quiet -- -D warnings` and `cargo fmt --check`
  - GUI changes: run the targeted `npm` test/build command from `crates/gui`
- Instructions to mark checklist items done with `vtb check-item <ticket-id> <number>` as they complete each item

Wait for the agent to finish. If it fails, report the error and stop.

### 4. Simplify the code

Run `/simplify` on the changes in the worktree. This launches review agents and fixes any issues found.

### 5. Run tests

Run the relevant Vertebrae checks in the worktree after simplification. Prefer the focused test command for the changed surface first, then the broader workspace command when the change touches shared Rust crates:

```bash
cargo test --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance
cargo clippy --quiet -- -D warnings
cargo fmt --check
```

For GUI-only changes, run the targeted `npm` test/build command from `crates/gui` as well.

### 6. Commit

Stage all changed files and commit with the message format:

```
[<short-id>] <ticket-title>

<brief description of changes>
```

Follow the project's commit conventions from CLAUDE.md. Do NOT push or commit automatically — present the diff to the user and ask for approval first.

### 7. Create PR

After the user approves the commit:

- Push the branch with `-u` flag
- Create a PR using `gh pr create` with:
  - Title: `[<short-id>] <ticket-title>`
  - Body: summary of changes, test results, checklist of what was done

Return the PR URL when done.
