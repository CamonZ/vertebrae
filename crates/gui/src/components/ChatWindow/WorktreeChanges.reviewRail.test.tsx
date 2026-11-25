import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  type GithubPullRequest,
  type WorktreeChanges as Changes,
} from "../../bindings";
import { resetWorktreePrStore } from "../../stores/worktreePrStore";
import { useChatSideColumnStore } from "../../stores/chatSideColumnStore";
import { useGithubReviewThreadsStore } from "../../stores/githubReviewThreadsStore";
import { WorktreeChanges } from "./WorktreeChanges";
import { anchored, at, reviewThread } from "./workspace/githubReview.fixture";

vi.mock("./workspace/useWorktreeWatch", () => ({
  useWorktreeWatch: vi.fn(() => null),
}));

vi.mock("../../bindings", () => ({
  commands: {
    loadWorktreeChanges: vi.fn(),
    listComparisonChoices: vi.fn(),
    listWorktreeDirectory: vi.fn(),
    worktreeFileExists: vi.fn(),
    getWorktreePrAssociation: vi.fn(),
    getWorktreePrReviewThreads: vi.fn(),
    mapWorktreePrReviewThreads: vi.fn(),
  },
}));

const COMPARISON = {
  base_commit: "b".repeat(40),
  selected_base_commit: "b".repeat(40),
  target_commit: "c".repeat(40),
  working_tree: true,
  merge_base: true,
};

const changes: Changes = {
  base_branch: "refs/heads/main",
  base_unavailable: null,
  comparison: COMPARISON,
  totals: { additions: 0, deletions: 0, binary_files: 0 },
  files: [],
};

const pr: GithubPullRequest = {
  owner: "example",
  repo: "demo-repo",
  number: 7,
  title: "Total fix",
  state: "open",
  headRef: "feature/total",
  headRepo: "example/demo-repo",
  baseRef: "main",
  url: "https://github.com/example/demo-repo/pull/7",
  author: null,
  updatedAt: null,
};

const threads = [
  reviewThread("t1", { body: "Why 2?" }),
  reviewThread("old", {
    author: "bob",
    outdated: true,
    line: null,
    originalLine: 9,
    body: "Stale note.",
  }),
];

function renderChanges() {
  return render(
    <WorktreeChanges
      sessionId="chat"
      worktreePath="/work/demo-repo"
      prBranch="feature/total"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatSideColumnStore.getState().forget();
  useGithubReviewThreadsStore.setState({ entries: {} });
  vi.mocked(commands.loadWorktreeChanges).mockResolvedValue({
    status: "ok",
    data: changes,
  });
  vi.mocked(commands.listComparisonChoices).mockResolvedValue({
    status: "ok",
    data: [],
  });
  vi.mocked(commands.listWorktreeDirectory).mockResolvedValue({
    status: "ok",
    data: { path: "", truncated: false, entries: [] },
  });
  vi.mocked(commands.getWorktreePrAssociation).mockResolvedValue({
    status: "ok",
    data: {
      status: "linked",
      branch: "feature/total",
      repo: "example/demo-repo",
      pr,
      staleError: null,
    },
  });
  vi.mocked(commands.getWorktreePrReviewThreads).mockResolvedValue({
    status: "ok",
    data: {
      status: "loaded",
      repo: "example/demo-repo",
      prNumber: 7,
      headOid: "1".repeat(40),
      baseOid: "2".repeat(40),
      threads,
      truncated: false,
    },
  });
  vi.mocked(commands.mapWorktreePrReviewThreads).mockResolvedValue({
    status: "ok",
    data: [
      at("t1", anchored(13)),
      at("old", { kind: "outdated", originalLine: 9, original: [] }),
    ],
  });
});

afterEach(() => resetWorktreePrStore());

describe("Review rail", () => {
  it("opens from the PR bar, lists threads by file and returns focus on Esc", async () => {
    renderChanges();
    const entry = await screen.findByRole("button", { name: "2 threads" });
    expect(commands.mapWorktreePrReviewThreads).toHaveBeenCalledWith(
      "/work/demo-repo",
      expect.objectContaining({
        headOid: "1".repeat(40),
        shownTarget: null,
        shownBase: COMPARISON.base_commit,
      })
    );
    entry.focus();
    await act(async () => fireEvent.click(entry));
    const rail = screen.getByRole("complementary", { name: "Review rail" });
    expect(rail).toHaveFocus();
    expect(entry).toHaveAttribute("aria-expanded", "true");
    expect(rail).toHaveTextContent("PR #7");
    expect(rail).toHaveTextContent("Threads · 2 open");
    expect(
      within(rail).getByRole("heading", { name: "lib.rs" })
    ).toBeInTheDocument();

    // The comparison has no diff for this file: the outdated thread opens
    // in the rail itself.
    const outdated = within(rail).getByRole("button", {
      name: /outdated · was line 9/,
    });
    expect(outdated).toHaveTextContent("bob: Stale note.");
    await act(async () => fireEvent.click(outdated));
    const card = within(rail).getByRole("region", {
      name: "GitHub thread from bob, outdated · was line 9",
    });
    expect(card).toHaveFocus();
    await act(async () => fireEvent.keyDown(card, { key: "Escape" }));
    expect(within(rail).queryByRole("region")).toBeNull();
    expect(outdated).toHaveFocus();

    await act(async () => fireEvent.keyDown(rail, { key: "Escape" }));
    expect(
      screen.queryByRole("complementary", { name: "Review rail" })
    ).toBeNull();
    expect(entry).toHaveFocus();
  });

  it("explains an empty rail when no PR is linked", async () => {
    vi.mocked(commands.getWorktreePrAssociation).mockResolvedValue({
      status: "ok",
      data: {
        status: "none",
        branch: "feature/total",
        repo: "example/demo-repo",
        createPrUrl:
          "https://github.com/example/demo-repo/compare/feature/total",
      },
    });
    useChatSideColumnStore
      .getState()
      .saveChanges("chat", "/work/demo-repo", { reviewOpen: true });
    renderChanges();
    const rail = await screen.findByRole("complementary", {
      name: "Review rail",
    });
    expect(rail).toHaveTextContent(
      "No linked PR, so there are no GitHub threads to list."
    );
    expect(commands.getWorktreePrReviewThreads).not.toHaveBeenCalled();
  });
});
