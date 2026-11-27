import { useCallback, useEffect, useMemo, useState } from "react";
import {
  checksFreshness,
  countChecks,
  viewChecks,
} from "../components/ChatWindow/workspace/prChecksView";
import {
  acceptNewerWorktreePr,
  acquireWorktreePr,
  branchLinkOf,
  cancelWorktreePrCheck,
  dismissNewerWorktreePr,
  linkWorktreePr,
  listWorktreeOpenPrs,
  refreshWorktreePr,
  rerunWorktreePrCheck,
  unlinkWorktreePr,
} from "../stores/prSync";
import {
  IDLE_PR_ENTRY,
  associationView,
  isPrBusy,
  openThreadCount,
  useWorktreePrStore,
  worktreePrKey,
  type WorktreePrEntry,
} from "../stores/worktreePrStore";

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
 * A chat worktree branch's PR: what the bar shows, the linked PR's checks,
 * and what the user can do. Every consumer of a branch reads its one store
 * entry, so counts agree across surfaces. Shown while mounted.
 */
export function useWorktreePr(
  worktreePath: string | null | undefined,
  branch: string | null | undefined
) {
  const key =
    worktreePath && branch ? worktreePrKey(worktreePath, branch) : null;
  // Until the sync writes the entry, the chats' saved link shows at once.
  const initial = useMemo<WorktreePrEntry>(
    () =>
      worktreePath && branch
        ? { ...IDLE_PR_ENTRY, link: branchLinkOf(worktreePath, branch) }
        : IDLE_PR_ENTRY,
    [worktreePath, branch]
  );
  const entry =
    useWorktreePrStore((state) => (key ? state.entries[key] : undefined)) ??
    initial;

  useEffect(
    () =>
      worktreePath && branch
        ? acquireWorktreePr(worktreePath, branch)
        : undefined,
    [worktreePath, branch]
  );

  const association = useMemo(
    () => (key ? associationView(entry) : null),
    [key, entry]
  );
  const checks = useMemo(() => viewChecks(entry), [entry]);
  const counts = useMemo(() => countChecks(checks), [checks]);

  const at = useCallback(
    <T>(run: (path: string, name: string) => T, otherwise: T) =>
      worktreePath && branch ? run(worktreePath, branch) : otherwise,
    [worktreePath, branch]
  );
  const actions = useMemo(
    () => ({
      refresh: () => at(refreshWorktreePr, Promise.resolve(false)),
      linkPr: (prNumber: number, repo: string | null) =>
        at(
          (path, name) => linkWorktreePr(path, name, prNumber, repo),
          Promise.resolve(false)
        ),
      unlinkPr: () => at(unlinkWorktreePr, Promise.resolve(false)),
      acceptNewer: () => at(acceptNewerWorktreePr, Promise.resolve(false)),
      dismissNewer: () => at(dismissNewerWorktreePr, undefined),
      listOpenPrs: () => at(listWorktreeOpenPrs, Promise.resolve([])),
      rerun: (checkId: string) =>
        at(
          (path, name) => rerunWorktreePrCheck(path, name, checkId),
          Promise.resolve()
        ),
      cancel: (checkId: string) =>
        at(
          (path, name) => cancelWorktreePrCheck(path, name, checkId),
          Promise.resolve()
        ),
    }),
    [at]
  );

  return {
    entry,
    association,
    checks,
    counts,
    reviewThreads: entry.reviewThreads,
    openThreads: openThreadCount(entry.reviewThreads),
    busy: isPrBusy(entry),
    ...actions,
  };
}

export type WorktreePr = ReturnType<typeof useWorktreePr>;

/**
 * Freshness on a clock that ticks fast only while a countdown is shown, and
 * not at all while nothing on screen is relative to now.
 */
export function useChecksFreshness(entry: WorktreePrEntry) {
  const counting =
    entry.read.status === "failed" && entry.read.retryAt !== null;
  const now = useNow(
    counting ? 1_000 : entry.fetchedAt === null ? null : 15_000
  );
  return { now, freshness: checksFreshness(entry, now) };
}
