import { create } from "zustand";
import { useChatStore } from "./chatStore";
import { useEntityPanelStore } from "./entityPanelStore";
import { useExecutionStore } from "./executionStore";
import { useSessionLogStore } from "./sessionLogStore";
import { useStepStore } from "./stepStore";
import { useTaskRunStore } from "./taskRunStore";
import { useTaskStore } from "./taskStore";
import { useWorkflowStore } from "./workflowStore";
import { queryClient } from "../query/queryClient";

interface ProjectScopeState {
  generation: number;
  bumpGeneration: () => void;
}

const useProjectScopeStore = create<ProjectScopeState>((set) => ({
  generation: 0,
  bumpGeneration: () => set((state) => ({ generation: state.generation + 1 })),
}));

export function getProjectScopeGeneration() {
  return useProjectScopeStore.getState().generation;
}

export function isCurrentProjectScopeGeneration(generation: number) {
  return getProjectScopeGeneration() === generation;
}

export function useProjectScopeGeneration() {
  return useProjectScopeStore((state) => state.generation);
}

/**
 * Drop client-side state whose entity IDs are scoped to the selected Sacrum
 * project. WebSocket listeners can repopulate these stores for the active
 * project after the backend reconnects.
 */
export function resetProjectScopedStores() {
  useProjectScopeStore.getState().bumpGeneration();
  queryClient.clear();
  useTaskStore.getState().reset();
  useWorkflowStore.getState().reset();
  useStepStore.getState().reset();
  useExecutionStore.getState().reset();
  useTaskRunStore.getState().reset();
  useSessionLogStore.getState().reset();
  useChatStore.getState().reset();
  useEntityPanelStore.getState().reset();
}
