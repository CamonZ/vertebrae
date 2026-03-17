import { create } from "zustand";
import type { SessionLog } from "../bindings";

interface SessionLogState {
  logsByExecutionId: Record<string, SessionLog[]>;
}

interface SessionLogActions {
  setLogs: (executionId: string, logs: SessionLog[]) => void;
  appendLog: (executionId: string, log: SessionLog) => void;
  clearLogs: (executionId: string) => void;
}

export type SessionLogStore = SessionLogState & SessionLogActions;

export const useSessionLogStore = create<SessionLogStore>((set) => ({
  logsByExecutionId: {},

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
      const { [executionId]: _removed, ...rest } = state.logsByExecutionId;
      void _removed;
      return { logsByExecutionId: rest };
    }),
}));
