/**
 * Oracles for the one derivation behind the review bar, the checks drawer and
 * the header chip. Expected counts are tallied straight from the snapshot and
 * the override maps, never through `viewChecks`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { GithubCheckStatus, GithubPrCheck } from "../../../bindings";
import {
  CHECKS_STALE_AFTER_MS,
  IDLE_PR_ENTRY,
  type PrWriteState,
  type WorktreePrEntry,
} from "../../../stores/worktreePrStore";
import type { LinkedPr } from "../../../stores/prLinks";
import { ChatHeaderPrChip } from "../GithubPr";
import {
  checkCountsLabel,
  checkDuration,
  checksFreshness,
  countChecks,
  formatAge,
  formatCountdown,
  jobsInRun,
  viewChecks,
  type PrCheckCounts,
} from "./prChecksView";

const STATUSES: GithubCheckStatus[] = ["failed", "running", "queued", "passed"];
const IDS = ["c1", "c2", "c3", "c4", "c5"];
const RUNS = ["run-1", "run-2"];
/** Names that tie, differ only in case, or sort before their prefix. */
const NAMES = ["build", "Build", "lint", "lint-a", "test", "a"];

const writeState: gs.Generator<PrWriteState> = gs.oneOf<PrWriteState>(
  gs.just({ status: "requesting" }),
  gs
    .integers({ minValue: 0, maxValue: 1_000 })
    .map((at): PrWriteState => ({ status: "requested", at })),
  gs.just({ status: "failed", message: "HTTP 502" })
);

const checkGen: gs.Generator<GithubPrCheck> = gs
  .tuples(
    gs.sampledFrom(IDS),
    gs.sampledFrom(NAMES),
    gs.sampledFrom(STATUSES),
    gs.optional(gs.sampledFrom(RUNS))
  )
  .map(([id, name, status, actionsRun]) => ({
    id,
    name,
    provider: "GitHub Actions",
    status,
    outcome: status === "failed" ? "failure" : null,
    startedAt: null,
    completedAt: null,
    url: null,
    summary: null,
    failedStep: null,
    actionsJob: actionsRun !== null,
    actionsRun,
    rerun: "not_applicable",
    cancel: "not_applicable",
  }));

function overrides(keys: string[]) {
  return gs
    .arrays(gs.tuples(gs.sampledFrom(keys), writeState), { maxSize: 6 })
    .map((pairs) => Object.fromEntries(pairs));
}

const entryGen: gs.Generator<WorktreePrEntry> = gs
  .tuples(
    gs.optional(gs.arrays(checkGen, { maxSize: 8 })),
    overrides([...IDS, "gone"]),
    overrides([...RUNS, "run-gone"])
  )
  .map(([checks, reruns, cancels]) => ({
    ...IDLE_PR_ENTRY,
    snapshot:
      checks === null
        ? null
        : {
            prNumber: 7,
            repo: "example/demo-repo",
            headSha: "sha",
            checks,
            truncated: false,
          },
    reruns,
    cancels,
  }));

const hasOwn = (object: object, key: string) =>
  Object.prototype.hasOwnProperty.call(object, key);

/** The spec: an accepted re-run moves a failed check, and only a failed one, to queued. */
function naiveCounts(entry: WorktreePrEntry): PrCheckCounts {
  const checks = entry.snapshot?.checks ?? [];
  const tally = (status: GithubCheckStatus) =>
    checks.filter((check) => check.status === status).length;
  const rerunning = checks.filter(
    (check) =>
      check.status === "failed" &&
      hasOwn(entry.reruns, check.id) &&
      entry.reruns[check.id].status === "requested"
  ).length;
  return {
    failed: tally("failed") - rerunning,
    running: tally("running"),
    queued: tally("queued") + rerunning,
    passed: tally("passed"),
    total: checks.length,
  };
}

test("counts match a naive tally of the snapshot and its accepted re-runs", () =>
  hegel.test((tc) => {
    const entry = tc.draw(entryGen);
    const counts = countChecks(viewChecks(entry));
    expect(counts).toEqual(naiveCounts(entry));
    expect(counts.failed + counts.running + counts.queued + counts.passed).toBe(
      counts.total
    );
    expect(counts.total).toBe(entry.snapshot?.checks.length ?? 0);
  }));

