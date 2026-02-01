import type { Task, TaskTreeNode } from "../bindings";

/**
 * Build a TaskTreeNode[] hierarchy from a flat array of tasks.
 * Uses parent_id to establish parent-child relationships and
 * dependency_ids to compute blocker info.
 *
 * Root nodes are tasks whose parent_id is null or whose parent
 * is not present in the provided task set.
 */
export function buildTreeFromTasks(tasks: Task[]): TaskTreeNode[] {
  const taskMap = new Map<string, Task>();
  const childrenMap = new Map<string, Task[]>();

  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  // Group tasks by parent_id
  for (const task of tasks) {
    if (task.parent_id && taskMap.has(task.parent_id)) {
      const siblings = childrenMap.get(task.parent_id);
      if (siblings) {
        siblings.push(task);
      } else {
        childrenMap.set(task.parent_id, [task]);
      }
    }
  }

  function buildNode(task: Task): TaskTreeNode {
    const depCount = task.dependency_ids?.length ?? 0;
    const children = (childrenMap.get(task.id) ?? []).map(buildNode);
    return {
      task,
      has_blockers: depCount > 0,
      blocker_count: depCount,
      children,
    };
  }

  // Root nodes: parent_id is null or parent not in task set
  const roots = tasks.filter(
    (t) => t.parent_id === null || !taskMap.has(t.parent_id)
  );

  return roots.map(buildNode);
}
