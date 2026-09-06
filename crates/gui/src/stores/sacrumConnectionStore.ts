import { create } from "zustand";

/**
 * Last-observed backend/account connection identity for account-scoped
 * (project-independent) server state such as the daemon fleet.
 *
 * The identity is a non-reversible digest of the Sacrum base URL and account
 * token produced by the Rust client; it never contains the token itself. The
 * authoritative late-response guard lives in the Tauri commands, which reject
 * any response whose connection changed mid-request; this store backs the
 * frontend's defense-in-depth check that a late response is never applied to
 * the current scope.
 *
 * The identity is dual-tracked with the `sacrumConnection` react-query entry
 * on purpose: the query is the authoritative async resolution, while this
 * store mirrors its latest value for synchronous non-React reads via
 * `getState()` — notably the imperative mutation guard in
 * `useDaemonMutations`, which runs outside React's render cycle and must
 * capture the identity at mutation start. Do not "fix" the mirror away in
 * favor of the query cache alone.
 */
interface SacrumConnectionState {
  identity: string | null;
  setIdentity: (identity: string | null) => void;
  reset: () => void;
}

export const useSacrumConnectionStore = create<SacrumConnectionState>((set) => ({
  identity: null,
  // Returning the same state object when the identity is unchanged skips
  // subscriber notifications for no-op identity refreshes.
  setIdentity: (identity) =>
    set((state) => (state.identity === identity ? state : { identity })),
  reset: () => set({ identity: null }),
}));

/** Current backend/account identity, or null when none has been observed. */
export function getSacrumConnectionIdentity(): string | null {
  return useSacrumConnectionStore.getState().identity;
}

/**
 * Whether `identity` is still the current connection. Unknown (null/empty)
 * identities are never current: an unscoped payload must not be applied.
 */
export function isCurrentSacrumConnectionIdentity(
  identity: string | null | undefined
): boolean {
  if (!identity) return false;
  return getSacrumConnectionIdentity() === identity;
}
