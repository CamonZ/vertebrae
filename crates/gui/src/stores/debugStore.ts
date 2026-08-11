import { create } from "zustand";

export interface LogEntry {
  timestamp: number;
  level: string;
  crateName: string;
  target?: string;
  message: string;
}

export interface DebugTraceEntry {
  id: string;
  timestamp: number;
  source: string;
  kind: string;
  direction?: string;
  sessionId?: string;
  backendSessionId?: string;
  turnId?: string;
  state?: string;
  detail?: string;
  payload?: string;
}

interface DebugState {
  logs: LogEntry[];
  traces: DebugTraceEntry[];
  debugPanelOpen: boolean;
}

interface DebugActions {
  addLog: (entry: LogEntry) => void;
  addTrace: (
    entry: Omit<DebugTraceEntry, "id" | "timestamp"> & {
      timestamp?: number;
    }
  ) => void;
  clearLogs: () => void;
  toggleDebugPanel: () => void;
}

export type DebugStore = DebugState & DebugActions;

const MAX_LOG_ENTRIES = 500;
const MAX_TRACE_ENTRIES = 500;
let nextTraceId = 0;

export const useDebugStore = create<DebugStore>()((set) => ({
  logs: [],
  traces: [],
  debugPanelOpen: false,

  addLog: (entry) =>
    set((state) => ({
      logs:
        state.logs.length >= MAX_LOG_ENTRIES
          ? [...state.logs.slice(1), entry]
          : [...state.logs, entry],
    })),

  addTrace: (entry) =>
    set((state) => {
      const trace: DebugTraceEntry = {
        ...entry,
        id: `trace-${Date.now()}-${nextTraceId++}`,
        timestamp: entry.timestamp ?? Date.now(),
      };
      return {
        traces:
          state.traces.length >= MAX_TRACE_ENTRIES
            ? [...state.traces.slice(1), trace]
            : [...state.traces, trace],
      };
    }),

  clearLogs: () => set({ logs: [], traces: [] }),

  toggleDebugPanel: () =>
    set((state) => ({ debugPanelOpen: !state.debugPanelOpen })),
}));
