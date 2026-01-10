import { create } from 'zustand';
import type { Workflow, WorkflowWithTasks } from '../bindings';

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
  /** Set the current workflow with tasks */
  setCurrentWorkflow: (workflow: WorkflowWithTasks | null) => void;
  /** Set the loading state */
  setLoading: (isLoading: boolean) => void;
  /** Clear the current workflow selection */
  clearCurrentWorkflow: () => void;
}

export type WorkflowStore = WorkflowState & WorkflowActions;

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  // Initial state
  workflows: [],
  currentWorkflow: null,
  isLoading: false,

  // Actions
  setWorkflows: (workflows) => set({ workflows }),

  setCurrentWorkflow: (workflow) => set({ currentWorkflow: workflow }),

  setLoading: (isLoading) => set({ isLoading }),

  clearCurrentWorkflow: () => set({ currentWorkflow: null }),
}));
