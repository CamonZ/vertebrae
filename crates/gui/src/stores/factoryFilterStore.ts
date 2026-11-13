import { create } from "zustand";
import type { FactoryFilterValue } from "../utils/workflowFactory";

interface FactoryFilterState {
  factoryName: FactoryFilterValue;
  /**
   * The most recent non-null factory scope. The factory overview uses it to
   * mark and focus the factory the user just came back from.
   */
  lastFactoryName: FactoryFilterValue;
  setFactoryName: (factoryName: FactoryFilterValue) => void;
  reset: () => void;
}

/** Transient factory scope shared by workflow topology and kanban views. */
export const useFactoryFilterStore = create<FactoryFilterState>((set) => ({
  factoryName: null,
  lastFactoryName: null,
  setFactoryName: (factoryName) =>
    set((state) => ({
      factoryName,
      lastFactoryName: factoryName ?? state.lastFactoryName,
    })),
  reset: () => set({ factoryName: null, lastFactoryName: null }),
}));
