# Permissions

Purpose: which Vertebrae actions an agent may take on its own and which need consent.
Use this when: before running any command that changes state or reaches outside the machine.

## Fine without asking
Reading: `vtb show`, `vtb list`, `vtb ready`, `vtb blockers`, `vtb sections`,
`vtb refs`, `vtb workflow list/show`, `vtb step list/show`,
`vtb workflow transition list`, `vtb artifact list/show/lookup`, and reading
daemon logs. Also any `--help`.

## Needs explicit consent, every time
- `vtb transition-to` (moving a task to another step), including `--skip-validation`.
- `vtb start-taskrun`, `vtb stop-taskrun`, `vtb workflow assign/unassign`.
- Any delete: `vtb delete`, `vtb step delete`, `vtb workflow delete`,
  `vtb workflow transition delete`, `vtb artifact delete`, `vtb unsection`, `vtb unref`.
- Restarting or reinstalling the daemon.
- Anything that posts externally (GitHub comments/reviews, pushes, PRs), creating
  git worktrees, and commits.

Consent for one action does not carry over to the next one. When the user asked
for a plan or an explanation, produce that; do not execute it.

## Usually fine when the user asked for it
Creating or updating tasks, sections, refs, workflows, steps and route configs
when the request is to create or change them. Confirm scope when the request is vague.

## Never
Print credentials (API keys, tokens, config values holding secrets). If you
must inspect a config file, show key names only, and redact values before
they reach the output.

## Related
[Running](running/index.md) · [Setup](setup/index.md)
