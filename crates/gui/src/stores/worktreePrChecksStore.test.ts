import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  type GithubFailure,
  type GithubPrCheck,
  type GithubPrChecks,
  type GithubPullRequest,
  type WorktreePrAssociation,
  type WorktreePrPoll,
  type WorktreePrPollBatch,
} from "../bindings";
import {
  countChecks,
  checksFreshness,
  viewChecks,
} from "../components/ChatWindow/workspace/prChecksView";
import {
  CHECKS_RETRY_BASE_MS,
  CHECKS_STALE_AFTER_MS,
  PR_POLL_ACTIVE_MS,
  PR_POLL_IDLE_MS,
  PUBLISHED_HEAD_PROBE_MS,
  acquireWorktreePrChecks,
  cancelWorktreePrCheck,
  refreshWorktreePrChecks,
  rerunWorktreePrCheck,
  resetWorktreePrChecksStore,
  retryDelayMs,
  setWatchedPrWorktrees,
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
    pollWorktreePrs: vi.fn(),
    rerunWorktreePrCheck: vi.fn(),
    cancelWorktreePrCheck: vi.fn(),
    getWorktreePublishedHead: vi.fn(),
  },
}));

const poll = vi.mocked(commands.pollWorktreePrs);
const rerun = vi.mocked(commands.rerunWorktreePrCheck);
const cancel = vi.mocked(commands.cancelWorktreePrCheck);
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

function association(number: number | null): WorktreePrAssociation {
  return number === null
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
}

