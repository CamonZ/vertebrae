/**
 * The linked PR's review threads for each chat worktree branch: one read
 * out at a time per PR and store scope, its answer kept on the branch's
 * entry in `useWorktreePrStore`. `prSync` decides when a branch is read.
 */
import { commands } from "../bindings";
import { isSameLinkedPr, type BranchLink, type LinkedPr } from "./prLinks";
import { noticeNewThreads } from "./reviewThreadNotices";
import {
  prScope,
  settleGithubCommand,
  updatePrEntry,
  type WorktreePrEntry,
} from "./worktreePrStore";

/** The branch whose linked PR's threads are read. */
export interface ThreadsBranch {
  key: string;
  worktreePath: string;
  branch: string;
  link: BranchLink;
}

/** The review-thread read out per branch; one at a time per PR and scope. */
const threadReads = new Map<
  string,
  { target: string; at: number; forced: boolean; read: Promise<void> }
>();

const threadsTarget = (key: string, pr: LinkedPr) =>
  JSON.stringify([key, pr.host, `${pr.owner}/${pr.repo}`, pr.number]);

/**
 * Reads the linked PR's review threads. A read already out for the same PR
 * is shared, unless this one must get past the backend's cache (`refresh`)
 * and that one would not. An answer lands only on the PR it was asked for,
 * in the scope it was asked in.
 */
export function readThreads(
  state: ThreadsBranch,
  refresh: boolean
): Promise<void> {
  const pr = state.link?.pr;
  if (!pr) return Promise.resolve();
  const { key } = state;
  const target = threadsTarget(key, pr);
  const at = prScope();
  const out = threadReads.get(key);
  if (out && out.target === target && out.at === at && (out.forced || !refresh))
    return out.read;
  const onPr = (next: (entry: WorktreePrEntry) => WorktreePrEntry) =>
    updatePrEntry(
      key,
      (entry) => (isSameLinkedPr(entry.link?.pr, pr) ? next(entry) : entry),
      at
    );
  onPr((entry) => ({
    ...entry,
    reviewThreads: { ...entry.reviewThreads, loading: true },
  }));
  const pending = { target, at, forced: refresh } as {
    target: string;
    at: number;
    forced: boolean;
    read: Promise<void>;
  };
  pending.read = (async () => {
    const outcome = await settleGithubCommand(() =>
      commands.getGithubPrReviewThreads(
        state.worktreePath,
        state.branch,
        `${pr.owner}/${pr.repo}`,
        pr.number,
        refresh
      )
    );
    // A later read for the branch answers instead.
    if (threadReads.get(key) !== pending || prScope() !== at) return;
    if (outcome.ok) noticeNewThreads(target, outcome.data);
    onPr((entry) => ({
      ...entry,
      reviewThreads: outcome.ok
        ? { data: outcome.data, loading: false, error: null }
        : // A failed read keeps the threads already shown.
          { ...entry.reviewThreads, loading: false, error: outcome.failure },
    }));
  })().finally(() => {
    if (threadReads.get(key) === pending) threadReads.delete(key);
  });
  threadReads.set(key, pending);
  return pending.read;
}

/** A read already out for the branch answers no one. */
export function forgetThreadRead(key: string) {
  threadReads.delete(key);
}

export function resetThreadReads() {
  threadReads.clear();
}