test("views are each check once, sorted by status then name, with their overrides", () =>
  hegel.test((tc) => {
    const entry = tc.draw(entryGen);
    const checks = entry.snapshot?.checks ?? [];
    const views = viewChecks(entry);

    // A permutation of the snapshot: every check object exactly once.
    expect(views).toHaveLength(checks.length);
    expect(new Set(views.map((view) => view.check))).toEqual(new Set(checks));

    const rank = (status: GithubCheckStatus) => STATUSES.indexOf(status);
    for (let i = 1; i < views.length; i++) {
      const [a, b] = [views[i - 1], views[i]];
      const byStatus = rank(a.status) - rank(b.status);
      expect(byStatus).toBeLessThanOrEqual(0);
      if (byStatus === 0)
        expect(a.check.name.localeCompare(b.check.name)).toBeLessThanOrEqual(0);
    }

    for (const view of views) {
      const rerun = hasOwn(entry.reruns, view.check.id)
        ? entry.reruns[view.check.id]
        : null;
      const run = view.check.actionsRun;
      const cancel =
        run !== null && hasOwn(entry.cancels, run) ? entry.cancels[run] : null;
      expect(view.rerun).toBe(rerun);
      expect(view.cancel).toBe(cancel);
      // Only an accepted re-run of a failed check changes the status.
      const moved =
        view.check.status === "failed" && rerun?.status === "requested";
      expect(view.status).toBe(moved ? "queued" : view.check.status);
    }
  }));

const PR: LinkedPr = {
  host: "github.com",
  owner: "example",
  repo: "demo-repo",
  number: 7,
  title: "Demo",
  state: "open",
  url: "https://github.com/example/demo-repo/pull/7",
};

test("the header chip shows failed over pending over passed, and nothing without checks", () =>
  hegel.test((tc) => {
    const entry = tc.draw(entryGen);
    const expected = naiveCounts(entry);
    try {
      render(
        <ChatHeaderPrChip pr={PR} checks={countChecks(viewChecks(entry))} />
      );
      const chip = screen.queryByTestId("chat-header-pr-checks");
      const pending = expected.running + expected.queued;
      const shown =
        expected.failed > 0
          ? { status: "failed", count: expected.failed }
          : pending > 0
            ? {
                status: expected.running > 0 ? "running" : "queued",
                count: pending,
              }
            : expected.total > 0
              ? { status: "passed", count: expected.passed }
              : null;
      if (shown === null) {
        expect(chip).toBeNull();
        return;
      }
      expect(chip).not.toBeNull();
      expect(chip?.className).toContain(`is-${shown.status}`);
      expect(chip?.textContent).toBe(String(shown.count));
    } finally {
      cleanup();
    }
  }));

/** Valid instants, instants a skewed clock could produce, and junk. */
const NOW = Date.UTC(2026, 10, 26, 12);
const instant = gs.integers({
  minValue: NOW - 10 * 86_400_000,
  maxValue: NOW + 10 * 86_400_000,
});
const timestamp = gs.oneOf(
  instant.map((ms) => new Date(ms).toISOString()),
  gs.sampledFrom(["", "not a date", "2026-13-45T99:00:00Z", "NaN"]),
  gs.just(null)
);

const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };
const spelledSeconds = (text: string) =>
  [...text.matchAll(/(\d+)([hms])/g)].reduce(
    (sum, [, n, unit]) => sum + Number(n) * UNIT_SECONDS[unit],
    0
  );
const noNegativeOrNaN = (text: string) =>
  !text.includes("-") && !text.includes("NaN") && !text.includes("Infinity");

/** Gaps near every unit boundary, both ways round, and far apart. */
const gap = gs.oneOf(
  gs.integers({ minValue: -10_000, maxValue: 10_000 }),
  gs.integers({ minValue: -4_000_000, maxValue: 4_000_000 }),
  gs.integers({ minValue: -864_000_000, maxValue: 864_000_000 })
);

