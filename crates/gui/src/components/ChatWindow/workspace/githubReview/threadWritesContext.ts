import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { GithubPrReviewThreads } from "../../../../bindings";
import {
  rereadWorktreeReviewThreads,
  writeWorktreeReviewThread,
} from "../../../../stores/prSync";
import { prEntryOf, worktreePrKey } from "../../../../stores/worktreePrStore";
import type { LinkedPr } from "../../../../stores/prLinks";
import {
  EMPTY_SLOT,
  ThreadWrites,
  type WritePort,
  type WriteSlot,
} from "./threadWrites";

/** Where the chat's public writes go: its linked PR, whose threads are read. */
export interface GithubWritesValue {
  store: ThreadWrites;
  /**
   * The PR's identity (`owner/repo#number`): what its comment and selection
   * slots, and its writes' failures, are scoped to.
   */
  scope: string;
  /** The branch's worktree, which has the PR's commits. */
  worktreePath: string;
  pr: { number: number; url: string };
  /** The signed-in GitHub user posts appear as; null when unknown. */
  viewer: string | null;
  threads: GithubPrReviewThreads;
  /** Writes to this PR; `started` hears of a thread a comment started. */
  port(started?: WritePort["started"]): WritePort;
}

export const GithubWritesContext = createContext<GithubWritesValue | null>(
  null
);

export const useGithubWrites = () => useContext(GithubWritesContext);

/**
 * The chat's slots, kept until its key changes (as its discussions are).
 * Slots for different PRs live side by side, apart by their keys.
 */
export function useThreadWritesStore(key: string): ThreadWrites {
  const [owned, setOwned] = useState(() => ({
    key,
    store: new ThreadWrites(),
  }));
  if (owned.key === key) return owned.store;
  const store = new ThreadWrites();
  setOwned({ key, store });
  return store;
}

export function useWriteSlot(
  store: ThreadWrites | undefined,
  key: string
): WriteSlot {
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    () => store?.slot(key) ?? EMPTY_SLOT
  );
}

const noSubscription = () => () => {};

/**
 * The value for a branch's linked PR once its threads are read; null with
 * nothing to post to.
 */
export function useGithubWritesValue(
  store: ThreadWrites,
  worktreePath: string | null,
  branch: string | null,
  pr: LinkedPr | null,
  threads: GithubPrReviewThreads | null
): GithubWritesValue | null {
  return useMemo(() => {
    if (!worktreePath || !branch || !pr || threads?.prNumber !== pr.number)
      return null;
    const number = pr.number;
    const key = worktreePrKey(worktreePath, branch);
    const scope = `${threads.repo}#${number}`;
    return {
      store,
      scope,
      worktreePath,
      pr: { number, url: pr.url },
      viewer: threads.viewerLogin,
      threads,
      port: (started) => ({
        scope,
        shown: () => {
          const data = prEntryOf(key).reviewThreads.data;
          return data && `${data.repo}#${data.prNumber}` === scope
            ? data
            : null;
        },
        send: (write) =>
          writeWorktreeReviewThread(worktreePath, branch, number, write),
        reread: () => rereadWorktreeReviewThreads(worktreePath, branch, number),
        started,
      }),
    };
  }, [store, worktreePath, branch, pr, threads]);
}
