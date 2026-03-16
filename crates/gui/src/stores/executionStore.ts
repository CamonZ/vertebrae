import { create } from "zustand";
import type { StepExecution } from "../bindings";

interface ExecutionState {
  /** List of step executions */
  executions: StepExecution[];
}

interface ExecutionActions {
  /** Set the full list of executions */
  setExecutions: (executions: StepExecution[]) => void;
  /** Insert or update an execution in the list */
  upsertExecution: (execution: StepExecution) => void;
}

export type ExecutionStore = ExecutionState & ExecutionActions;

export const useExecutionStore = create<ExecutionStore>((set) => ({
  executions: [],

  setExecutions: (executions) => set({ executions }),

  upsertExecution: (execution) =>
    set((state) => {
      const index = state.executions.findIndex((e) => e.id === execution.id);
      if (index >= 0) {
        const executions = [...state.executions];
        executions[index] = execution;
        return { executions };
      }
      return { executions: [...state.executions, execution] };
    }),
}));
