import { create } from "zustand";
import type { Task, TaskFilterOptions, TaskRunControls } from "../bindings";

interface TaskState {
  /** List of tasks for list views */
  tasks: Task[];
  /** Backend filter that produced the current task list */
  activeFilter: TaskFilterOptions | null;
  /** Currently selected task ID */
  selectedTaskId: string | null;
  /** Full details of the selected task */
  selectedTask: Task | null;
  /** Loading state for async operations */
  isLoading: boolean;
}

interface TaskActions {
  /** Set the list of tasks */
  setTasks: (tasks: Task[]) => void;
  /** Set the backend filter that produced the current task list */
  setActiveFilter: (filter: TaskFilterOptions | null) => void;
  /** Insert or update a task in the list (merges sections/code_refs/children for flat WS payloads) */
  upsertTask: (task: Task) => void;
  /** Insert, update, or remove a task according to the active list filter */
  reconcileTask: (task: Task) => void;
  /** Remove a task by ID; clears selection if the removed task is currently selected */
  removeTask: (taskId: string) => void;
  /** Replace server-derived TaskRun controls on an existing task row */
  replaceTaskRunControls: (
    taskId: string,
    runControls: TaskRunControls | null
  ) => void;
  /** Select a task by ID and optionally set its full details */
  selectTask: (id: string | null, task?: Task | null) => void;
  /** Set the loading state */
  setLoading: (isLoading: boolean) => void;
  /** Clear the selected task */
  clearSelection: () => void;
  /** Reset all project-scoped task state */
  reset: () => void;
}

export type TaskStore = TaskState & TaskActions;

const initialState: TaskState = {
  tasks: [],
  activeFilter: null,
  selectedTaskId: null,
  selectedTask: null,
  isLoading: false,
};

function normalizeText(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

export function taskMatchesFilter(
  task: Task,
  filter: TaskFilterOptions | null
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

  if (
    filter.step_names?.length &&
    (!task.step_name || !filter.step_names.includes(task.step_name))
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
    code_refs: task.code_refs !== undefined ? task.code_refs : existing.code_refs,
    dependency_ids:
      task.dependency_ids !== undefined
        ? task.dependency_ids
        : existing.dependency_ids,
    tags: task.tags !== undefined ? task.tags : existing.tags,
  };
}

function taskObjectsEqual(a: Task, b: Task): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function taskRunControlsEqual(
  a: TaskRunControls | null | undefined,
  b: TaskRunControls | null | undefined
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function upsertTaskInState(state: TaskStore, task: Task): Partial<TaskStore> {
  const index = state.tasks.findIndex((t) => t.id === task.id);
  if (index >= 0) {
    const mergedTask = mergeTask(state.tasks[index], task);
    if (taskObjectsEqual(state.tasks[index], mergedTask)) {
      return state.selectedTaskId === task.id &&
        state.selectedTask &&
        !taskObjectsEqual(state.selectedTask, mergedTask)
        ? { selectedTask: mergedTask }
        : state;
    }
    const tasks = [...state.tasks];
    tasks[index] = mergedTask;
    return {
      tasks,
      selectedTask:
        state.selectedTaskId === task.id ? mergedTask : state.selectedTask,
    };
  }

  return {
    tasks: [...state.tasks, task],
    selectedTask: state.selectedTaskId === task.id ? task : state.selectedTask,
  };
}

export const useTaskStore = create<TaskStore>((set) => ({
  ...initialState,

  // Actions
  setTasks: (tasks) => set({ tasks }),

  setActiveFilter: (activeFilter) => set({ activeFilter }),

  upsertTask: (task) => set((state) => upsertTaskInState(state, task)),

  reconcileTask: (task) =>
    set((state) => {
      const index = state.tasks.findIndex((t) => t.id === task.id);
      const existing = index >= 0 ? state.tasks[index] : null;
      const mergedTask = existing ? mergeTask(existing, task) : task;
      const belongsInList = taskMatchesFilter(mergedTask, state.activeFilter);

      if (!belongsInList) {
        if (index === -1) return state;
        return {
          tasks: state.tasks.filter((t) => t.id !== task.id),
          ...(state.selectedTaskId === task.id
            ? { selectedTaskId: null, selectedTask: null }
            : {}),
        };
      }

      return upsertTaskInState(state, mergedTask);
    }),

  removeTask: (taskId) =>
    set((state) => {
      if (!state.tasks.some((task) => task.id === taskId)) return state;

      return {
        tasks: state.tasks.filter((t) => t.id !== taskId),
        ...(state.selectedTaskId === taskId
          ? { selectedTaskId: null, selectedTask: null }
          : {}),
      };
    }),

  replaceTaskRunControls: (taskId, runControls) =>
    set((state) => {
      let changed = false;
      const tasks = state.tasks.map((task) => {
        if (task.id !== taskId) return task;
        if (taskRunControlsEqual(task.run_controls, runControls)) return task;
        changed = true;
        return { ...task, run_controls: runControls };
      });

      let selectedTask = state.selectedTask;
      if (selectedTask?.id === taskId) {
        if (!taskRunControlsEqual(selectedTask.run_controls, runControls)) {
          changed = true;
          selectedTask = { ...selectedTask, run_controls: runControls };
        }
      }

      if (!changed) return state;

      return { tasks, selectedTask };
    }),

  selectTask: (id, task) =>
    set({
      selectedTaskId: id,
      selectedTask: task ?? null,
    }),

  setLoading: (isLoading) => set({ isLoading }),

  clearSelection: () =>
    set({
      selectedTaskId: null,
      selectedTask: null,
    }),

  reset: () => set(initialState),
}));
