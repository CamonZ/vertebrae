# Relationships

Two independent relations connect tasks.

- [Parent/child](parent-child.md): decomposition (epic -> tickets -> tasks) and how `wait_children` runs children.
  Load when: "break this down", subtasks, `--parent`, child TaskRuns, a parent run stuck in `waiting`.
- [Dependencies](dependencies.md): "A blocks B" ordering, blockers, ready work.
  Load when: `--depends-on`, `vtb depend/blockers/path/ready`, a child that never starts.