function linkPr(number: number | null) {
  useWorktreePrStore.setState((state) => ({
    entries: {
      ...state.entries,
      [KEY]: {
        ...IDLE_PR_ENTRY,
        phase: "ready",
        association: association(number),
      },
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
    actionsRun: "run-100",
    rerun: status === "failed" ? "allowed" : "not_applicable",
    cancel:
      status === "running" || status === "queued"
        ? "allowed"
        : "not_applicable",
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
    ...overrides,
  };
}

const entry = () => useWorktreePrChecksStore.getState().entries[KEY];
const RATE_LIMITED: GithubFailure = {
  kind: "rate_limited",
  message: "API rate limit exceeded",
  retryAfterSecs: 40,
};

/** One poll result per asked branch, linked to `checks.prNumber`. */
function answer(
  results: (target: {
    worktreePath: string;
    branch: string;
  }) => WorktreePrPoll["result"] | GithubPrChecks,
  holdOffSecs: number | null = null
) {
  return (targets: { worktreePath: string; branch: string }[]) =>
    Promise.resolve(
      ok<WorktreePrPollBatch>({
        results: targets.map((target) => {
          const result = results(target);
          return {
            ...target,
            result:
              "prNumber" in result
                ? {
                    status: "linked" as const,
                    association: association(result.prNumber),
                    checks: result,
                  }
                : result,
          };
        }),
        holdOffSecs,
      })
    );
}

const linked = (checks: GithubPrChecks) => answer(() => checks);

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
    poll.mockImplementation(linked(snapshot([check("run:1", "passed")])));
    linkPr(null);
    const release = acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).not.toHaveBeenCalled();

    linkPr(482);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledExactlyOnceWith([
      { worktreePath: WORKTREE, branch: BRANCH },
    ]);
    expect(entry().snapshot?.checks).toHaveLength(1);

    linkPr(null);
    expect(entry().snapshot).toBeNull();
    expect(entry().prNumber).toBeNull();
    release();
  });

  it("asks once per tick for every watched branch, shown or not", async () => {
    poll.mockImplementation(
      answer((target) =>
        target.branch === "idle/branch"
          ? { status: "not_linked" }
          : snapshot([check("run:1", "running")])
      )
    );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    setWatchedPrWorktrees([
      { worktreePath: "/wt/b", branch: "feature/b" },
      { worktreePath: "/wt/c", branch: "idle/branch" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll.mock.calls[0][0]).toHaveLength(3);
    const entries = useWorktreePrChecksStore.getState().entries;
    expect(entries[worktreePrKey("/wt/b", "feature/b")].prNumber).toBe(482);
    expect(entries[worktreePrKey("/wt/c", "idle/branch")].prNumber).toBeNull();

    await vi.advanceTimersByTimeAsync(PR_POLL_ACTIVE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poll.mock.calls[1][0]).toHaveLength(3);

    // A branch that leaves the watch list stops being asked about.
    setWatchedPrWorktrees([{ worktreePath: "/wt/b", branch: "feature/b" }]);
    await vi.advanceTimersByTimeAsync(PR_POLL_ACTIVE_MS);
    expect(poll.mock.calls[2][0]).toHaveLength(2);
  });

  it("polls every 30 s while a check is pending and every 5 min otherwise", async () => {
    poll
      .mockImplementationOnce(linked(snapshot([check("run:1", "running")])))
      .mockImplementation(linked(snapshot([check("run:1", "passed")])));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PR_POLL_ACTIVE_MS);
    expect(poll).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(PR_POLL_IDLE_MS - 1_000);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("pauses while the window is hidden and catches up when it shows", async () => {
    poll.mockImplementation(linked(snapshot([check("run:1", "running")])));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);

    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10 * PR_POLL_ACTIVE_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });

  it("waits out GitHub's hold-off before the next tick", async () => {
    poll.mockImplementation(
      answer(() => snapshot([check("run:1", "running")]), 600)
    );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(599_000);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("keeps the last checks through a failed refresh and retries on schedule or on demand", async () => {
    poll
      .mockImplementationOnce(linked(snapshot([check("run:1", "failed")])))
      .mockResolvedValueOnce(err(RATE_LIMITED))
      .mockResolvedValueOnce(err({ ...RATE_LIMITED, retryAfterSecs: null }))
      .mockImplementation(linked(snapshot([check("run:1", "passed")])));
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
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(entry().refresh).toMatchObject({ status: "failed", attempt: 2 });

    // Retry now does not wait for the backoff.
    await refreshWorktreePrChecks(WORKTREE, BRANCH);
    expect(poll).toHaveBeenCalledTimes(4);
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
    expect(retryDelayMs(other, 2)).toBe(CHECKS_RETRY_BASE_MS * 2);
    expect(retryDelayMs(other, 30)).toBe(5 * 60_000);

    poll.mockImplementation(
      answer(() => ({
        status: "failed",
        failure: {
          kind: "auth_expired",
          message: "expired",
          retryAfterSecs: null,
        },
      }))
    );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(entry().refresh).toMatchObject({ status: "failed", retryAt: null });
    // Only the idle cadence asks again; no retry countdown.
    await vi.advanceTimersByTimeAsync(PR_POLL_IDLE_MS - 1_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("marks old checks stale when nothing is refreshing them", async () => {
    poll.mockImplementation(linked(snapshot([check("run:1", "passed")])));
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
    poll
      .mockImplementationOnce(
        linked(snapshot([check("run:1", "failed"), check("run:2", "passed")]))
      )
      // GitHub has not created the new attempt yet.
      .mockImplementationOnce(
        linked(snapshot([check("run:1", "failed"), check("run:2", "passed")]))
      )
      .mockImplementation(
        linked(snapshot([check("run:9", "queued"), check("run:2", "passed")]))
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

    // The pending override keeps the 30 s cadence until GitHub catches up.
    await vi.advanceTimersByTimeAsync(PR_POLL_ACTIVE_MS);
    expect(entry().reruns).toEqual({});
    expect(viewChecks(entry()).map((view) => view.check.id)).toEqual([
      "run:9",
      "run:2",
    ]);
  });

  it("reports a failed re-run once, refreshes, and allows trying again", async () => {
    poll.mockImplementation(linked(snapshot([check("run:1", "failed")])));
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
    expect(poll).toHaveBeenCalledTimes(2);
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

  it("cancels a job's workflow run and shows every job of it as cancelling", async () => {
    const pending = [
      check("run:1", "running"),
      check("run:2", "queued"),
      check("run:3", "running", { actionsRun: "run-200" }),
    ];
    poll
      .mockImplementationOnce(linked(snapshot(pending)))
      .mockImplementationOnce(linked(snapshot(pending)))
      .mockImplementation(
        linked(
          snapshot([
            check("run:1", "failed", { outcome: "cancelled" }),
            check("run:2", "failed", { outcome: "cancelled" }),
            pending[2],
          ])
        )
      );
    cancel.mockResolvedValue(ok(null));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);

    await cancelWorktreePrCheck(WORKTREE, BRANCH, "run:2");
    expect(cancel).toHaveBeenCalledExactlyOnceWith(WORKTREE, BRANCH, "run:2");
    expect(entry().cancels).toEqual({
      "run-100": { status: "requested", at: Date.now() },
    });
    const views = viewChecks(entry());
    expect(
      views.filter((view) => view.cancel?.status === "requested")
    ).toHaveLength(2);
    expect(views.find((view) => view.check.id === "run:3")?.cancel).toBeNull();

    // Once no job of the run is pending the override is dropped.
    await vi.advanceTimersByTimeAsync(PR_POLL_ACTIVE_MS);
    expect(entry().cancels).toEqual({});
  });

  it("refreshes after a push and waits until GitHub reports the pushed head", async () => {
    poll
      .mockImplementationOnce(linked(snapshot([check("run:1", "passed")])))
      .mockImplementationOnce(linked(snapshot([check("run:1", "passed")])))
      .mockImplementation(
        linked(snapshot([check("run:5", "queued")], { headSha: "pushed-2" }))
      );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    // No push yet: the probe is local and asks GitHub nothing.
    await vi.advanceTimersByTimeAsync(PUBLISHED_HEAD_PROBE_MS);
    expect(publishedHead).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledTimes(1);

    publishedHead.mockResolvedValue(ok("pushed-2"));
    await vi.advanceTimersByTimeAsync(PUBLISHED_HEAD_PROBE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(entry().awaitingHead).toBe("pushed-2");
    expect(checksFreshness(entry(), Date.now())).toMatchObject({
      kind: "awaiting_push",
      head: "pushed-2",
    });

    await vi.advanceTimersByTimeAsync(PR_POLL_ACTIVE_MS);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(entry().awaitingHead).toBeNull();
    expect(entry().snapshot?.headSha).toBe("pushed-2");
  });

  it("refreshes on window focus unless the last read is recent", async () => {
    poll.mockImplementation(linked(snapshot([check("run:1", "passed")])));
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("drops a late answer for a PR that is no longer linked", async () => {
    let release: (
      value: ReturnType<typeof ok<WorktreePrPollBatch>>
    ) => void = () => {};
    poll.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    poll.mockImplementation(
      linked(snapshot([check("run:7", "passed")], { prNumber: 483 }))
    );
    linkPr(482);
    acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    linkPr(483);
    release(
      ok({
        results: [
          {
            worktreePath: WORKTREE,
            branch: BRANCH,
            result: {
              status: "linked",
              association: association(482),
              checks: snapshot([check("run:1", "failed")]),
            },
          },
        ],
        holdOffSecs: null,
      })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()).toMatchObject({ prNumber: 483 });
    expect(entry().snapshot?.checks[0].id).toBe("run:7");
  });

  it("keeps one entry for several consumers and releases it with the last", async () => {
    poll.mockImplementation(linked(snapshot([check("run:1", "passed")])));
    linkPr(482);
    const first = acquireWorktreePrChecks(WORKTREE, BRANCH);
    const second = acquireWorktreePrChecks(WORKTREE, BRANCH);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);

    first();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()).toBeDefined();
    second();
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(PUBLISHED_HEAD_PROBE_MS * 3);
    expect(publishedHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PR_POLL_IDLE_MS);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
