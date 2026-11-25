import { create } from "zustand";
import {
  commands,
  type GithubFailure,
  type GithubPullRequest,
  type Result,
  type WorktreePrAssociation,
} from "../bindings";
import { errorMessage } from "../query";

/**
 * How often a mounted, linked PR is re-read in the background. The backend
 * answers from its own cache until its linked-PR TTL lapses, so this bounds
 * GitHub traffic to roughly one query per interval per mounted worktree.
 */
export const LINKED_PR_REVALIDATE_MS = 30_000;

export type WorktreePrPhase =
  | "idle"
  | "discovering"
  | "ready"
  | "revalidating"
  | "refreshing"
  | "mutating";

export interface WorktreePrEntry {
  phase: WorktreePrPhase;
  association: WorktreePrAssociation | null;
  lookupFailure: GithubFailure | null;
  error: GithubFailure | null;
  /**
   * Branch whose state the user confirmed by an explicit refresh or a
   * link/unlink. A background read for this branch may update the PR's data
   * but cannot switch it to a different association status.
   */
  confirmedBranch: string | null;
}

export const IDLE_PR_ENTRY: WorktreePrEntry = {
  phase: "idle",
  association: null,
  lookupFailure: null,
  error: null,
  confirmedBranch: null,
};

export function isPrBusy(phase: WorktreePrPhase): boolean {
  return phase === "refreshing" || phase === "mutating";
}

export function linkedPullRequest(
  association: WorktreePrAssociation | null
): GithubPullRequest | null {
  return association?.status === "linked" ? association.pr : null;
}

type Outcome<T> = { ok: true; data: T } | { ok: false; failure: GithubFailure };

async function settle<T>(
  command: () => Promise<Result<T, GithubFailure>>
): Promise<Outcome<T>> {
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

async function unwrapPr<T>(
  command: () => Promise<Result<T, GithubFailure>>
): Promise<T> {
  const outcome = await settle(command);
  if (outcome.ok) return outcome.data;
  throw new GithubCommandError(outcome.failure);
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

/** States that only the user can fix; background reads must not poll them. */
function needsUserFix(association: WorktreePrAssociation | null): boolean {
  return (
    association?.status === "gh_missing" ||
    association?.status === "auth_expired"
  );
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

let requestCounter = 0;
const latestRequest = new Map<string, number>();
const backgroundRead = new Map<string, Promise<void>>();
const consumers = new Map<string, number>();
const revalidateTimers = new Map<string, ReturnType<typeof setInterval>>();

function entryOf(key: string): WorktreePrEntry | undefined {
  return useWorktreePrStore.getState().entries[key];
}

function update(
  key: string,
  next: (entry: WorktreePrEntry) => WorktreePrEntry
) {
  useWorktreePrStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: next(state.entries[key] ?? IDLE_PR_ENTRY),
    },
  }));
}

function beginRequest(key: string): number {
  requestCounter += 1;
  latestRequest.set(key, requestCounter);
  return requestCounter;
}

function isCurrent(key: string, request: number): boolean {
  return latestRequest.get(key) === request;
}

function acceptBackground(
  entry: WorktreePrEntry,
  association: WorktreePrAssociation
): WorktreePrEntry {
  const sameBranch =
    entry.confirmedBranch !== null &&
    association.branch === entry.confirmedBranch;
  if (
    sameBranch &&
    entry.association &&
    entry.association.status !== association.status
  ) {
    return { ...entry, phase: "ready" };
  }
  return {
    ...entry,
    phase: "ready",
    association,
    lookupFailure: null,
    confirmedBranch: sameBranch ? entry.confirmedBranch : null,
  };
}

function readInBackground(
  worktreePath: string,
  branch: string,
  phase: "discovering" | "revalidating"
): Promise<void> {
  const key = worktreePrKey(worktreePath, branch);
  const pending = backgroundRead.get(key);
  if (pending) return pending;

  const request = beginRequest(key);
  update(key, (entry) => ({ ...entry, phase }));
  const read = (async () => {
    const outcome = await settle(() =>
      commands.getWorktreePrAssociation(worktreePath, branch, false)
    );
    if (!isCurrent(key, request)) return;
    update(key, (entry) => {
      if (outcome.ok) return acceptBackground(entry, outcome.data);
      return {
        ...entry,
        phase: "ready",
        lookupFailure: entry.association ? null : outcome.failure,
      };
    });
  })();
  const shared = read.finally(() => {
    if (backgroundRead.get(key) === shared) backgroundRead.delete(key);
  });
  backgroundRead.set(key, shared);
  return shared;
}

