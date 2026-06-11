import { create } from "zustand";
import type { SessionLog } from "../bindings";

interface SessionLogState {
  logsByExecutionId: Record<string, SessionLog[]>;
}

interface SessionLogActions {
  setLogs: (executionId: string, logs: SessionLog[]) => void;
  appendLog: (executionId: string, log: SessionLog) => void;
  upsertLog: (executionId: string, log: SessionLog) => void;
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

  upsertLog: (executionId, log) =>
    set((state) => {
      const existingLogs = state.logsByExecutionId[executionId] ?? [];
      const existingIndex = existingLogs.findIndex((existingLog) => {
        if (log.id && existingLog.id === log.id) {
          return true;
        }

        return Boolean(
          log.logical_key && existingLog.logical_key === log.logical_key
        );
      });

      const nextLogs =
        existingIndex >= 0
          ? existingLogs.map((existingLog, index) =>
              index === existingIndex ? log : existingLog
            )
          : [...existingLogs, log];

      return {
        logsByExecutionId: {
          ...state.logsByExecutionId,
          [executionId]: nextLogs,
        },
      };
    }),

  clearLogs: (executionId) =>
    set((state) => {
      const next = { ...state.logsByExecutionId };
      delete next[executionId];
      return { logsByExecutionId: next };
    }),

  reset: () => set(initialState),
}));
