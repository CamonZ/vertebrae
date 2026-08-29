import { create } from "zustand";
import type { SessionLog } from "../bindings";

interface SessionLogState {
  logsByExecutionId: Record<string, SessionLog[]>;
}

interface SessionLogActions {
  setLogs: (executionId: string, logs: SessionLog[]) => void;
  appendLog: (executionId: string, log: SessionLog) => void;
  upsertLog: (executionId: string, log: SessionLog) => void;
  applyLogBatch: (entries: readonly SessionLogBatchEntry[]) => void;
  clearLogs: (executionId: string) => void;
  reset: () => void;
}

export type SessionLogStore = SessionLogState & SessionLogActions;

export interface SessionLogBatchEntry {
  executionId: string;
  log: SessionLog;
  operation: "append" | "upsert";
}

/** Select only the live log buckets needed by a consumer. */
export function selectSessionLogsForExecutionIds(
  logsByExecutionId: Readonly<Record<string, SessionLog[]>>,
  executionIds: readonly (string | null | undefined)[]
): Record<string, SessionLog[]> {
  const scoped: Record<string, SessionLog[]> = {};
  for (const executionId of executionIds) {
    if (executionId && logsByExecutionId[executionId] !== undefined) {
      scoped[executionId] = logsByExecutionId[executionId];
    }
  }
  return scoped;
}

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
    set((state) => applyLogBatch(state, [{ executionId, log, operation: "append" }])),

  upsertLog: (executionId, log) =>
    set((state) => applyLogBatch(state, [{ executionId, log, operation: "upsert" }])),

  applyLogBatch: (entries) => set((state) => applyLogBatch(state, entries)),

  clearLogs: (executionId) =>
    set((state) => {
      const next = { ...state.logsByExecutionId };
      delete next[executionId];
      return { logsByExecutionId: next };
    }),

  reset: () => set(initialState),
}));

interface MutableExecutionLogs {
  logs: SessionLog[];
  ids: Map<string, number>;
  logicalKeys: Map<string, number>;
}

function mutableExecutionLogs(logs: readonly SessionLog[]): MutableExecutionLogs {
  const mutable: MutableExecutionLogs = {
    logs: [...logs],
    ids: new Map(),
    logicalKeys: new Map(),
  };
  logs.forEach((log, index) => {
    if (log.id) mutable.ids.set(log.id, index);
    if (log.logical_key) mutable.logicalKeys.set(log.logical_key, index);
  });
  return mutable;
}

function removeIndex(map: Map<string, number>, key: string | null | undefined, index: number) {
  if (key && map.get(key) === index) map.delete(key);
}

function findExistingIndex(
  mutable: MutableExecutionLogs,
  entry: SessionLogBatchEntry
): number {
  const idIndex = entry.log.id ? mutable.ids.get(entry.log.id) : undefined;
  if (idIndex !== undefined) return idIndex;
  if (entry.operation === "upsert" && entry.log.logical_key) {
    return mutable.logicalKeys.get(entry.log.logical_key) ?? -1;
  }
  return -1;
}

function replaceExecutionLog(
  mutable: MutableExecutionLogs,
  index: number,
  log: SessionLog
) {
  const previous = mutable.logs[index];
  removeIndex(mutable.ids, previous.id, index);
  removeIndex(mutable.logicalKeys, previous.logical_key, index);
  mutable.logs[index] = log;
  if (log.id) mutable.ids.set(log.id, index);
  if (log.logical_key) mutable.logicalKeys.set(log.logical_key, index);
}

function appendExecutionLog(mutable: MutableExecutionLogs, log: SessionLog) {
  const index = mutable.logs.length;
  mutable.logs.push(log);
  if (log.id) mutable.ids.set(log.id, index);
  if (log.logical_key) mutable.logicalKeys.set(log.logical_key, index);
}

/** Apply an ordered batch with one Zustand commit and one copied bucket per execution. */
function applyLogBatch(
  state: SessionLogState,
  entries: readonly SessionLogBatchEntry[]
): SessionLogState {
  if (entries.length === 0) return state;

  const mutableByExecutionId = new Map<string, MutableExecutionLogs>();
  const changedExecutionIds = new Set<string>();
  let changed = false;
  for (const entry of entries) {
    let mutable = mutableByExecutionId.get(entry.executionId);
    if (!mutable) {
      mutable = mutableExecutionLogs(
        state.logsByExecutionId[entry.executionId] ?? []
      );
      mutableByExecutionId.set(entry.executionId, mutable);
    }

    const existingIndex = findExistingIndex(mutable, entry);
    if (existingIndex >= 0) {
      if (entry.operation === "upsert") {
        replaceExecutionLog(mutable, existingIndex, entry.log);
        changedExecutionIds.add(entry.executionId);
        changed = true;
      }
      continue;
    }

    appendExecutionLog(mutable, entry.log);
    changedExecutionIds.add(entry.executionId);
    changed = true;
  }

  if (!changed) return state;
  const logsByExecutionId = { ...state.logsByExecutionId };
  for (const executionId of changedExecutionIds) {
    logsByExecutionId[executionId] = mutableByExecutionId.get(executionId)!.logs;
  }
  return { logsByExecutionId };
}
