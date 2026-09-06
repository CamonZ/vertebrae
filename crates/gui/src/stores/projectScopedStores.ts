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
 *
 * Account-scoped Sacrum queries (the connection-identity query and the
 * identity-scoped daemon subtree) are deliberately preserved: their scope is
 * the backend/account, not the project, so wiping them on every project
 * switch would defeat identity-scoped caching. The connection query is
 * invalidated rather than removed so the identity re-resolves — if the
 * backend/account actually changed, the new identity keys a fresh namespace
 * (the retired one is evicted by `useSacrumConnection`) and otherwise the
 * cached account-scoped entries simply hit.
 */
export function resetProjectScopedStores() {
  useProjectScopeStore.getState().bumpGeneration();
  queryClient.removeQueries({
    predicate: (query) => !isSacrumQueryKey(query.queryKey),
  });
  void queryClient.invalidateQueries({
    queryKey: queryKeys.sacrumConnection(),
  });
  // A project/backend switch may have changed the connected account. Drop the
  // last-observed connection identity so account-scoped state (the daemon
  // fleet) re-resolves it before applying anything.
  useSacrumConnectionStore.getState().reset();
  useEntityPanelStore.getState().reset();
  useFactoryFilterStore.getState().reset();
  useSessionLogStore.getState().reset();
  useChatStore.getState().reset();
}
