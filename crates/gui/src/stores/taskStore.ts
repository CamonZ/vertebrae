import { create } from "zustand";
import type { TaskSummary, TaskWithRelations } from "../bindings";

interface TaskState {
  /** List of task summaries for list views */
  tasks: TaskSummary[];
  /** Currently selected task ID */
  selectedTaskId: string | null;
  /** Full details of the selected task with relations */
  selectedTask: TaskWithRelations | null;
  /** Loading state for async operations */
  isLoading: boolean;
}

interface TaskActions {
  /** Set the list of tasks */
  setTasks: (tasks: TaskSummary[]) => void;
  /** Select a task by ID and optionally set its full details */
  selectTask: (id: string | null, task?: TaskWithRelations | null) => void;
  /** Set the loading state */
  setLoading: (isLoading: boolean) => void;
  /** Clear the selected task */
  clearSelection: () => void;
}

export type TaskStore = TaskState & TaskActions;

export const useTaskStore = create<TaskStore>((set) => ({
  // Initial state
  tasks: [],
  selectedTaskId: null,
  selectedTask: null,
  isLoading: false,

  // Actions
  setTasks: (tasks) => set({ tasks }),

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
}));
