import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type GithubReviewThread } from "../bindings";
import { reviewThread } from "../components/ChatWindow/workspace/githubReview.fixture";
import {
  resetSeenReviewThreads,
  useGithubReviewThreads,
  useGithubReviewThreadsStore,
} from "./githubReviewThreadsStore";
import { useNotificationStore } from "./notificationStore";

vi.mock("../bindings", () => ({
  commands: { getWorktreePrReviewThreads: vi.fn() },
}));

function answer(threads: GithubReviewThread[]) {
  vi.mocked(commands.getWorktreePrReviewThreads).mockResolvedValueOnce({
    status: "ok",
    data: {
      status: "loaded",
      repo: "example/demo-repo",
      prNumber: 7,
      headOid: "h",
      baseOid: "b",
      threads,
      truncated: false,
    },
  });
}

function messages() {
  return useNotificationStore
    .getState()
    .notifications.map((notification) => notification.message);
}

beforeEach(() => {
  resetSeenReviewThreads();
  useGithubReviewThreadsStore.setState({ entries: {} });
  useNotificationStore.getState().clearNotifications();
});
afterEach(() => vi.clearAllMocks());

describe("new GitHub review thread notifications", () => {
  it("records the first read silently, then notifies about new threads only", async () => {
    answer([reviewThread("t1")]);
    const { result } = renderHook(() =>
      useGithubReviewThreads("/work/demo-repo", "feature", 7)
    );
    await act(async () => {});
    expect(messages()).toEqual([]);

    answer([reviewThread("t1"), reviewThread("t2", { author: "bob" })]);
    await act(async () => result.current.refresh());
    expect(messages()).toEqual([
      "New GitHub review thread on example/demo-repo#7 from bob at src/lib.rs:13.",
    ]);
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: "info",
      entity: "application",
      entityId: "example/demo-repo#7",
      read: false,
    });

    // Nothing new: no second notification.
    answer([reviewThread("t1"), reviewThread("t2", { author: "bob" })]);
    await act(async () => result.current.refresh());
    expect(messages()).toHaveLength(1);

    answer([
      reviewThread("t1"),
      reviewThread("t2"),
      reviewThread("t3", { author: "carol" }),
      reviewThread("t4", { author: "dave", fileLevel: true, line: null }),
    ]);
    await act(async () => result.current.refresh());
    expect(messages()[1]).toBe(
      "2 new GitHub review threads on example/demo-repo#7 from carol, dave."
    );
  });
});
