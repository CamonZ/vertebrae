import type { Task } from "../bindings";
import type { TaskTreeNode } from "../types/ui";

/**
 * Build a TaskTreeNode[] hierarchy from a flat array of tasks.
 * Uses parent_id to establish parent-child relationships. Blocker metadata is
 * derived from the server's run-controls state because list tasks do not carry
 * relationship payloads.
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
    const hasBlockers = task.run_controls?.disabled_reason_code === "blocked";
    const children = (childrenMap.get(task.id) ?? []).map(buildNode);
    return {
      task,
      has_blockers: hasBlockers,
      // The list contract exposes server-derived blocked state, not the
      // complete blocker collection. Preserve the useful boolean semantics
      // while representing the count as an at-least-one indicator.
      blocker_count: hasBlockers ? 1 : 0,
      children,
    };
  }

  // Root nodes: parent_id is null or parent not in task set
  const roots = tasks.filter(
    (t) => t.parent_id === null || !taskMap.has(t.parent_id)
  );

  return roots.map(buildNode);
}

/**
 * Collect IDs of every node in the hierarchy that has children
 * (i.e., is expandable).
 */
export function collectExpandableIds(nodes: TaskTreeNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.children.length > 0) {
      ids.push(node.task.id);
      ids.push(...collectExpandableIds(node.children));
    }
  }
  return ids;
}
