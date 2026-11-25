import type {
  GithubCheckOutcome,
  GithubCheckStatus,
  GithubFailure,
  GithubPrCheck,
} from "../../../bindings";
import {
  CHECKS_STALE_AFTER_MS,
  type PrChecksEntry,
  type PrRerunState,
} from "../../../stores/worktreePrChecksStore";
import { formatDurationMs } from "../../../utils/formatDuration";

/** A check as every surface shows it: an accepted re-run reads as queued. */
export interface PrCheckView {
  check: GithubPrCheck;
  status: GithubCheckStatus;
  rerun: PrRerunState | null;
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
export function viewChecks(entry: PrChecksEntry): PrCheckView[] {
  const checks = entry.snapshot?.checks ?? [];
  return checks
    .map((check) => {
      const rerun = entry.reruns[check.id] ?? null;
      const status: GithubCheckStatus =
        rerun?.status === "requested" && check.status === "failed"
          ? "queued"
          : check.status;
      return { check, status, rerun };
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
  entry: PrChecksEntry,
  now: number
): PrChecksFreshness {
  const { fetchedAt, refresh } = entry;
  if (refresh.status === "failed")
    return {
      kind: "failed",
      failure: refresh.failure,
      fetchedAt,
      retryAt: refresh.retryAt,
    };
  if (refresh.status === "refreshing") return { kind: "refreshing", fetchedAt };
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
