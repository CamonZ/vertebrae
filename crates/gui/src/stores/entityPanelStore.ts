import { create } from "zustand";
import { usePanelFocusStore } from "./panelFocusStore";

export const TASK_DETAIL_PANEL_ID = "task-detail";
export const ARTIFACT_INSPECTOR_PANEL_ID = "artifact-inspector";

export type EntityPanelSelection =
  | { type: "task"; taskId: string }
  | { type: "workflow"; workflowId: string }
  | { type: "step"; stepId: string; workflowId?: string | null };

/**
 * Canonical owner for the shared entity inspector selections.
 *
 * Chat links, task lists, the workflow atlas, and the run console all replace
 * this selection. `GlobalEntityPanelHost` is the only component that renders
 * the corresponding detail panel, so those entry points cannot create a
 * second panel for the same entity surface.
 */
interface EntityPanelState {
  selection: EntityPanelSelection | null;
  artifactId: string | null;
  openArtifact: (artifactId: string) => void;
  closeArtifact: () => void;
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
  artifactId: null,
  openArtifact: (artifactId) => {
    set((state) => ({
      artifactId,
      selection: state.selection?.type === "task" ? state.selection : null,
      hoveredEdgeId: null,
    }));
    const panels = usePanelFocusStore.getState();
    if (panels.stack.includes(ARTIFACT_INSPECTOR_PANEL_ID)) {
      panels.focus(ARTIFACT_INSPECTOR_PANEL_ID);
    }
  },
  closeArtifact: () => set({ artifactId: null }),
  hoveredEdgeId: null,
  openTask: (taskId) =>
    set((state) => ({
      selection: { type: "task", taskId },
      artifactId:
        state.selection?.type === "task" && state.selection.taskId === taskId
          ? state.artifactId
          : null,
      hoveredEdgeId: null,
    })),
  openWorkflow: (workflowId) =>
    set({
      selection: { type: "workflow", workflowId },
      artifactId: null,
      hoveredEdgeId: null,
    }),
  openStep: (stepId, workflowId = null) =>
    set({
      selection: { type: "step", stepId, workflowId },
      artifactId: null,
      hoveredEdgeId: null,
    }),
  setHoveredEdge: (hoveredEdgeId) => set({ hoveredEdgeId }),
  close: () => set({ selection: null, hoveredEdgeId: null }),
  reset: () => set({ selection: null, artifactId: null, hoveredEdgeId: null }),
}));
