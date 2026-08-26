import { create } from "zustand";
import type { FactoryFilterValue } from "../utils/workflowFactory";

interface FactoryFilterState {
  factoryName: FactoryFilterValue;
  setFactoryName: (factoryName: FactoryFilterValue) => void;
  reset: () => void;
}

/** Transient factory scope shared by workflow topology and kanban views. */
export const useFactoryFilterStore = create<FactoryFilterState>((set) => ({
  factoryName: null,
  setFactoryName: (factoryName) => set({ factoryName }),
  reset: () => set({ factoryName: null }),
}));
