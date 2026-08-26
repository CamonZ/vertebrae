import { create } from "zustand";
import { useChatStore } from "./chatStore";
import { useEntityPanelStore } from "./entityPanelStore";
import { useFactoryFilterStore } from "./factoryFilterStore";
import { useSessionLogStore } from "./sessionLogStore";
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
 * project. Server-state queries are cleared here; realtime listeners and
 * normal query fetches repopulate state for the active project.
 */
export function resetProjectScopedStores() {
  useProjectScopeStore.getState().bumpGeneration();
  queryClient.clear();
  useEntityPanelStore.getState().reset();
  useFactoryFilterStore.getState().reset();
  useSessionLogStore.getState().reset();
  useChatStore.getState().reset();
}
