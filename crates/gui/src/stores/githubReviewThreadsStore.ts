import { useCallback, useEffect } from "react";
import { create } from "zustand";
import {
  commands,
  type GithubFailure,
  type GithubReviewThread,
  type WorktreePrReviewThreads,
} from "../bindings";
import { errorMessage } from "../query";
import { useNotificationStore } from "./notificationStore";
import { LINKED_PR_REVALIDATE_MS } from "./worktreePrStore";

/**
 * Review threads of a branch's linked PR, shared by every surface showing
 * that branch (the chat header chip and Changes). Read-only: GitHub is read
 * on mount, on an explicit refresh and every `LINKED_PR_REVALIDATE_MS`
 * while mounted; the backend answers in between from its own cache.
 */
export interface ReviewThreadsEntry {
  threads: Extract<WorktreePrReviewThreads, { status: "loaded" }> | null;
  loading: boolean;
  error: GithubFailure | null;
}

export const IDLE_REVIEW_THREADS: ReviewThreadsEntry = {
  threads: null,
  loading: false,
  error: null,
};

interface ReviewThreadsState {
  entries: Record<string, ReviewThreadsEntry>;
}

export const useGithubReviewThreadsStore = create<ReviewThreadsState>(() => ({
  entries: {},
}));

/** The PR is part of the key so relinking reads the new PR's threads. */
export function reviewThreadsKey(
  worktreePath: string,
  branch: string,
  prNumber: number
): string {
  return JSON.stringify([worktreePath, branch, prNumber]);
}

function patch(key: string, update: Partial<ReviewThreadsEntry>) {
  useGithubReviewThreadsStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: { ...(state.entries[key] ?? IDLE_REVIEW_THREADS), ...update },
    },
  }));
}

/**
 * Thread IDs already seen per key. The first read only records them; later
 * reads notify the Activity panel about threads not seen before.
 */
const seenThreads = new Map<string, Set<string>>();

function notifyNewThreads(
  key: string,
  threads: NonNullable<ReviewThreadsEntry["threads"]>
) {
  const seen = seenThreads.get(key);
  seenThreads.set(key, new Set(threads.threads.map((thread) => thread.id)));
  if (!seen) return;
  const fresh = threads.threads.filter((thread) => !seen.has(thread.id));
  if (fresh.length === 0) return;
  useNotificationStore.getState().addNotification({
    message: newThreadsMessage(threads.repo, threads.prNumber, fresh),
    type: "info",
    entity: "application",
    entityId: `${threads.repo}#${threads.prNumber}`,
  });
}

export function newThreadsMessage(
  repo: string,
  prNumber: number,
  fresh: GithubReviewThread[]
): string {
  const authors = [
    ...new Set(
      fresh.flatMap((thread) => thread.comments[0]?.author?.login ?? [])
    ),
  ];
  const from = authors.length > 0 ? ` from ${authors.join(", ")}` : "";
  if (fresh.length === 1) {
    const [thread] = fresh;
    const at = thread.line ? `${thread.path}:${thread.line}` : thread.path;
    return `New GitHub review thread on ${repo}#${prNumber}${from} at ${at}.`;
  }
  return `${fresh.length} new GitHub review threads on ${repo}#${prNumber}${from}.`;
}

/** Forget what was seen, for isolated tests. */
export function resetSeenReviewThreads(): void {
  seenThreads.clear();
}

/** Latest request per key: an older answer never overwrites a newer one. */
const requests = new Map<string, number>();

async function load(
  key: string,
  worktreePath: string,
  branch: string,
  refresh: boolean
): Promise<void> {
  const request = (requests.get(key) ?? 0) + 1;
  requests.set(key, request);
  patch(key, { loading: true });
  let threads: ReviewThreadsEntry["threads"] = null;
  let error: GithubFailure | null = null;
  try {
    const result = await commands.getWorktreePrReviewThreads(
      worktreePath,
      branch,
      refresh
    );
    if (result.status === "error") error = result.error;
    else if (result.data.status === "loaded") threads = result.data;
  } catch (cause) {
    error = {
      kind: "other",
      message: errorMessage(cause),
      retryAfterSecs: null,
    };
  }
  if (requests.get(key) !== request) return;
  if (threads) notifyNewThreads(key, threads);
  // A failed read keeps the threads already shown (marked by `error`).
  patch(
    key,
    error ? { loading: false, error } : { loading: false, error: null, threads }
  );
}

const holders = new Map<string, { count: number; timer: number }>();

function acquire(key: string, worktreePath: string, branch: string) {
  const held = holders.get(key);
  if (held) {
    held.count += 1;
  } else {
    void load(key, worktreePath, branch, false);
    holders.set(key, {
      count: 1,
      timer: window.setInterval(
        () => void load(key, worktreePath, branch, false),
        LINKED_PR_REVALIDATE_MS
      ),
    });
  }
  return () => {
    const current = holders.get(key);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    window.clearInterval(current.timer);
    holders.delete(key);
  };
}

/**
 * The review threads of `prNumber`, linked to `branch` of a worktree; idle
 * (no GitHub reads) while any argument is missing.
 */
export function useGithubReviewThreads(
  worktreePath: string | null | undefined,
  branch: string | null | undefined,
  prNumber: number | null | undefined
) {
  const key =
    worktreePath && branch && prNumber
      ? reviewThreadsKey(worktreePath, branch, prNumber)
      : null;
  const entry = useGithubReviewThreadsStore((state) =>
    key ? (state.entries[key] ?? IDLE_REVIEW_THREADS) : IDLE_REVIEW_THREADS
  );
  useEffect(
    () =>
      key && worktreePath && branch
        ? acquire(key, worktreePath, branch)
        : undefined,
    [key, worktreePath, branch]
  );
  const refresh = useCallback(() => {
    if (key && worktreePath && branch)
      void load(key, worktreePath, branch, true);
  }, [key, worktreePath, branch]);
  return { ...entry, refresh };
}

/** Unresolved threads, for counts on entry points. */
export function openThreadCount(entry: ReviewThreadsEntry): number {
  return (
    entry.threads?.threads.filter((thread) => !thread.resolved).length ?? 0
  );
}
