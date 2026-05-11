import { create } from "zustand";
import type { SessionLog } from "../bindings";

interface SessionLogState {
  logsByExecutionId: Record<string, SessionLog[]>;
}

interface SessionLogActions {
  setLogs: (executionId: string, logs: SessionLog[]) => void;
  appendLog: (executionId: string, log: SessionLog) => void;
  clearLogs: (executionId: string) => void;
  reset: () => void;
}

export type SessionLogStore = SessionLogState & SessionLogActions;

const initialState: SessionLogState = {
  logsByExecutionId: {},
};

export const useSessionLogStore = create<SessionLogStore>((set) => ({
  ...initialState,

  setLogs: (executionId, logs) =>
    set((state) => ({
      logsByExecutionId: { ...state.logsByExecutionId, [executionId]: logs },
    })),

  appendLog: (executionId, log) =>
    set((state) => ({
      logsByExecutionId: {
        ...state.logsByExecutionId,
        [executionId]: [...(state.logsByExecutionId[executionId] ?? []), log],
      },
    })),

  clearLogs: (executionId) =>
    set((state) => {
      const next = { ...state.logsByExecutionId };
      delete next[executionId];
      return { logsByExecutionId: next };
    }),

  reset: () => set(initialState),
}));