export function revalidateWorktreePr(
  worktreePath: string,
  branch: string
): Promise<void> {
  const entry = entryOf(worktreePrKey(worktreePath, branch));
  if (!entry || entry.phase !== "ready" || needsUserFix(entry.association))
    return Promise.resolve();
  return readInBackground(worktreePath, branch, "revalidating");
}

async function runExplicit(
  key: string,
  phase: "refreshing" | "mutating",
  command: () => Promise<Result<WorktreePrAssociation, GithubFailure>>
): Promise<boolean> {
  const entry = entryOf(key);
  if (!entry || isPrBusy(entry.phase)) return false;

  const request = beginRequest(key);
  // A superseded background read can no longer write; stop sharing it.
  backgroundRead.delete(key);
  update(key, (current) => ({ ...current, phase, error: null }));
  const outcome = await settle(command);
  if (!isCurrent(key, request)) return false;
  if (outcome.ok) {
    const association = outcome.data;
    update(key, () => ({
      phase: "ready",
      association,
      lookupFailure: null,
      error: null,
      confirmedBranch: association.branch,
    }));
    return true;
  }
  update(key, (current) => ({
    ...current,
    phase: "ready",
    error: outcome.failure,
  }));
  return false;
}

export function refreshWorktreePr(
  worktreePath: string,
  branch: string
): Promise<boolean> {
  return runExplicit(worktreePrKey(worktreePath, branch), "refreshing", () =>
    commands.getWorktreePrAssociation(worktreePath, branch, true)
  );
}

export function linkWorktreePr(
  worktreePath: string,
  branch: string,
  prNumber: number,
  repo: string | null
): Promise<boolean> {
  return runExplicit(worktreePrKey(worktreePath, branch), "mutating", () =>
    commands.linkWorktreePr(worktreePath, branch, prNumber, repo)
  );
}

export function unlinkWorktreePr(
  worktreePath: string,
  branch: string
): Promise<boolean> {
  return runExplicit(worktreePrKey(worktreePath, branch), "mutating", () =>
    commands.unlinkWorktreePr(worktreePath, branch)
  );
}

export function listWorktreeOpenPrs(
  worktreePath: string,
  branch: string
): Promise<GithubPullRequest[]> {
  return unwrapPr(() => commands.listWorktreeOpenPrs(worktreePath, branch));
}

function evict(key: string) {
  consumers.delete(key);
  latestRequest.delete(key);
  backgroundRead.delete(key);
  const timer = revalidateTimers.get(key);
  if (timer !== undefined) clearInterval(timer);
  revalidateTimers.delete(key);
  useWorktreePrStore.setState((state) => {
    if (!(key in state.entries)) return state;
    const entries = { ...state.entries };
    delete entries[key];
    return { entries };
  });
}

/** Defer eviction one microtask so a Strict Mode remount can reuse discovery. */
export function acquireWorktreePr(
  worktreePath: string,
  branch: string
): () => void {
  const key = worktreePrKey(worktreePath, branch);
  consumers.set(key, (consumers.get(key) ?? 0) + 1);
  if (!revalidateTimers.has(key)) {
    revalidateTimers.set(
      key,
      setInterval(() => {
        if (entryOf(key)?.association?.status === "linked")
          void revalidateWorktreePr(worktreePath, branch);
      }, LINKED_PR_REVALIDATE_MS)
    );
  }
  if ((entryOf(key)?.phase ?? "idle") === "idle")
    void readInBackground(worktreePath, branch, "discovering");

  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers.set(key, (consumers.get(key) ?? 1) - 1);
    queueMicrotask(() => {
      if ((consumers.get(key) ?? 0) <= 0) evict(key);
    });
  };
}

export function resetWorktreePrStore() {
  for (const timer of revalidateTimers.values()) clearInterval(timer);
  revalidateTimers.clear();
  consumers.clear();
  latestRequest.clear();
  backgroundRead.clear();
  useWorktreePrStore.setState({ entries: {} });
}
