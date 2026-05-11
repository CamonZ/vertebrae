import { create } from "zustand";
import type { TaskRun } from "../bindings";

interface TaskRunState {
  taskRuns: TaskRun[];
  taskRunsByTaskId: Record<string, TaskRun[]>;
}

interface TaskRunActions {
  setTaskRuns: (taskRuns: TaskRun[]) => void;
  upsertTaskRun: (taskRun: TaskRun) => void;
  setTaskRunsForTask: (taskId: string, taskRuns: TaskRun[]) => void;
  clearTaskRunsForTask: (taskId: string) => void;
  reset: () => void;
}

export type TaskRunStore = TaskRunState & TaskRunActions;

const initialState: TaskRunState = {
  taskRuns: [],
  taskRunsByTaskId: {},
};

function upsertInList(list: TaskRun[], taskRun: TaskRun): TaskRun[] {
  const idx = list.findIndex((run) => run.id === taskRun.id);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = taskRun;
    return next;
  }
  return [...list, taskRun];
}

function removeFromList(
  list: TaskRun[] | undefined,
  taskRunId: string
): TaskRun[] {
  if (!list) return [];
  return list.filter((run) => run.id !== taskRunId);
}

export const useTaskRunStore = create<TaskRunStore>((set) => ({
  ...initialState,

  setTaskRuns: (taskRuns) =>
    set({
      taskRuns,
      taskRunsByTaskId: taskRuns.reduce<Record<string, TaskRun[]>>(
        (byTaskId, taskRun) => {
          byTaskId[taskRun.task_id] = byTaskId[taskRun.task_id] ?? [];
          byTaskId[taskRun.task_id].push(taskRun);
          return byTaskId;
        },
        {}
      ),
    }),

  upsertTaskRun: (taskRun) =>
    set((state) => {
      const existing = state.taskRuns.find((run) => run.id === taskRun.id);
      const previousTaskId = existing?.task_id;
      const taskRuns = upsertInList(state.taskRuns, taskRun);
      const taskRunsByTaskId = { ...state.taskRunsByTaskId };
      let changed = taskRuns !== state.taskRuns;

      if (previousTaskId && previousTaskId !== taskRun.task_id) {
        const previousBucket = removeFromList(
          taskRunsByTaskId[previousTaskId],
          taskRun.id
        );
        if (previousBucket.length === 0) {
          delete taskRunsByTaskId[previousTaskId];
        } else {
          taskRunsByTaskId[previousTaskId] = previousBucket;
        }
        changed = true;
      }

      const currentBucket = taskRunsByTaskId[taskRun.task_id] ?? [];
      const nextBucket = upsertInList(currentBucket, taskRun);
      if (nextBucket !== currentBucket) {
        taskRunsByTaskId[taskRun.task_id] = nextBucket;
        changed = true;
      }

      if (!changed) return state;

      return {
        taskRuns,
        taskRunsByTaskId,
      };
    }),

  setTaskRunsForTask: (taskId, taskRuns) =>
    set((state) => {
      const incomingIds = new Set(taskRuns.map((run) => run.id));
      return {
        taskRuns: [
          ...state.taskRuns.filter(
            (run) => run.task_id !== taskId && !incomingIds.has(run.id)
          ),
          ...taskRuns,
        ],
        taskRunsByTaskId: {
          ...state.taskRunsByTaskId,
          [taskId]: taskRuns,
        },
      };
    }),

  clearTaskRunsForTask: (taskId) =>
    set((state) => {
      const taskRuns = state.taskRuns.filter((run) => run.task_id !== taskId);
      if (
        !(taskId in state.taskRunsByTaskId) &&
        taskRuns.length === state.taskRuns.length
      ) {
        return state;
      }
      const next = { ...state.taskRunsByTaskId };
      delete next[taskId];
      return { taskRuns, taskRunsByTaskId: next };
    }),

  reset: () => set(initialState),
}));
