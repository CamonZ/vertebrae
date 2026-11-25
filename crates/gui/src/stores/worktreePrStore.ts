import { create } from "zustand";
import type {
  GithubFailure,
  GithubPrChecks,
  GithubPrReviewThreads,
  GithubPullRequest,
  Result,
  WorktreeGithub,
} from "../bindings";
import { errorMessage } from "../query";
import type { BranchLink, LinkedPr } from "./prLinks";

/**
 * The one owner of each chat worktree branch's PR state, keyed by
 * `worktreePrKey`: the branch's newest link, where it lives on GitHub, its
 * open PRs, and the linked PR's checks. Written only by the PR sync
 * (`prSync`). The link itself is saved on the chats' association records
 * (`prLinks`); the entry carries the newest one so readers need only this
 * store. Not persisted; cleared with the project-scoped stores.
 */

/**
 * Checks older than this, with no read pending, are shown as stale: two
 * idle poll ticks (`PR_POLL_IDLE_MS`).
 */
export const CHECKS_STALE_AFTER_MS = 10 * 60_000;
/** An accepted re-run or cancel GitHub has not shown yet stops overriding. */
export const WRITE_PENDING_MAX_MS = 3 * 60_000;

/**
 * The last read of the branch: of its linked PR, or of its open PRs while
 * nothing is linked. Resolving the worktree failing is a failed read with no
 * `github`.
 */
export type PrRead =
  | { status: "idle" }
  | { status: "refreshing" }
  | {
      status: "failed";
      failure: GithubFailure;
      /** `null` when nothing retries on its own (only the user can fix it). */
      retryAt: number | null;
      attempt: number;
    };

/**
 * A re-run (keyed by check id) or cancel (keyed by workflow run) request.
 * `requested` means GitHub accepted it; the view overrides the checks until
 * GitHub reports the result.
 */
export type PrWriteState =
  | { status: "requesting" }
  | { status: "requested"; at: number }
  | { status: "failed"; message: string };

/** The open PRs of the branch in one repository. */
export interface RepoOpenPrs {
  prs: GithubPullRequest[];
  /** Every open PR of the branch is listed. */
  complete: boolean;
}

/**
 * The linked PR's review threads. Read with the PR: when the branch comes on
 * screen, after every fresh read of the PR while it is shown, and (forced
 * past the backend's short cache) on refresh.
 */
export interface PrReviewThreadsState {
  /** Last read; kept while a later read is out or failed. */
  data: GithubPrReviewThreads | null;
  loading: boolean;
  error: GithubFailure | null;
}

const IDLE_REVIEW_THREADS: PrReviewThreadsState = {
  data: null,
  loading: false,
  error: null,
};

/** Unresolved threads, for counts on entry points. */
export function openThreadCount(threads: PrReviewThreadsState): number {
  return threads.data?.threads.filter((thread) => !thread.resolved).length ?? 0;
}

/** The linked PR's checks and threads, reset whenever the link changes. */
export interface PrChecksState {
  snapshot: GithubPrChecks | null;
  fetchedAt: number | null;
  reruns: Readonly<Record<string, PrWriteState>>;
  cancels: Readonly<Record<string, PrWriteState>>;
  /** A pushed commit GitHub has not reported as the PR head yet. */
  awaitingHead: string | null;
  /** Reads spent waiting for `awaitingHead`. */
  awaitingPolls: number;
  reviewThreads: PrReviewThreadsState;
}

export interface WorktreePrEntry extends PrChecksState {
  /** The newest link among the branch's chats. */
  link: BranchLink;
  /** Where the branch lives on GitHub; `null` until resolved. */
  github: WorktreeGithub | null;
  read: PrRead;
  /** A link, unlink or accept is being written. */
  linking: boolean;
  /** The user's last link, unlink or accept failed. */
  error: GithubFailure | null;
  /** Open PRs of the branch by `owner/name`, as last listed. */
  openPrs: Readonly<Record<string, RepoOpenPrs>>;
  /** A newer PR for the branch after the linked one was merged. */
  newer: GithubPullRequest | null;
  /** The newer PR the user chose not to link. */
  dismissedNewer: number | null;
}

export const IDLE_CHECKS: PrChecksState = {
  snapshot: null,
  fetchedAt: null,
  reruns: {},
  cancels: {},
  awaitingHead: null,
  awaitingPolls: 0,
  reviewThreads: IDLE_REVIEW_THREADS,
};

export const IDLE_PR_ENTRY: WorktreePrEntry = {
  ...IDLE_CHECKS,
  link: undefined,
  github: null,
  read: { status: "idle" },
  linking: false,
  error: null,
  openPrs: {},
  newer: null,
  dismissedNewer: null,
};

/** What the PR bar shows for a branch. */
export type WorktreePrAssociation =
  | {
      status: "linked";
      branch: string;
      repo: string;
      pr: LinkedPr;
      /** The worktree is not on this machine: shown as last saved, not read. */
      readOnly: boolean;
    }
  | { status: "none"; branch: string; repo: string; createPrUrl: string }
  | {
      status: "ambiguous";
      branch: string;
      repo: string;
      candidates: GithubPullRequest[];
    }
  | { status: "gh_missing" }
  | { status: "auth_expired"; reason: string }
  | { status: "unavailable"; error: GithubFailure }
  | { status: "not_applicable"; branch: string | null; reason: string };

export function isPrBusy(entry: Pick<WorktreePrEntry, "read" | "linking">) {
  return entry.read.status === "refreshing" || entry.linking;
}

export function linkedPullRequest(
  association: WorktreePrAssociation | null
): LinkedPr | null {
  return association?.status === "linked" ? association.pr : null;
}

