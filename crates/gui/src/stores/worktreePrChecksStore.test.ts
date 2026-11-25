import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  type GithubFailure,
  type GithubPrCheck,
  type GithubPrChecks,
  type GithubPullRequest,
  type WorktreePrAssociation,
} from "../bindings";
import {
  countChecks,
  checksFreshness,
  viewChecks,
} from "../components/ChatWindow/workspace/prChecksView";
import {
  AWAITING_PUSH_POLL_MS,
  CHECKS_RETRY_BASE_MS,
  CHECKS_STALE_AFTER_MS,
  PUBLISHED_HEAD_PROBE_MS,
  acquireWorktreePrChecks,
  refreshWorktreePrChecks,
  rerunWorktreePrCheck,
  resetWorktreePrChecksStore,
  retryDelayMs,
  useWorktreePrChecksStore,
} from "./worktreePrChecksStore";
import {
  IDLE_PR_ENTRY,
  resetWorktreePrStore,
  useWorktreePrStore,
  worktreePrKey,
} from "./worktreePrStore";

vi.mock("../bindings", () => ({
  commands: {
    getWorktreePrChecks: vi.fn(),
    rerunWorktreePrCheck: vi.fn(),
    getWorktreePublishedHead: vi.fn(),
  },
}));

const getChecks = vi.mocked(commands.getWorktreePrChecks);
const rerun = vi.mocked(commands.rerunWorktreePrCheck);
const publishedHead = vi.mocked(commands.getWorktreePublishedHead);

const WORKTREE = "/wt/a";
const BRANCH = "feature/retry";
const KEY = worktreePrKey(WORKTREE, BRANCH);

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const err = (error: GithubFailure) => ({ status: "error" as const, error });

function pr(number: number): GithubPullRequest {
  return {
    owner: "example",
    repo: "demo-repo",
    number,
    title: `PR ${number}`,
    state: "open",
    headRef: BRANCH,
    headRepo: "example/demo-repo",
    baseRef: "main",
    url: `https://github.com/example/demo-repo/pull/${number}`,
    author: "alice",
    updatedAt: null,
  };
}

function linkPr(number: number | null) {
  const association: WorktreePrAssociation | null =
    number === null
      ? {
          status: "none",
          branch: BRANCH,
          repo: "example/demo-repo",
          createPrUrl: "https://github.com/example/demo-repo/compare/x",
        }
      : {
          status: "linked",
          branch: BRANCH,
          repo: "example/demo-repo",
          pr: pr(number),
          staleError: null,
        };
  useWorktreePrStore.setState((state) => ({
    entries: {
      ...state.entries,
      [KEY]: { ...IDLE_PR_ENTRY, phase: "ready", association },
    },
  }));
}

function check(
  id: string,
  status: GithubPrCheck["status"],
  overrides: Partial<GithubPrCheck> = {}
): GithubPrCheck {
  return {
    id,
    name: `job ${id}`,
    provider: "GitHub Actions",
    status,
    outcome: status === "failed" ? "failure" : null,
    startedAt: null,
    completedAt: null,
    url: null,
    summary: null,
    failedStep: null,
    actionsJob: true,
    rerun: status === "failed" ? "allowed" : "not_applicable",
    ...overrides,
  };
}

function snapshot(
  checks: GithubPrCheck[],
  overrides: Partial<GithubPrChecks> = {}
): GithubPrChecks {
  return {
    prNumber: 482,
    repo: "example/demo-repo",
    headSha: "sha-1",
    checks,
    truncated: false,
    pollAfterSecs: checks.some(
      (c) => c.status === "running" || c.status === "queued"
    )
      ? 15
      : null,
    ...overrides,
  };
}

const entry = () => useWorktreePrChecksStore.getState().entries[KEY];
const RATE_LIMITED: GithubFailure = {
  kind: "rate_limited",
  message: "API rate limit exceeded",
  retryAfterSecs: 40,
};

