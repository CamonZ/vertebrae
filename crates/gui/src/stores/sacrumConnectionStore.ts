import { create } from "zustand";

/**
 * Mirrors the sacrumConnection react-query entry so non-React callers can
 * read the identity synchronously via getState().
 */
interface SacrumConnectionState {
  identity: string | null;
  setIdentity: (identity: string | null) => void;
  reset: () => void;
}

export const useSacrumConnectionStore = create<SacrumConnectionState>((set) => ({
  identity: null,
  setIdentity: (identity) =>
    set((state) => (state.identity === identity ? state : { identity })),
  reset: () => set({ identity: null }),
}));

export function getSacrumConnectionIdentity(): string | null {
  return useSacrumConnectionStore.getState().identity;
}

export function isCurrentSacrumConnectionIdentity(
  identity: string | null | undefined
): boolean {
  if (!identity) return false;
  return getSacrumConnectionIdentity() === identity;
}
