# Running

How work executes once a task has a workflow.

- [TaskRuns](taskruns.md): starting, stopping, statuses, and what a run carries.
  Load when: "run it", `vtb start-taskrun/stop-taskrun`, run status, where a run stopped.
- [Concurrency](concurrency.md): `max_concurrency`, run trees, daemon pinning.
  Load when: parallel children, throughput, `--max-concurrency`.
- [Retries and recovery](retries-and-recovery.md): automatic retries, `retry_exhausted`, restarting a stuck task.
  Load when: a run failed, "try again", move a task back, resume after fixing a step.
