import type {
  GithubCheckOutcome,
  GithubCheckStatus,
  GithubFailure,
  GithubPrCheck,
} from "../../../bindings";
import {
  CHECKS_STALE_AFTER_MS,
  type PrChecksState,
  type PrWriteState,
  type WorktreePrEntry,
} from "../../../stores/worktreePrStore";
import { formatDurationMs } from "../../../utils/formatDuration";

/**
 * A check as every surface shows it: an accepted re-run reads as queued; a
 * cancel of its workflow run keeps the status and is carried in `cancel`.
 */
export interface PrCheckView {
  check: GithubPrCheck;
  status: GithubCheckStatus;
  rerun: PrWriteState | null;
  cancel: PrWriteState | null;
}

export interface PrCheckCounts {
  failed: number;
  running: number;
  queued: number;
  passed: number;
  total: number;
}

export const CHECK_STATUS_ORDER: readonly GithubCheckStatus[] = [
  "failed",
  "running",
  "queued",
  "passed",
];

const ORDER: Record<GithubCheckStatus, number> = {
  failed: 0,
  running: 1,
  queued: 2,
  passed: 3,
};

/**
 * The single derivation behind the bar, the drawer and the chip, so their
 * counts always come from the same refresh.
 */
export function viewChecks(
  entry: Pick<PrChecksState, "snapshot" | "reruns" | "cancels">
): PrCheckView[] {
  const checks = entry.snapshot?.checks ?? [];
  return checks
    .map((check) => {
      const rerun = entry.reruns[check.id] ?? null;
      const status: GithubCheckStatus =
        rerun?.status === "requested" && check.status === "failed"
          ? "queued"
          : check.status;
      const cancel = check.actionsRun
        ? (entry.cancels[check.actionsRun] ?? null)
        : null;
      return { check, status, rerun, cancel };
    })
    .sort(
      (a, b) =>
        ORDER[a.status] - ORDER[b.status] ||
        a.check.name.localeCompare(b.check.name)
    );
}

export function countChecks(views: readonly PrCheckView[]): PrCheckCounts {
  const counts: PrCheckCounts = {
    failed: 0,
    running: 0,
    queued: 0,
    passed: 0,
    total: views.length,
  };
  for (const view of views) counts[view.status] += 1;
  return counts;
}

export type PrChecksFreshness =
  | { kind: "loading" }
  | { kind: "fresh"; fetchedAt: number }
  | { kind: "refreshing"; fetchedAt: number | null }
  | { kind: "stale"; fetchedAt: number }
  | { kind: "awaiting_push"; head: string; fetchedAt: number }
  | {
      kind: "failed";
      failure: GithubFailure;
      fetchedAt: number | null;
      retryAt: number | null;
    };

export function checksFreshness(
  entry: Pick<WorktreePrEntry, "fetchedAt" | "read" | "awaitingHead">,
  now: number
): PrChecksFreshness {
  const { fetchedAt, read } = entry;
  if (read.status === "failed")
    return {
      kind: "failed",
      failure: read.failure,
      fetchedAt,
      retryAt: read.retryAt,
    };
  if (read.status === "refreshing") return { kind: "refreshing", fetchedAt };
  if (fetchedAt === null) return { kind: "loading" };
  if (entry.awaitingHead !== null)
    return { kind: "awaiting_push", head: entry.awaitingHead, fetchedAt };
  if (now - fetchedAt >= CHECKS_STALE_AFTER_MS)
    return { kind: "stale", fetchedAt };
  return { kind: "fresh", fetchedAt };
}

/** "18s ago", "4m ago", "2h ago": always from the same clock as the entry. */
export function formatAge(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function formatCountdown(until: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}

/** Elapsed or total run time of a check, e.g. "4m 12s"; null when unknown. */
export function checkDuration(
  check: GithubPrCheck,
  now: number
): string | null {
  if (!check.startedAt) return null;
  const start = Date.parse(check.startedAt);
  const end = check.completedAt ? Date.parse(check.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return formatDurationMs(end - start);
}

/** Jobs that one cancel stops: every pending job of the same workflow run. */
export function jobsInRun(
  views: readonly PrCheckView[],
  run: string | null
): number {
  if (!run) return 0;
  return views.filter(
    (view) =>
      view.check.actionsRun === run &&
      (view.status === "running" || view.status === "queued")
  ).length;
}

/** Said only when it differs from the bucket: "cancelled", "skipped". */
export const OUTCOME_NOTE: Partial<Record<GithubCheckOutcome, string>> = {
  neutral: "neutral",
  skipped: "skipped",
  cancelled: "cancelled",
  timed_out: "timed out",
  action_required: "action required",
  startup_failure: "startup failure",
  stale: "stale",
  error: "error",
};

export function checkCountsLabel(counts: PrCheckCounts): string {
  if (counts.total === 0) return "No checks";
  return CHECK_STATUS_ORDER.filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(", ");
}
