import { create } from "zustand";

/** Invalidate provider pickers after a confirmed local settings save. Runtime
 * configuration is independently read by Rust for every new request. */
export const useProviderSettingsStore = create<{
  revision: number;
  changed: () => void;
}>((set) => ({
  revision: 0,
  changed: () => set((state) => ({ revision: state.revision + 1 })),
}));
