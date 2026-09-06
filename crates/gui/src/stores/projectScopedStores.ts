import { create } from "zustand";
import { useChatStore } from "./chatStore";
import { useEntityPanelStore } from "./entityPanelStore";
import { useFactoryFilterStore } from "./factoryFilterStore";
import { useSacrumConnectionStore } from "./sacrumConnectionStore";
import { useSessionLogStore } from "./sessionLogStore";
import { queryClient } from "../query/queryClient";
import { isSacrumQueryKey, queryKeys } from "../query/queryKeys";

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
 * project. Project-scoped server queries are removed here; realtime
 * listeners and normal query fetches repopulate state for the active project.
 * Connection-scoped (account/backend) caches intentionally survive project
 * resets; only project-scoped queries are cleared.
 */
export function resetProjectScopedStores() {
  useProjectScopeStore.getState().bumpGeneration();
  queryClient.removeQueries({
    predicate: (query) => !isSacrumQueryKey(query.queryKey),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.sacrumConnection(),
  });
  useSacrumConnectionStore.getState().reset();
  useEntityPanelStore.getState().reset();
  useFactoryFilterStore.getState().reset();
  useSessionLogStore.getState().reset();
  useChatStore.getState().reset();
}
