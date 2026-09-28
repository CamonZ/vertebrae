# Concurrency

Purpose: control how much of a run tree executes at once.
Use this when: running many children, or limiting load on the machine or provider.

## How it works
- `--max-concurrency N` on `vtb start-taskrun` sets the budget on the root
  TaskRun: the maximum concurrently executing step attempts across the whole
  tree. Omitted, the backend's global pool limit applies.
- Child TaskRuns created by `wait_children` inherit the root's budget; they
  cannot set their own.
- A run tree is pinned to one daemon.
- Waiting parents release their execution slot while children run.

## Doing it
For an epic with many independent tickets: `vtb start-taskrun <epic> --max-concurrency 3`
(with consent). Use dependencies to serialize tickets that must not overlap.

## Gotchas
Parallel children working in the same checkout can conflict; give each task its own `--worktree`.

## Related
[Parent/child](../tasks/relationships/parent-child.md) · [wait_children](../workflows/steps/wait_children.md)
