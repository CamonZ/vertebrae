import type { SessionLog } from "../bindings";

function sessionLogKeys(log: SessionLog): string[] {
  const keys: string[] = [];
  if (log.id) keys.push(`id:${log.id}`);
  if (log.logical_key) keys.push(`logical:${log.logical_key}`);
  return keys;
}

function sessionLogMap(logs: readonly SessionLog[] | undefined) {
  const byKey = new Map<string, SessionLog>();
  for (const log of logs ?? []) {
    for (const key of sessionLogKeys(log)) {
      byKey.set(key, log);
    }
  }
  return byKey;
}

function firstMatchingSessionLog(
  byKey: ReadonlyMap<string, SessionLog>,
  log: SessionLog
): SessionLog | undefined {
  for (const key of sessionLogKeys(log)) {
    const match = byKey.get(key);
    if (match) return match;
  }
  return undefined;
}

function hasFetchedSessionLogKey(
  fetchedKeys: ReadonlySet<string>,
  log: SessionLog
): boolean {
  return sessionLogKeys(log).some((key) => fetchedKeys.has(key));
}

/** Merge history with live changes without treating a partial snapshot as deletion. */
export function mergeFetchedSessionLogs(
  fetchedLogs: readonly SessionLog[],
  currentLogs: readonly SessionLog[] | undefined,
  logsAtFetchStart: readonly SessionLog[] | undefined,
  preserveConcurrentRow: (log: SessionLog) => boolean = () => true
): SessionLog[] {
  const currentByKey = sessionLogMap(currentLogs);
  const atFetchStartByKey = sessionLogMap(logsAtFetchStart);
  const fetchedKeys = new Set<string>();

  const merged = fetchedLogs.map((log) => {
    const keys = sessionLogKeys(log);
    if (keys.length === 0) return log;

    for (const key of keys) fetchedKeys.add(key);
    const current = firstMatchingSessionLog(currentByKey, log);
    const atFetchStart = firstMatchingSessionLog(atFetchStartByKey, log);
    return current && current !== atFetchStart && preserveConcurrentRow(current)
      ? current
      : log;
  });

  for (const log of currentLogs ?? []) {
    const keys = sessionLogKeys(log);
    if (keys.length === 0) {
      if (!(logsAtFetchStart ?? []).includes(log)) merged.push(log);
      continue;
    }
    if (hasFetchedSessionLogKey(fetchedKeys, log)) continue;
    merged.push(log);
  }

  return merged;
}
