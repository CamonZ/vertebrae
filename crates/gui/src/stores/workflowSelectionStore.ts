import { create } from "zustand";

interface WorkflowSelectionState {
  selectedWorkflowId: string | null;
  selectedStepId: string | null;
  selectWorkflow: (workflowId: string) => void;
  selectStep: (workflowId: string, stepId: string) => void;
  clearSelection: () => void;
  reset: () => void;
}

const initialState = {
  selectedWorkflowId: null,
  selectedStepId: null,
} satisfies Pick<
  WorkflowSelectionState,
  "selectedWorkflowId" | "selectedStepId"
>;

export const useWorkflowSelectionStore = create<WorkflowSelectionState>(
  (set) => ({
    ...initialState,
    selectWorkflow: (selectedWorkflowId) =>
      set({ selectedWorkflowId, selectedStepId: null }),
    selectStep: (selectedWorkflowId, selectedStepId) =>
      set({ selectedWorkflowId, selectedStepId }),
    clearSelection: () => set(initialState),
    reset: () => set(initialState),
  })
);

export type { WorkflowSelectionState };
