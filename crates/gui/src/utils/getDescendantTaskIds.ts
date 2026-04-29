import type { Task } from "../bindings";

/**
 * Return the set of task ids comprising `rootTaskId` and all of its
 * descendants, computed by walking `parent_id` links over the supplied
 * task list.
 *
 * Returns an empty array when `rootTaskId` is not present in `tasks` so
 * callers can treat "unknown root" and "leaf with no descendants" as
 * distinct via the array contents (the leaf case still returns
 * `[rootTaskId]`).
 *
 * The traversal is iterative and guards against cycles by tracking
 * visited ids — defensive against any malformed parent chains coming
 * from the wire.
 */
export function getDescendantTaskIds(
  rootTaskId: string,
  tasks: readonly Task[]
): string[] {
  const taskById = new Map<string, Task>();
  const childrenByParent = new Map<string, Task[]>();
  for (const task of tasks) {
    taskById.set(task.id, task);
    if (task.parent_id) {
      const siblings = childrenByParent.get(task.parent_id);
      if (siblings) {
        siblings.push(task);
      } else {
        childrenByParent.set(task.parent_id, [task]);
      }
    }
  }

  if (!taskById.has(rootTaskId)) {
    return [];
  }

  const visited = new Set<string>();
  const result: string[] = [];
  const stack: string[] = [rootTaskId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    const children = childrenByParent.get(id);
    if (children) {
      for (const child of children) {
        if (!visited.has(child.id)) stack.push(child.id);
      }
    }
  }
  return result;
}
