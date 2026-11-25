import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IDLE_CHECKS_ENTRY,
  acquireWorktreePrChecks,
  cancelWorktreePrCheck,
  refreshWorktreePrChecks,
  rerunWorktreePrCheck,
  useWorktreePrChecksStore,
} from "../stores/worktreePrChecksStore";
import { worktreePrKey } from "../stores/worktreePrStore";
import {
  checksFreshness,
  countChecks,
  viewChecks,
} from "../components/ChatWindow/workspace/prChecksView";

/** Wall clock for relative times; re-renders every `intervalMs` while set. */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (intervalMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The checks of the branch's linked PR. Every consumer of the same branch
 * reads one store entry, so counts agree across surfaces.
 */
export function useWorktreePrChecks(
  worktreePath: string | null | undefined,
  branch: string | null | undefined
) {
  const key =
    worktreePath && branch ? worktreePrKey(worktreePath, branch) : null;
  const entry = useWorktreePrChecksStore((state) =>
    key ? (state.entries[key] ?? IDLE_CHECKS_ENTRY) : IDLE_CHECKS_ENTRY
  );

  useEffect(
    () =>
      worktreePath && branch
        ? acquireWorktreePrChecks(worktreePath, branch)
        : undefined,
    [worktreePath, branch]
  );

  const checks = useMemo(() => viewChecks(entry), [entry]);
  const counts = useMemo(() => countChecks(checks), [checks]);

  const refresh = useCallback(
    () =>
      worktreePath && branch
        ? refreshWorktreePrChecks(worktreePath, branch)
        : Promise.resolve(),
    [worktreePath, branch]
  );
  const rerun = useCallback(
    (checkId: string) =>
      worktreePath && branch
        ? rerunWorktreePrCheck(worktreePath, branch, checkId)
        : Promise.resolve(),
    [worktreePath, branch]
  );

  const cancel = useCallback(
    (checkId: string) =>
      worktreePath && branch
        ? cancelWorktreePrCheck(worktreePath, branch, checkId)
        : Promise.resolve(),
    [worktreePath, branch]
  );

  return { entry, checks, counts, refresh, rerun, cancel };
}

/** Freshness on a clock that ticks fast only while a countdown is shown. */
export function useChecksFreshness(
  entry: ReturnType<typeof useWorktreePrChecks>["entry"]
) {
  const counting =
    entry.refresh.status === "failed" && entry.refresh.retryAt !== null;
  const now = useNow(counting ? 1_000 : 15_000);
  return { now, freshness: checksFreshness(entry, now) };
}