describe("worktreePrChecksStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    publishedHead.mockResolvedValue(ok("pushed-1"));
  });

  afterEach(() => {
    resetWorktreePrChecksStore();
    resetWorktreePrStore();
    vi.useRealTimers();
  });

  it("loads checks once the branch has a linked PR and clears them on unlink", async () => {
    getChecks.mockResolvedValue(ok(snapshot([check("run:1", "passed")])));
    linkPr(null);
    const release = acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(getChecks).not.toHaveBeenCalled();

    linkPr(482);
    await vi.advanceTimersByTimeAsync(0);
    expect(getChecks).toHaveBeenCalledExactlyOnceWith(WORKTREE, BRANCH);
    expect(entry().snapshot?.checks).toHaveLength(1);

    linkPr(null);
    expect(entry().snapshot).toBeNull();
    expect(entry().prNumber).toBeNull();
    release();
  });

  it("polls only while a check is queued or running", async () => {
    getChecks
      .mockResolvedValueOnce(ok(snapshot([check("run:1", "running")])))
      .mockResolvedValue(ok(snapshot([check("run:1", "passed")])));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(getChecks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getChecks).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(getChecks).toHaveBeenCalledTimes(2);
  });

  it("keeps the last checks through a failed refresh and retries on schedule or on demand", async () => {
    getChecks
      .mockResolvedValueOnce(ok(snapshot([check("run:1", "failed")])))
      .mockResolvedValueOnce(err(RATE_LIMITED))
      .mockResolvedValueOnce(err({ ...RATE_LIMITED, retryAfterSecs: null }))
      .mockResolvedValue(ok(snapshot([check("run:1", "passed")])));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    const fetchedAt = entry().fetchedAt;

    await refreshWorktreePrChecks(WORKTREE, BRANCH);
    const failed = entry();
    expect(failed.snapshot?.checks[0].status).toBe("failed");
    expect(failed.refresh).toMatchObject({
      status: "failed",
      failure: RATE_LIMITED,
      retryAt: Date.now() + 40_000,
      attempt: 1,
    });
    const freshness = checksFreshness(failed, Date.now());
    expect(freshness).toMatchObject({ kind: "failed", fetchedAt });

    // GitHub's retry hint is honoured: nothing before 40 s.
    await vi.advanceTimersByTimeAsync(39_000);
    expect(getChecks).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getChecks).toHaveBeenCalledTimes(3);
    expect(entry().refresh).toMatchObject({ status: "failed", attempt: 2 });

    // Retry now does not wait for the backoff.
    await refreshWorktreePrChecks(WORKTREE, BRANCH);
    expect(getChecks).toHaveBeenCalledTimes(4);
    expect(entry().refresh).toEqual({ status: "idle" });
    expect(entry().snapshot?.checks[0].status).toBe("passed");
  });

  it("backs off without a hint and never auto-retries what only the user can fix", async () => {
    const other: GithubFailure = {
      kind: "other",
      message: "offline",
      retryAfterSecs: null,
    };
    expect(retryDelayMs(other, 1)).toBe(CHECKS_RETRY_BASE_MS);
    expect(retryDelayMs(other, 3)).toBe(CHECKS_RETRY_BASE_MS * 4);
    expect(retryDelayMs(other, 30)).toBe(5 * 60_000);

    getChecks.mockResolvedValue(
      err({ kind: "auth_expired", message: "expired", retryAfterSecs: null })
    );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry().refresh).toMatchObject({ status: "failed", retryAt: null });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(getChecks).toHaveBeenCalledTimes(1);
  });

  it("marks old checks stale when nothing is refreshing them", async () => {
    getChecks.mockResolvedValue(ok(snapshot([check("run:1", "passed")])));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    const fetchedAt = entry().fetchedAt as number;
    expect(checksFreshness(entry(), fetchedAt + 1_000).kind).toBe("fresh");
    expect(
      checksFreshness(entry(), fetchedAt + CHECKS_STALE_AFTER_MS).kind
    ).toBe("stale");
  });

  it("shows an accepted re-run as queued until GitHub reports the new attempt", async () => {
    getChecks
      .mockResolvedValueOnce(
        ok(snapshot([check("run:1", "failed"), check("run:2", "passed")]))
      )
      // GitHub has not created the new attempt yet.
      .mockResolvedValueOnce(
        ok(snapshot([check("run:1", "failed"), check("run:2", "passed")]))
      )
      .mockResolvedValue(
        ok(snapshot([check("run:9", "queued"), check("run:2", "passed")]))
      );
    let accept: (value: { status: "ok"; data: null }) => void = () => {};
    rerun.mockReturnValue(new Promise((resolve) => (accept = resolve)));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);

    const request = rerunWorktreePrCheck(WORKTREE, BRANCH, "run:1");
    expect(entry().reruns["run:1"]).toEqual({ status: "requesting" });
    // A second click while requesting sends nothing.
    await rerunWorktreePrCheck(WORKTREE, BRANCH, "run:1");
    expect(rerun).toHaveBeenCalledTimes(1);

    accept(ok(null));
    await request;
    expect(entry().reruns["run:1"]).toMatchObject({ status: "requested" });
    const counts = countChecks(viewChecks(entry()));
    expect(counts).toMatchObject({ failed: 0, queued: 1, passed: 1 });

    // Still polling while the override waits for GitHub.
    await vi.advanceTimersByTimeAsync(CHECKS_RETRY_BASE_MS);
    expect(entry().reruns).toEqual({});
    expect(viewChecks(entry()).map((view) => view.check.id)).toEqual([
      "run:9",
      "run:2",
    ]);
  });

  it("reports a failed re-run once, refreshes, and allows trying again", async () => {
    getChecks.mockResolvedValue(ok(snapshot([check("run:1", "failed")])));
    rerun.mockResolvedValue(
      err({
        kind: "other",
        message: "GitHub returned HTTP 502",
        retryAfterSecs: null,
      })
    );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);

    await rerunWorktreePrCheck(WORKTREE, BRANCH, "run:1");
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(getChecks).toHaveBeenCalledTimes(2);
    expect(entry().reruns["run:1"]).toEqual({
      status: "failed",
      message: "GitHub returned HTTP 502",
    });
    expect(viewChecks(entry())[0].status).toBe("failed");

    rerun.mockResolvedValue(ok(null));
    await rerunWorktreePrCheck(WORKTREE, BRANCH, "run:1");
    expect(rerun).toHaveBeenCalledTimes(2);
    expect(entry().reruns["run:1"]).toMatchObject({ status: "requested" });
  });

  it("refreshes after a push and waits until GitHub reports the pushed head", async () => {
    getChecks
      .mockResolvedValueOnce(ok(snapshot([check("run:1", "passed")])))
      .mockResolvedValueOnce(ok(snapshot([check("run:1", "passed")])))
      .mockResolvedValue(
        ok(snapshot([check("run:5", "queued")], { headSha: "pushed-2" }))
      );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(getChecks).toHaveBeenCalledTimes(1);

    // No push yet: the probe is local and asks GitHub nothing.
    await vi.advanceTimersByTimeAsync(PUBLISHED_HEAD_PROBE_MS);
    expect(publishedHead).toHaveBeenCalledTimes(2);
    expect(getChecks).toHaveBeenCalledTimes(1);

    publishedHead.mockResolvedValue(ok("pushed-2"));
    await vi.advanceTimersByTimeAsync(PUBLISHED_HEAD_PROBE_MS);
    expect(getChecks).toHaveBeenCalledTimes(2);
    expect(entry().awaitingHead).toBe("pushed-2");
    expect(checksFreshness(entry(), Date.now())).toMatchObject({
      kind: "awaiting_push",
      head: "pushed-2",
    });

    await vi.advanceTimersByTimeAsync(AWAITING_PUSH_POLL_MS);
    expect(getChecks).toHaveBeenCalledTimes(3);
    expect(entry().awaitingHead).toBeNull();
    expect(entry().snapshot?.headSha).toBe("pushed-2");
  });

  it("refreshes on window focus unless the last read is recent", async () => {
    getChecks.mockResolvedValue(ok(snapshot([check("run:1", "passed")])));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getChecks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(11_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getChecks).toHaveBeenCalledTimes(2);
  });

  it("drops a late answer for a PR that is no longer linked", async () => {
    let answer: (
      value: ReturnType<typeof ok<GithubPrChecks>>
    ) => void = () => {};
    getChecks.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    getChecks.mockResolvedValue(
      ok(snapshot([check("run:7", "passed")], { prNumber: 483 }))
    );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    linkPr(483);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()).toMatchObject({ prNumber: 483 });
    expect(entry().snapshot?.checks[0].id).toBe("run:7");

    answer(ok(snapshot([check("run:1", "failed")])));
    await vi.advanceTimersByTimeAsync(0);
    expect(entry().snapshot?.checks[0].id).toBe("run:7");
  });

  it("keeps one entry for several consumers and releases it with the last", async () => {
    getChecks.mockResolvedValue(ok(snapshot([check("run:1", "passed")])));
    linkPr(482);
    const first = acquireWorktreePrChecks(WORKTREE, BRANCH);
    const second = acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(getChecks).toHaveBeenCalledTimes(1);

    first();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()).toBeDefined();
    second();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(PUBLISHED_HEAD_PROBE_MS * 3);
    expect(publishedHead).toHaveBeenCalledTimes(1);
  });
});
