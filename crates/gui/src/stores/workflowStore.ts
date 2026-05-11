import { create } from "zustand";
import type { Workflow, WorkflowWithTasks } from "../bindings";

interface WorkflowState {
  /** List of all workflows */
  workflows: Workflow[];
  /** Currently selected workflow with its associated tasks */
  currentWorkflow: WorkflowWithTasks | null;
  /** Loading state for async operations */
  isLoading: boolean;
}

interface WorkflowActions {
  /** Set the list of workflows */
  setWorkflows: (workflows: Workflow[]) => void;
  /** Insert or update a workflow in the list */
  upsertWorkflow: (workflow: Workflow) => void;
  /** Remove a workflow by ID; clears currentWorkflow if it matches */
  removeWorkflow: (workflowId: string) => void;
  /** Set the current workflow with tasks */
  setCurrentWorkflow: (workflow: WorkflowWithTasks | null) => void;
  /** Set the loading state */
  setLoading: (isLoading: boolean) => void;
  /** Clear the current workflow selection */
  clearCurrentWorkflow: () => void;
  /** Reset all project-scoped workflow state */
  reset: () => void;
}

export type WorkflowStore = WorkflowState & WorkflowActions;

const initialState: WorkflowState = {
  workflows: [],
  currentWorkflow: null,
  isLoading: false,
};

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  ...initialState,

  // Actions
  setWorkflows: (workflows) => set({ workflows }),

  upsertWorkflow: (workflow) =>
    set((state) => {
      const index = state.workflows.findIndex((w) => w.id === workflow.id);
      if (index >= 0) {
        const workflows = [...state.workflows];
        workflows[index] = workflow;
        return {
          workflows,
          currentWorkflow:
            state.currentWorkflow?.workflow?.id === workflow.id
              ? { ...state.currentWorkflow, workflow }
              : state.currentWorkflow,
        };
      }
      return { workflows: [...state.workflows, workflow] };
    }),

  removeWorkflow: (workflowId) =>
    set((state) => ({
      workflows: state.workflows.filter((w) => w.id !== workflowId),
      ...(state.currentWorkflow?.workflow?.id === workflowId
        ? { currentWorkflow: null }
        : {}),
    })),

  setCurrentWorkflow: (workflow) => set({ currentWorkflow: workflow }),

  setLoading: (isLoading) => set({ isLoading }),

  clearCurrentWorkflow: () => set({ currentWorkflow: null }),

  reset: () => set(initialState),
}));
