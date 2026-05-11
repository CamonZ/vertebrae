import { create } from "zustand";
import type { StepExecution } from "../bindings";

interface ExecutionState {
  executions: StepExecution[];
  // Per-task cache populated by subtree fan-out fetches and kept fresh
  // by `upsertExecution` (called from the global step-execution listener).
  executionsByTaskId: Record<string, StepExecution[]>;
}

interface ExecutionActions {
  setExecutions: (executions: StepExecution[]) => void;
  upsertExecution: (execution: StepExecution) => void;
  setExecutionsForTask: (taskId: string, executions: StepExecution[]) => void;
  clearExecutionsForTask: (taskId: string) => void;
  reset: () => void;
}

export type ExecutionStore = ExecutionState & ExecutionActions;

const initialState: ExecutionState = {
  executions: [],
  executionsByTaskId: {},
};

function upsertInList(
  list: StepExecution[],
  execution: StepExecution
): StepExecution[] {
  const idx = list.findIndex((e) => e.id === execution.id);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = execution;
    return next;
  }
  return [...list, execution];
}

export const useExecutionStore = create<ExecutionStore>((set) => ({
  ...initialState,

  setExecutions: (executions) => set({ executions }),

  upsertExecution: (execution) =>
    set((state) => {
      const executions = upsertInList(state.executions, execution);
      const key = execution.task_id || null;
      if (!key) {
        return { executions };
      }
      const bucket = state.executionsByTaskId[key] ?? [];
      return {
        executions,
        executionsByTaskId: {
          ...state.executionsByTaskId,
          [key]: upsertInList(bucket, execution),
        },
      };
    }),

  setExecutionsForTask: (taskId, executions) =>
    set((state) => ({
      executionsByTaskId: {
        ...state.executionsByTaskId,
        [taskId]: executions,
      },
    })),

  clearExecutionsForTask: (taskId) =>
    set((state) => {
      if (!(taskId in state.executionsByTaskId)) return state;
      const next = { ...state.executionsByTaskId };
      delete next[taskId];
      return { executionsByTaskId: next };
    }),

  reset: () => set(initialState),
}));
