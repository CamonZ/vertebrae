import { create } from "zustand";
import type { SessionLog } from "../bindings";
import {
  costFromSessionLog,
  costFromSessionLogs,
} from "../utils/computeExecutionRollups";

const SESSION_LOG_MAX_BATCH_SIZE = 256;
const SESSION_LOG_MAX_FLUSH_INTERVAL_MS = 50;

export interface ExecutionLogBucket {
  logs: SessionLog[];
  fallbackCost: number;
}

interface SessionLogState {
  logsByExecutionId: Record<string, ExecutionLogBucket>;
}

interface SessionLogActions {
  setLogs: (executionId: string, logs: SessionLog[]) => void;
  appendLog: (executionId: string, log: SessionLog) => void;
  upsertLog: (executionId: string, log: SessionLog) => void;
  applyLogBatch: (entries: readonly SessionLogBatchEntry[]) => void;
  flushPending: () => void;
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
  logsByExecutionId: Readonly<Record<string, ExecutionLogBucket>>,
  executionIds: readonly (string | null | undefined)[]
): Record<string, SessionLog[]> {
  const scoped: Record<string, SessionLog[]> = {};
  for (const executionId of executionIds) {
    if (executionId && logsByExecutionId[executionId] !== undefined) {
      scoped[executionId] = logsByExecutionId[executionId].logs;
    }
  }
  return scoped;
}

/** Select incrementally maintained fallback costs for the same execution scope. */
export function selectSessionLogCostsForExecutionIds(
  logsByExecutionId: Readonly<Record<string, ExecutionLogBucket>>,
  executionIds: readonly (string | null | undefined)[]
): Record<string, number> {
  const scoped: Record<string, number> = {};
  for (const executionId of executionIds) {
    if (executionId && logsByExecutionId[executionId] !== undefined) {
      scoped[executionId] = logsByExecutionId[executionId].fallbackCost;
    }
  }
  return scoped;
}

const initialState: SessionLogState = {
  logsByExecutionId: {},
};

let pendingEntries: SessionLogBatchEntry[] = [];
let frameHandle: number | null = null;
let timerHandle: ReturnType<typeof setTimeout> | null = null;

function cancelScheduledFlush(): void {
  if (frameHandle !== null) {
    if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(frameHandle);
    }
    frameHandle = null;
  }
  if (timerHandle !== null) {
    globalThis.clearTimeout(timerHandle);
    timerHandle = null;
  }
}

function scheduleFlush(): void {
  if (pendingEntries.length === 0) return;
  if (frameHandle !== null || timerHandle !== null) return;

  if (typeof globalThis.requestAnimationFrame === "function") {
    frameHandle = globalThis.requestAnimationFrame(() => {
      frameHandle = null;
      if (timerHandle !== null) {
        globalThis.clearTimeout(timerHandle);
        timerHandle = null;
      }
      flushOneBatch();
      scheduleFlush();
    });
  }

  timerHandle = globalThis.setTimeout(() => {
    timerHandle = null;
    if (frameHandle !== null) {
      if (typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(frameHandle);
      }
      frameHandle = null;
    }
    flushOneBatch();
    scheduleFlush();
  }, SESSION_LOG_MAX_FLUSH_INTERVAL_MS);
}

function queueLog(entry: SessionLogBatchEntry): void {
  pendingEntries.push(entry);
  scheduleFlush();
}

function flushOneBatch(): void {
  if (pendingEntries.length === 0) return;
  const batch = pendingEntries.splice(0, SESSION_LOG_MAX_BATCH_SIZE);
  try {
    useSessionLogStore.getState().applyLogBatch(batch);
  } catch (error) {
    pendingEntries.unshift(...batch);
    scheduleFlush();
    throw error;
  }
}

function flushPendingNow(): void {
  cancelScheduledFlush();
  flushOneBatch();
  scheduleFlush();
}

function discardPending(): void {
  cancelScheduledFlush();
  pendingEntries = [];
}

interface MutableExecutionLogs {
  logs: SessionLog[];
  ids: Map<string, number>;
  logicalKeys: Map<string, number>;
  fallbackCost: number;
}

function mutableExecutionLogs(
  bucket: ExecutionLogBucket | undefined
): MutableExecutionLogs {
  const logs = bucket?.logs ?? [];
  const mutable: MutableExecutionLogs = {
    logs: [...logs],
    ids: new Map(),
    logicalKeys: new Map(),
    fallbackCost: bucket?.fallbackCost ?? costFromSessionLogs(logs),
  };
  logs.forEach((log, index) => {
    if (log.id) mutable.ids.set(log.id, index);
    if (log.logical_key) mutable.logicalKeys.set(log.logical_key, index);
  });
  return mutable;
}

function removeIndex(
  map: Map<string, number>,
  key: string | null | undefined,
  index: number
) {
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
  mutable.fallbackCost -= costFromSessionLog(previous);
  mutable.fallbackCost += costFromSessionLog(log);
  mutable.logs[index] = log;
  if (log.id) mutable.ids.set(log.id, index);
  if (log.logical_key) mutable.logicalKeys.set(log.logical_key, index);
}

function appendExecutionLog(mutable: MutableExecutionLogs, log: SessionLog) {
  const index = mutable.logs.length;
  mutable.logs.push(log);
  mutable.fallbackCost += costFromSessionLog(log);
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
        state.logsByExecutionId[entry.executionId]
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
    const mutable = mutableByExecutionId.get(executionId)!;
    logsByExecutionId[executionId] = {
      logs: mutable.logs,
      fallbackCost: mutable.fallbackCost,
    };
  }
  return { logsByExecutionId };
}

export const useSessionLogStore = create<SessionLogStore>((set) => ({
  ...initialState,

  setLogs: (executionId, logs) =>
    set((state) => ({
      logsByExecutionId: {
        ...state.logsByExecutionId,
        [executionId]: {
          logs,
          fallbackCost: costFromSessionLogs(logs),
        },
      },
    })),

  appendLog: (executionId, log) =>
    queueLog({ executionId, log, operation: "append" }),

  upsertLog: (executionId, log) =>
    queueLog({ executionId, log, operation: "upsert" }),

  applyLogBatch: (entries) => set((state) => applyLogBatch(state, entries)),

  flushPending: flushPendingNow,

  clearLogs: (executionId) =>
    set((state) => {
      if (state.logsByExecutionId[executionId] === undefined) return state;
      const logsByExecutionId = { ...state.logsByExecutionId };
      delete logsByExecutionId[executionId];
      return { logsByExecutionId };
    }),

  reset: () => {
    discardPending();
    set(initialState);
  },
}));
