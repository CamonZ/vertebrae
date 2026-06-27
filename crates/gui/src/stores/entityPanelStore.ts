import { create } from "zustand";

export type EntityPanelSelection =
  | { type: "task"; taskId: string }
  | { type: "workflow"; workflowId: string }
  | { type: "step"; stepId: string; workflowId?: string | null };

interface EntityPanelState {
  selection: EntityPanelSelection | null;
  openTask: (taskId: string) => void;
  openWorkflow: (workflowId: string) => void;
  openStep: (stepId: string, workflowId?: string | null) => void;
  close: () => void;
  reset: () => void;
}

export const useEntityPanelStore = create<EntityPanelState>((set) => ({
  selection: null,
  openTask: (taskId) => set({ selection: { type: "task", taskId } }),
  openWorkflow: (workflowId) =>
    set({ selection: { type: "workflow", workflowId } }),
  openStep: (stepId, workflowId = null) =>
    set({ selection: { type: "step", stepId, workflowId } }),
  close: () => set({ selection: null }),
  reset: () => set({ selection: null }),
}));
