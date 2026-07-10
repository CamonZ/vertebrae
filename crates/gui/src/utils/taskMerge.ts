import type { Task, TaskFilterOptions, TaskRunControls } from "../bindings";
import type { TaskLocation } from "./taskLocation";

function normalizeText(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

export function taskMatchesFilter(
  task: Task,
  filter: TaskFilterOptions | null,
  location?: TaskLocation
): boolean {
  if (task.archived) return false;
  if (!filter) return true;

  if (
    filter.levels?.length &&
    (!task.level || !filter.levels.includes(task.level))
  ) {
    return false;
  }

  if (filter.tags?.length) {
    const taskTags = new Set(task.tags ?? []);
    if (!filter.tags.some((tag) => taskTags.has(tag))) return false;
  }

  if (filter.root_only === true && task.parent_id) return false;
  if (filter.children_of && task.parent_id !== filter.children_of) return false;

  if (filter.search) {
    const search = normalizeText(filter.search);
    const title = normalizeText(task.title);
    const description = normalizeText(task.description);
    if (!title.includes(search) && !description.includes(search)) return false;
  }

  if (filter.workflow_id && task.workflow_id !== filter.workflow_id)
    return false;
  if (filter.step_id && task.current_step_id !== filter.step_id) return false;

  // `step_names` is a server-side compatibility filter. Do not use the
  // denormalized Task.step_name for local membership reconciliation; canonical
  // task-location rendering resolves current_step_id through query caches.
  if (
    filter.step_names?.length &&
    location &&
    location.status !== "unavailable" &&
    (!location.stepName || !filter.step_names.includes(location.stepName))
  ) {
    return false;
  }

  return true;
}

export function mergeTask(existing: Task, task: Task): Task {
  return {
    ...existing,
    ...task,
    sections: task.sections !== undefined ? task.sections : existing.sections,
    code_refs:
      task.code_refs !== undefined ? task.code_refs : existing.code_refs,
    dependency_ids:
      task.dependency_ids !== undefined
        ? task.dependency_ids
        : existing.dependency_ids,
    tags: task.tags !== undefined ? task.tags : existing.tags,
  };
}

export function taskRunControlsEqual(
  a: TaskRunControls | null | undefined,
  b: TaskRunControls | null | undefined
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
