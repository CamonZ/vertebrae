import { create } from "zustand";

export type EntityPanelSelection =
  | { type: "task"; taskId: string }
  | { type: "workflow"; workflowId: string }
  | { type: "step"; stepId: string; workflowId?: string | null };

/**
 * Canonical owner for the one task/workflow/step detail surface.
 *
 * Chat links, task lists, the workflow atlas, and the run console all replace
 * this selection. `GlobalEntityPanelHost` is the only component that renders
 * the corresponding detail panel, so those entry points cannot create a
 * second panel for the same entity surface.
 */
interface EntityPanelState {
  selection: EntityPanelSelection | null;
  hoveredEdgeId: string | null;
  openTask: (taskId: string) => void;
  openWorkflow: (workflowId: string) => void;
  openStep: (stepId: string, workflowId?: string | null) => void;
  setHoveredEdge: (edgeId: string | null) => void;
  close: () => void;
  reset: () => void;
}

export const useEntityPanelStore = create<EntityPanelState>((set) => ({
  selection: null,
  hoveredEdgeId: null,
  openTask: (taskId) =>
    set({ selection: { type: "task", taskId }, hoveredEdgeId: null }),
  openWorkflow: (workflowId) =>
    set({ selection: { type: "workflow", workflowId }, hoveredEdgeId: null }),
  openStep: (stepId, workflowId = null) =>
    set({
      selection: { type: "step", stepId, workflowId },
      hoveredEdgeId: null,
    }),
  setHoveredEdge: (hoveredEdgeId) => set({ hoveredEdgeId }),
  close: () => set({ selection: null, hoveredEdgeId: null }),
  reset: () => set({ selection: null, hoveredEdgeId: null }),
}));
