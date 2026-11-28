/**
 * The linked PR's review threads, as the PR sync reads them for a shown
 * branch: with each fresh PR read, on refresh, and once per read in flight,
 * driven through the real sync against a synthetic GitHub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { reviewThread } from "../components/ChatWindow/workspace/githubReview/fixture";
import {
  REPO,
  addPr,
  chatSession,
  failure,
  fakeGithub,
  installFakeGithub,
  linkedPr,
  prId,
  prLink,
  pullRequest,
  resetFakeGithub,
  seedChats,
  settle,
  type FakeGithub,
} from "../test/fakeGithub";
import { useNotificationStore } from "./notificationStore";
import {
  acquireWorktreePr,
  pollWatchedPrsNow,
  refreshWorktreePr,
  writeWorktreeReviewThread,
} from "./prSync";
import {
  openThreadCount,
  prEntryOf,
  useWorktreePrStore,
  worktreePrKey,
} from "./worktreePrStore";

vi.mock("../bindings", () => ({
  commands: {
    resolveWorktreeGithub: vi.fn(),
    pollGithubPrs: vi.fn(),
    listGithubOpenPrs: vi.fn(),
    getGithubPr: vi.fn(),
    rerunGithubPrCheck: vi.fn(),
    cancelGithubPrCheck: vi.fn(),
    getWorktreePublishedHead: vi.fn(),
    getGithubPrReviewThreads: vi.fn(),
    writeGithubPrReviewThread: vi.fn(),
  },
}));

const read = vi.mocked(commands.getGithubPrReviewThreads);
const WT = "/wt/a";
const BRANCH = "feature/retry";
const PR = pullRequest(7, { headRef: BRANCH });
const KEY = worktreePrKey(WT, BRANCH);
let world: FakeGithub;

const threads = () => prEntryOf(KEY).reviewThreads;
const messages = () =>
  useNotificationStore.getState().notifications.map((n) => n.message);
const setThreads = (...list: ReturnType<typeof reviewThread>[]) =>
  world.reviewThreads.set(prId(REPO, 7), list);

async function show() {
  const hide = acquireWorktreePr(WT, BRANCH);
  await settle(20);
  return hide;
}

beforeEach(() => {
  vi.clearAllMocks();
  world = fakeGithub();
  addPr(world, PR);
  installFakeGithub(commands, world);
  seedChats(
    chatSession("chat", WT, BRANCH, {
      link: prLink(WT, BRANCH, linkedPr(PR)),
    })
  );
  useNotificationStore.getState().clearNotifications();
});

afterEach(() => resetFakeGithub());

describe("review thread reads", () => {
  it("reads a shown linked PR's threads once, with its PR read", async () => {
    setThreads(reviewThread("t1"), reviewThread("t2", { resolved: true }));
    const hide = await show();
    expect(read).toHaveBeenCalledExactlyOnceWith(WT, BRANCH, REPO, 7, false);
    expect(threads().data?.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(threads()).toMatchObject({ loading: false, error: null });
    expect(openThreadCount(threads())).toBe(1);
    hide();
  });

  it("reads again with each fresh PR read while shown", async () => {
    const hide = await show();
    await pollWatchedPrsNow();
    await settle(20);
    expect(read).toHaveBeenCalledTimes(2);
    hide();
    await settle();
  });

  it("refresh re-reads past GitHub's cache, once", async () => {
    const hide = await show();
    read.mockClear();
    await refreshWorktreePr(WT, BRANCH);
    await settle(20);
    expect(read).toHaveBeenCalledExactlyOnceWith(WT, BRANCH, REPO, 7, true);
    hide();
  });

  it("shares a read in flight instead of asking twice", async () => {
    let answer!: () => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              status: "ok",
              data: {
                repo: REPO,
                prNumber: 7,
                pullRequestId: "PR_kwDOsynthetic7",
                headOid: "h",
                baseOid: "b",
                threads: [reviewThread("slow")],
                truncated: false,
                viewerLogin: null,
              },
            });
        })
    );
    const hide = await show();
    expect(threads().loading).toBe(true);
    await pollWatchedPrsNow();
    await settle(20);
    expect(read).toHaveBeenCalledTimes(1);
    answer();
    await settle();
    expect(threads().data?.threads.map((t) => t.id)).toEqual(["slow"]);
    hide();
  });

  it("ignores an answer a forced read has replaced", async () => {
    let answer!: () => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              status: "ok",
              data: {
                repo: REPO,
                prNumber: 7,
                pullRequestId: "PR_kwDOsynthetic7",
                headOid: "h",
                baseOid: "b",
                threads: [reviewThread("stale")],
                truncated: false,
                viewerLogin: null,
              },
            });
        })
    );
    setThreads(reviewThread("fresh"));
    const hide = await show();
    await refreshWorktreePr(WT, BRANCH);
    await settle(20);
    answer();
    await settle();
    expect(threads().data?.threads.map((t) => t.id)).toEqual(["fresh"]);
    hide();
  });

  it("keeps the threads it has when a later read fails", async () => {
    setThreads(reviewThread("t1"));
    const hide = await show();
    world.failThreads = failure("rate_limited");
    await refreshWorktreePr(WT, BRANCH);
    await settle(20);
    expect(threads().data?.threads.map((t) => t.id)).toEqual(["t1"]);
    expect(threads().error).toMatchObject({ kind: "rate_limited" });
    expect(threads().loading).toBe(false);
    hide();
  });

  it("drops an answer that lands after a project switch", async () => {
    let answer!: () => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              status: "ok",
              data: {
                repo: REPO,
                prNumber: 7,
                pullRequestId: "PR_kwDOsynthetic7",
                headOid: "h",
                baseOid: "b",
                threads: [reviewThread("t1")],
                truncated: false,
                viewerLogin: null,
              },
            });
        })
    );
    const hide = await show();
    useWorktreePrStore.getState().reset();
    answer();
    await settle();
    // The new scope reads for itself; the old answer never lands.
    expect(threads().data?.threads.map((t) => t.id) ?? []).not.toContain("t1");
    hide();
  });
});

describe("review thread writes", () => {
  it("sends a write once to the PR it was meant for, then shows GitHub's threads past a read already out", async () => {
    setThreads(reviewThread("t1"));
    const hide = await show();
    let answerStale!: () => void;
    // A read that left before the write, answering after it.
    read.mockImplementationOnce(
      (_worktree, _branch, repo, prNumber) =>
        new Promise((resolve) => {
          answerStale = () =>
            resolve({
              status: "ok",
              data: {
                repo,
                prNumber,
                pullRequestId: "PR_kwDOsynthetic7",
                viewerLogin: "octo-viewer",
                headOid: "1".repeat(40),
                baseOid: "2".repeat(40),
                threads: [reviewThread("t1")],
                truncated: false,
              },
            });
        })
    );
    void refreshWorktreePr(WT, BRANCH);
    await settle(5);
    read.mockClear();

    const outcome = await writeWorktreeReviewThread(WT, BRANCH, 7, {
      kind: "resolve",
      threadId: "t1",
    });
    expect(outcome.outcome).toEqual({ ok: true, data: "t1" });
    expect(outcome.threads?.threads[0].resolved).toBe(true);
    expect(commands.writeGithubPrReviewThread).toHaveBeenCalledExactlyOnceWith(
      WT,
      BRANCH,
      REPO,
      7,
      { kind: "resolve", threadId: "t1" }
    );
    // Re-read past the backend's cache, not joined to the read already out.
    expect(read).toHaveBeenCalledExactlyOnceWith(WT, BRANCH, REPO, 7, true);
    expect(threads().data?.threads[0].resolved).toBe(true);
    answerStale();
    await settle(5);
    expect(threads().data?.threads[0].resolved).toBe(true);
    hide();
  });

  it("refuses a write for a PR the branch no longer links", async () => {
    const hide = await show();
    const outcome = await writeWorktreeReviewThread(WT, BRANCH, 8, {
      kind: "reopen",
      threadId: "t1",
    });
    expect(outcome).toEqual({
      outcome: { ok: false, failure: expect.objectContaining({ kind: "rejected" }) },
      threads: null,
    });
    expect(commands.writeGithubPrReviewThread).not.toHaveBeenCalled();
    hide();
  });

  it("re-reads after a failed write and answers that read, so a write GitHub applied anyway settles at once", async () => {
    setThreads(reviewThread("t1"));
    world.writeOutcomes = [
      { failure: failure("ambiguous", "GitHub did not answer"), applied: true },
    ];
    const hide = await show();
    const read = vi.mocked(commands.getGithubPrReviewThreads);
    read.mockClear();
    const { outcome, threads: reread } = await writeWorktreeReviewThread(
      WT,
      BRANCH,
      7,
      { kind: "reply", threadId: "t1", body: "Done." }
    );
    expect(outcome).toMatchObject({ ok: false, failure: { kind: "ambiguous" } });
    // One read, past the cache; what it answered is what the store shows.
    expect(read).toHaveBeenCalledExactlyOnceWith(WT, BRANCH, REPO, 7, true);
    expect(reread).toBe(threads().data);
    expect(reread?.threads[0].comments.at(-1)).toMatchObject({
      author: { login: "octo-viewer" },
      body: "Done.",
    });
    hide();
  });
});

describe("new GitHub review thread notifications", () => {
  it("records the first read silently, then notifies about new threads only", async () => {
    setThreads(reviewThread("t1"));
    const hide = await show();
    expect(messages()).toEqual([]);

    const refresh = async () => {
      await refreshWorktreePr(WT, BRANCH);
      await settle(20);
    };
    setThreads(reviewThread("t1"), reviewThread("t2", { author: "bob" }));
    await refresh();
    expect(messages()).toEqual([
      `New GitHub review thread on ${REPO}#7 from bob at src/lib.rs:13.`,
    ]);
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: "info",
      entity: "application",
      entityId: `${REPO}#7`,
      read: false,
    });

    // Nothing new: no second notification.
    await refresh();
    expect(messages()).toHaveLength(1);

    setThreads(
      reviewThread("t1"),
      reviewThread("t2"),
      reviewThread("t3", { author: "carol" }),
      reviewThread("t4", { author: "dave", fileLevel: true, line: null })
    );
    await refresh();
    expect(messages()[1]).toBe(
      `2 new GitHub review threads on ${REPO}#7 from carol, dave.`
    );
    hide();
  });
});
