import type {
  GithubFailure,
  GithubPrChecks,
  GithubPullRequest,
} from "../bindings";

/**
 * Cadence and check-state rules shared by the PR poller and the PR sync.
 * The checks of a branch's linked PR live on its entry in
 * `useWorktreePrStore`.
 */

/** Tick interval while anything is queued, running or settling. */
export const PR_POLL_ACTIVE_MS = 30_000;
/** Tick interval when every check has finished. */
export const PR_POLL_IDLE_MS = 5 * 60_000;
/** A failed read retries after this, doubling up to the cap. */
export const CHECKS_RETRY_BASE_MS = 30_000;
export const CHECKS_RETRY_MAX_MS = 5 * 60_000;
/** Checks older than this, with no read pending, are shown as stale. */
export const CHECKS_STALE_AFTER_MS = 2 * PR_POLL_IDLE_MS;
/** Local-only probe of a shown branch's remote-tracking ref, to see a push. */
export const PUBLISHED_HEAD_PROBE_MS = 10_000;
/** Active ticks spent waiting for GitHub to report a pushed head. */
export const AWAITING_PUSH_MAX_POLLS = 10;
/** An accepted re-run or cancel GitHub has not shown yet stops overriding. */
export const WRITE_PENDING_MAX_MS = 3 * 60_000;
/** Focus reads again only when the last tick is at least this old. */
export const FOCUS_MIN_AGE_MS = 30_000;

export type PrChecksRefresh =
  | { status: "idle" }
  | { status: "refreshing" }
  | {
      status: "failed";
      failure: GithubFailure;
      /** `null` when only the user can fix it (gh missing, signed out). */
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

export interface PrChecksEntry {
  /** The linked PR these checks belong to. */
  prNumber: number | null;
  /** The linked PR as last read with its checks. */
  pr: GithubPullRequest | null;
  snapshot: GithubPrChecks | null;
  fetchedAt: number | null;
  refresh: PrChecksRefresh;
  reruns: Readonly<Record<string, PrWriteState>>;
  cancels: Readonly<Record<string, PrWriteState>>;
  /** A pushed commit GitHub has not reported as the PR head yet. */
  awaitingHead: string | null;
}

export const IDLE_CHECKS_ENTRY: PrChecksEntry = {
  prNumber: null,
  pr: null,
  snapshot: null,
  fetchedAt: null,
  refresh: { status: "idle" },
  reruns: {},
  cancels: {},
  awaitingHead: null,
};

export function needsUserFix(failure: GithubFailure): boolean {
  return failure.kind === "gh_missing" || failure.kind === "auth_expired";
}

export function retryDelayMs(failure: GithubFailure, attempt: number): number {
  if (failure.retryAfterSecs !== null)
    return Math.max(failure.retryAfterSecs * 1000, CHECKS_RETRY_BASE_MS);
  return Math.min(
    CHECKS_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    CHECKS_RETRY_MAX_MS
  );
}

export const isPendingStatus = (status: string) =>
  status === "running" || status === "queued";

/**
 * Drops overrides GitHub has caught up with: a re-run whose failed attempt
 * was replaced or no longer failed, a cancel whose run has no pending job
 * left, or a request too old to trust.
 */
export function reconcileWrites(
  entry: Pick<PrChecksEntry, "reruns" | "cancels">,
  snapshot: GithubPrChecks,
  now: number
): Pick<PrChecksEntry, "reruns" | "cancels"> {
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
