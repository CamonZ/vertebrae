import type { Task } from "../bindings";

const KEY_PREFIX = "task-stash:";

export interface TaskStashPayload {
  task: Task;
  related: Task[];
}

function key(taskId: string): string {
  return `${KEY_PREFIX}${taskId}`;
}

/**
 * Stash a task plus its related entries (children + dependents) in
 * `localStorage` so a freshly-opened pop-out window can seed its empty
 * task store without a backend round-trip. Tauri webviews of the same
 * origin share `localStorage`, which makes this a valid hand-off channel.
 */
export function stashTask(task: Task, related: Task[]): void {
  try {
    localStorage.setItem(
      key(task.id),
      JSON.stringify({ task, related } satisfies TaskStashPayload),
    );
  } catch {
    // Out of quota or storage disabled — silently fall back to fetch path
  }
}

/**
 * Read and remove a stashed payload. Returns null if nothing was stashed
 * or the entry is malformed; callers should fall back to fetching.
 */
export function takeStashedTask(taskId: string): TaskStashPayload | null {
  try {
    const raw = localStorage.getItem(key(taskId));
    if (!raw) return null;
    localStorage.removeItem(key(taskId));
    return JSON.parse(raw) as TaskStashPayload;
  } catch {
    return null;
  }
}
