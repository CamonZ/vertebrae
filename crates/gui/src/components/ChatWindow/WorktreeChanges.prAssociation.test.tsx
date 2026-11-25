import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  type GithubPullRequest,
  type WorktreeChanges as Changes,
} from "../../bindings";
import { resetWorktreePrChecksStore } from "../../stores/worktreePrChecksStore";
import { resetWorktreePrStore } from "../../stores/worktreePrStore";
import { WorktreeChanges } from "./WorktreeChanges";
import { useWorktreeWatch } from "./workspace/useWorktreeWatch";

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
    getWorktreePrChecks: vi.fn().mockResolvedValue({
      status: "error",
      error: { kind: "not_found", message: "no PR", retryAfterSecs: null },
    }),
    getWorktreePublishedHead: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: null }),
  },
}));

const load = vi.mocked(commands.loadWorktreeChanges);
const getAssociation = vi.mocked(commands.getWorktreePrAssociation);

function changesAt(head: string): Changes {
  return {
    base_branch: "refs/heads/main",
    base_unavailable: null,
    comparison: {
      base_commit: "base-sha",
      selected_base_commit: "base-sha",
      target_commit: head,
      working_tree: true,
      merge_base: true,
    },
    totals: { additions: 0, deletions: 0, binary_files: 0 },
    files: [],
  };
}

function pullRequest(number: number, headRef: string): GithubPullRequest {
  return {
    owner: "example",
    repo: "demo-repo",
    number,
    title: `PR ${number}`,
    state: "open",
    headRef,
    headRepo: "example/demo-repo",
    baseRef: "main",
    url: `https://github.com/example/demo-repo/pull/${number}`,
    author: null,
    updatedAt: null,
  };
}

function linkedOn(branch: string, number: number) {
  return {
    status: "ok" as const,
    data: {
      status: "linked" as const,
      branch,
      repo: "example/demo-repo",
      pr: pullRequest(number, branch),
      staleError: null,
    },
  };
}

function watcherReload() {
  const calls = vi.mocked(useWorktreeWatch).mock.calls;
  act(() => calls[calls.length - 1][1]());
}

describe("WorktreeChanges PR association", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.listComparisonChoices).mockResolvedValue({
      status: "ok",
      data: [],
    });
    vi.mocked(commands.listWorktreeDirectory).mockResolvedValue({
      status: "ok",
      data: { path: "", truncated: false, entries: [] },
    });
  });

  afterEach(() => {
    resetWorktreePrChecksStore();
    resetWorktreePrStore();
  });

  it("looks up the pinned branch once and never re-discovers on reloads or commits", async () => {
    load.mockResolvedValue({ status: "ok", data: changesAt("sha-a") });
    getAssociation.mockResolvedValue(linkedOn("feature/a", 482));

    render(
      <WorktreeChanges
        sessionId="chat"
        worktreePath="/wt"
        prBranch="feature/a"
      />
    );
    expect(
      await screen.findByRole("button", { name: "Open PR #482 on GitHub" })
    ).toBeInTheDocument();
    expect(getAssociation).toHaveBeenCalledExactlyOnceWith(
      "/wt",
      "feature/a",
      false
    );

    // A file edit, then a checkout of another branch at a new commit.
    watcherReload();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    load.mockResolvedValue({ status: "ok", data: changesAt("sha-b") });
    watcherReload();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(
      screen.getByRole("button", { name: "Open PR #482 on GitHub" })
    ).toBeInTheDocument();
    expect(getAssociation).toHaveBeenCalledTimes(1);
  });

  it("shows no PR bar and asks nothing without a pinned branch", async () => {
    load.mockResolvedValue({ status: "ok", data: changesAt("sha-a") });
    getAssociation.mockResolvedValue(linkedOn("feature/a", 482));

    render(<WorktreeChanges sessionId="chat" worktreePath="/wt" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByTestId("pr-association-bar")).not.toBeInTheDocument();
    expect(getAssociation).not.toHaveBeenCalled();
  });
});
