import { create } from "zustand";
import type {
  GithubFailure,
  GithubPullRequest,
  Result,
  WorktreeGithub,
} from "../bindings";
import { errorMessage } from "../query";
import type { BranchLink, LinkedPr } from "./prLinks";
import { IDLE_CHECKS_ENTRY, type PrChecksEntry } from "./worktreePrChecksStore";

/**
 * What GitHub last said about each chat worktree branch, keyed by
 * `worktreePrKey`: where its PRs live, its open PRs, and the linked PR with
 * its checks. Written only by the PR sync (`prSync`); the link itself lives
 * on the chats' association records (`prLinks`). Not persisted.
 */

export type WorktreePrPhase = "idle" | "ready" | "refreshing" | "mutating";

/** The open PRs of the branch in one repository. */
export interface RepoOpenPrs {
  prs: GithubPullRequest[];
  /** Every open PR of the branch is listed. */
  complete: boolean;
}

export interface WorktreePrEntry extends PrChecksEntry {
  phase: WorktreePrPhase;
  /** Where the branch lives on GitHub; `null` until resolved. */
  github: WorktreeGithub | null;
  /** Resolving the worktree failed. */
  lookupFailure: GithubFailure | null;
  /** Open PRs of the branch by `owner/name`, as last listed. */
  openPrs: Readonly<Record<string, RepoOpenPrs>>;
  /** The last listing of the branch's open PRs failed. */
  openFailure: GithubFailure | null;
  /** The user's last link, unlink or refresh failed. */
  error: GithubFailure | null;
  /** A newer PR for the branch after the linked one was merged. */
  newer: GithubPullRequest | null;
  /** The newer PR the user chose not to link. */
  dismissedNewer: number | null;
}

export const IDLE_PR_ENTRY: WorktreePrEntry = {
  ...IDLE_CHECKS_ENTRY,
  phase: "idle",
  github: null,
  lookupFailure: null,
  openPrs: {},
  openFailure: null,
  error: null,
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
  | { status: "gh_missing"; branch: string; repo: string }
  | { status: "auth_expired"; branch: string; repo: string; reason: string }
  | {
      status: "unavailable";
      branch: string;
      repo: string;
      error: GithubFailure;
    }
  | { status: "not_applicable"; branch: string | null; reason: string };

export function isPrBusy(phase: WorktreePrPhase): boolean {
  return phase === "refreshing" || phase === "mutating";
}

export function linkedPullRequest(
  association: WorktreePrAssociation | null
): LinkedPr | null {
  return association?.status === "linked" ? association.pr : null;
}

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

function failureView(
  branch: string,
  repo: string,
  failure: GithubFailure
): WorktreePrAssociation {
  if (failure.kind === "gh_missing")
    return { status: "gh_missing", branch, repo };
  if (failure.kind === "auth_expired")
    return { status: "auth_expired", branch, repo, reason: failure.message };
  return { status: "unavailable", branch, repo, error: failure };
}

/**
 * The bar's state from the branch's link and what GitHub last said. `null`
 * while the first read is still out.
 */
export function associationView(
  entry: WorktreePrEntry,
  link: BranchLink
): WorktreePrAssociation | null {
  const github = entry.github;
  if (link?.pr) {
    const fresh = entry.pr;
    const pr =
      fresh && fresh.number === link.pr.number
        ? { ...link.pr, title: fresh.title, state: fresh.state, url: fresh.url }
        : link.pr;
    return {
      status: "linked",
      branch: link.branch,
      repo: `${link.pr.owner}/${link.pr.repo}`,
      pr,
      readOnly: github?.status === "not_applicable",
    };
  }
  if (!github) return null;
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
  return entry.openFailure
    ? failureView(branch, github.headRepo, entry.openFailure)
    : null;
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
}

export const useWorktreePrStore = create<WorktreePrStoreState>(() => ({
  entries: {},
}));

export function prEntryOf(key: string): WorktreePrEntry {
  return useWorktreePrStore.getState().entries[key] ?? IDLE_PR_ENTRY;
}