export function needsUserFix(failure: GithubFailure): boolean {
  return failure.kind === "gh_missing" || failure.kind === "auth_expired";
}

export const isPendingStatus = (status: string) =>
  status === "running" || status === "queued";

/** The repository and open PRs the branch's candidates come from, if read. */
export function branchCandidates(
  entry: WorktreePrEntry
): { repo: string; open: RepoOpenPrs } | null | undefined {
  const github = entry.github;
  if (github?.status !== "github") return undefined;
  for (const repo of github.searchRepos) {
    const open = entry.openPrs[repo];
    if (!open) return undefined;
    if (open.prs.length > 0 || !open.complete) return { repo, open };
  }
  return null;
}

/** The PR's head is the branch in the repository it is pushed to. */
export function isOwnHead(github: WorktreeGithub, pr: GithubPullRequest) {
  return (
    github.status === "github" &&
    pr.headRepo !== null &&
    pr.headRepo.toLowerCase() === github.headRepo.toLowerCase()
  );
}

/** The branch's only open PR, if its head is the branch's own and the list is complete. */
export function onlyOwnPr(entry: WorktreePrEntry): GithubPullRequest | null {
  const found = branchCandidates(entry);
  if (!found || !entry.github) return null;
  const { prs, complete } = found.open;
  return complete && prs.length === 1 && isOwnHead(entry.github, prs[0])
    ? prs[0]
    : null;
}

function failureView(failure: GithubFailure): WorktreePrAssociation {
  if (failure.kind === "gh_missing") return { status: "gh_missing" };
  if (failure.kind === "auth_expired")
    return { status: "auth_expired", reason: failure.message };
  return { status: "unavailable", error: failure };
}

/**
 * The bar's state from the branch's link and what GitHub last said. `null`
 * while the first read is still out.
 */
export function associationView(
  entry: WorktreePrEntry
): WorktreePrAssociation | null {
  const { github, link, read } = entry;
  if (link?.pr)
    return {
      status: "linked",
      branch: link.branch,
      repo: `${link.pr.owner}/${link.pr.repo}`,
      pr: link.pr,
      readOnly: github?.status === "not_applicable",
    };
  const failure = read.status === "failed" ? read.failure : null;
  if (!github) return failure ? failureView(failure) : null;
  if (github.status === "not_applicable")
    return {
      status: "not_applicable",
      branch: github.branch,
      reason: github.reason,
    };
  const { branch, baseRepo, createPrUrl } = github;
  const none: WorktreePrAssociation = {
    status: "none",
    branch,
    repo: baseRepo,
    createPrUrl,
  };
  if (link) return none;
  const found = branchCandidates(entry);
  if (found)
    return {
      status: "ambiguous",
      branch,
      repo: found.repo,
      candidates: found.open.prs,
    };
  if (found === null) return none;
  return failure ? failureView(failure) : null;
}

/**
 * Drops overrides GitHub has caught up with: a re-run whose failed attempt
 * was replaced or no longer failed, a cancel whose run has no pending job
 * left, or a request too old to trust.
 */
export function reconcileWrites(
  entry: Pick<PrChecksState, "reruns" | "cancels">,
  snapshot: GithubPrChecks,
  now: number
): Pick<PrChecksState, "reruns" | "cancels"> {
  const failedIds = new Set(
    snapshot.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id)
  );
  const pendingRuns = new Set(
    snapshot.checks
      .filter((check) => isPendingStatus(check.status) && check.actionsRun)
      .map((check) => check.actionsRun as string)
  );
  const keep = (
    writes: Readonly<Record<string, PrWriteState>>,
    live: Set<string>
  ) => {
    const kept: Record<string, PrWriteState> = {};
    for (const [id, state] of Object.entries(writes)) {
      if (state.status === "requesting") kept[id] = state;
      else if (!live.has(id)) continue;
      else if (state.status === "failed") kept[id] = state;
      else if (now - state.at < WRITE_PENDING_MAX_MS) kept[id] = state;
    }
    return kept;
  };
  return {
    reruns: keep(entry.reruns, failedIds),
    cancels: keep(entry.cancels, pendingRuns),
  };
}

export type GithubOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; failure: GithubFailure };

/** A GitHub command's answer; a rejected IPC call reads as an `other` failure. */
export async function settleGithubCommand<T>(
  command: () => Promise<Result<T, GithubFailure>>
): Promise<GithubOutcome<T>> {
  try {
    const result = await command();
    return result.status === "ok"
      ? { ok: true, data: result.data }
      : { ok: false, failure: result.error };
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "other",
        message: errorMessage(error),
        retryAfterSecs: null,
      },
    };
  }
}

export class GithubCommandError extends Error {
  readonly failure: GithubFailure;

  constructor(failure: GithubFailure) {
    super(failure.message);
    this.name = "GithubCommandError";
    this.failure = failure;
  }
}

export function githubFailureOf(error: unknown): GithubFailure {
  return error instanceof GithubCommandError
    ? error.failure
    : { kind: "other", message: errorMessage(error), retryAfterSecs: null };
}

export function worktreePrKey(worktreePath: string, branch: string): string {
  return JSON.stringify([worktreePath, branch]);
}

interface WorktreePrStoreState {
  entries: Record<string, WorktreePrEntry>;
  /** Bumped by `reset`; async work started before it writes nothing. */
  scope: number;
  reset: () => void;
}

export const useWorktreePrStore = create<WorktreePrStoreState>((set) => ({
  entries: {},
  scope: 0,
  reset: () => set((state) => ({ entries: {}, scope: state.scope + 1 })),
}));

export function prEntryOf(key: string): WorktreePrEntry {
  return useWorktreePrStore.getState().entries[key] ?? IDLE_PR_ENTRY;
}
