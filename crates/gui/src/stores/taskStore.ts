import { create } from "zustand";
import type { Task, TaskRunControls } from "../bindings";

interface TaskState {
  /** List of tasks for list views */
  tasks: Task[];
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
  /** Insert or update a task in the list (merges sections/code_refs/children for flat WS payloads) */
  upsertTask: (task: Task) => void;
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
  selectedTaskId: null,
  selectedTask: null,
  isLoading: false,
};

export const useTaskStore = create<TaskStore>((set) => ({
  ...initialState,

  // Actions
  setTasks: (tasks) => set({ tasks }),

  upsertTask: (task) =>
    set((state) => {
      const index = state.tasks.findIndex((t) => t.id === task.id);
      let mergedTask: Task;
      if (index >= 0) {
        const existing = state.tasks[index];
        mergedTask = {
          ...existing,
          ...task,
          sections: task.sections?.length ? task.sections : existing.sections,
          code_refs: task.code_refs?.length
            ? task.code_refs
            : existing.code_refs,
          dependency_ids: task.dependency_ids?.length
            ? task.dependency_ids
            : existing.dependency_ids,
          tags: task.tags?.length ? task.tags : existing.tags,
        };
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
        selectedTask:
          state.selectedTaskId === task.id ? task : state.selectedTask,
      };
    }),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
      ...(state.selectedTaskId === taskId
        ? { selectedTaskId: null, selectedTask: null }
        : {}),
    })),

  replaceTaskRunControls: (taskId, runControls) =>
    set((state) => {
      let changed = false;
      const tasks = state.tasks.map((task) => {
        if (task.id !== taskId) return task;
        changed = true;
        return { ...task, run_controls: runControls };
      });

      let selectedTask = state.selectedTask;
      if (selectedTask?.id === taskId) {
        changed = true;
        selectedTask = { ...selectedTask, run_controls: runControls };
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
