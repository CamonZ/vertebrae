import { create } from "zustand";

export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
}

interface DebugState {
  logs: LogEntry[];
  debugPanelOpen: boolean;
}

interface DebugActions {
  addLog: (entry: LogEntry) => void;
  clearLogs: () => void;
  toggleDebugPanel: () => void;
}

export type DebugStore = DebugState & DebugActions;

const MAX_LOG_ENTRIES = 500;

export const useDebugStore = create<DebugStore>()((set) => ({
  logs: [],
  debugPanelOpen: false,

  addLog: (entry) =>
    set((state) => ({
      logs:
        state.logs.length >= MAX_LOG_ENTRIES
          ? [...state.logs.slice(1), entry]
          : [...state.logs, entry],
    })),

  clearLogs: () => set({ logs: [] }),

  toggleDebugPanel: () =>
    set((state) => ({ debugPanelOpen: !state.debugPanelOpen })),
}));