/** The spec, spelled out per unit: whole elapsed seconds, then minutes, then hours. */
function expectedAge(elapsedMs: number): string {
  const seconds = elapsedMs <= 0 ? 0 : Math.floor(elapsedMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** Remaining time rounded up, so "0s" only once the deadline has passed. */
function expectedCountdown(remainingMs: number): string {
  const seconds = remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
}

test("ages and countdowns match their spec and never read negative or NaN under clock skew", () =>
  hegel.test((tc) => {
    const now = tc.draw(instant);
    const at = now - tc.draw(gap);
    const age = formatAge(at, now);
    const countdown = formatCountdown(at, now);
    expect(age).toBe(expectedAge(now - at));
    expect(countdown).toBe(expectedCountdown(at - now));
    expect(noNegativeOrNaN(age) && noNegativeOrNaN(countdown)).toBe(true);
  }));

test.each([
  [4_999, "just now", "5s"],
  [5_000, "5s ago", "5s"],
  [59_999, "59s ago", "1m"],
  [60_000, "1m ago", "1m"],
  [3_599_999, "59m ago", "60m"],
  [3_600_000, "1h ago", "60m"],
  [-30_000, "just now", "0s"],
])(
  "%i ms since a read is %s; a retry that far off is %s",
  (ms, age, countdown) => {
    expect(formatAge(NOW - ms, NOW)).toBe(age);
    expect(formatCountdown(NOW + ms, NOW)).toBe(countdown);
  }
);

test("a check's duration is unknown or a non-negative span, whatever its timestamps", () =>
  hegel.test((tc) => {
    const [startedAt, completedAt] = [tc.draw(timestamp), tc.draw(timestamp)];
    const now = tc.draw(instant);
    const duration = checkDuration(
      {
        id: "c1",
        name: "build",
        provider: "GitHub Actions",
        status: completedAt ? "passed" : "running",
        outcome: null,
        startedAt,
        completedAt,
        url: null,
        summary: null,
        failedStep: null,
        actionsJob: true,
        actionsRun: null,
        rerun: "not_applicable",
        cancel: "not_applicable",
      },
      now
    );
    const start = startedAt ? Date.parse(startedAt) : NaN;
    const end = completedAt ? Date.parse(completedAt) : now;
    if (Number.isNaN(start) || Number.isNaN(end)) {
      expect(duration).toBeNull();
      return;
    }
    expect(duration).not.toBeNull();
    const text = duration as string;
    expect(text).toMatch(/^(\d+h( \d+m)?|\d+m( \d+s)?|\d+s)$/);
    expect(noNegativeOrNaN(text)).toBe(true);
    // Skew (completion before start) reads as zero, never negative.
    // Skew (completion before start) reads as zero, never negative; otherwise
    // the text spells the elapsed whole seconds, minutes dropped past an hour.
    const elapsed = Math.max(0, Math.floor((end - start) / 1000));
    expect(spelledSeconds(text)).toBe(
      elapsed >= 3600 ? elapsed - (elapsed % 60) : elapsed
    );
  }));

test("a cancel stops exactly the pending jobs of its workflow run", () =>
  hegel.test((tc) => {
    const views = viewChecks(tc.draw(entryGen));
    const run = tc.draw(gs.optional(gs.sampledFrom([...RUNS, "run-gone"])));
    const expected =
      run === null
        ? 0
        : views.filter(
            (view) =>
              view.check.actionsRun === run &&
              ["running", "queued"].includes(view.status)
          ).length;
    expect(jobsInRun(views, run)).toBe(expected);
  }));

test("the counts label names each non-empty bucket in status order", () =>
  hegel.test((tc) => {
    const counts = countChecks(viewChecks(tc.draw(entryGen)));
    const label = checkCountsLabel(counts);
    if (counts.total === 0) {
      expect(label).toBe("No checks");
      return;
    }
    const parts = label.split(", ").map((part) => part.split(" "));
    expect(parts.map(([, status]) => status)).toEqual(
      STATUSES.filter((status) => counts[status] > 0)
    );
    for (const [n, status] of parts)
      expect(Number(n)).toBe(counts[status as GithubCheckStatus]);
  }));

test("freshness says failed, then refreshing, then loading, awaiting a push, stale or fresh", () =>
  hegel.test((tc) => {
    const base = tc.draw(entryGen);
    const read = tc.draw(
      gs.sampledFrom<WorktreePrEntry["read"]>([
        { status: "idle" },
        { status: "refreshing" },
        {
          status: "failed",
          failure: { kind: "other", message: "offline", retryAfterSecs: null },
          retryAt: NOW + 30_000,
          attempt: 1,
        },
      ])
    );
    const fetchedAt = tc.draw(gs.optional(instant));
    const awaitingHead = tc.draw(gs.optional(gs.just("sha-pushed")));
    const entry = { ...base, read, fetchedAt, awaitingHead };
    const now = tc.draw(instant);
    const freshness = checksFreshness(entry, now);
    const expected =
      read.status === "failed"
        ? "failed"
        : read.status === "refreshing"
          ? "refreshing"
          : fetchedAt === null
            ? "loading"
            : awaitingHead !== null
              ? "awaiting_push"
              : now - fetchedAt >= CHECKS_STALE_AFTER_MS
                ? "stale"
                : "fresh";
    expect(freshness.kind).toBe(expected);
    if (freshness.kind !== "loading")
      expect(freshness.fetchedAt).toBe(fetchedAt);
  }));
