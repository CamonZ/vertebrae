import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type WorktreeChanges as Changes } from "../../bindings";
import {
  addPr,
  chatSession,
  fakeGithub,
  installFakeGithub,
  linkedPr,
  prLink,
  pullRequest,
  resetFakeGithub,
  seedChats,
} from "../../test/fakeGithub";
import { focusedPaletteScopes } from "../CommandPalette/paletteScopes";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
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
    resolveWorktreeGithub: vi.fn(),
    pollGithubPrs: vi.fn(),
    listGithubOpenPrs: vi.fn(),
    getGithubPr: vi.fn(),
    rerunGithubPrCheck: vi.fn(),
    cancelGithubPrCheck: vi.fn(),
    getWorktreePublishedHead: vi.fn(),
  },
}));

const load = vi.mocked(commands.loadWorktreeChanges);
const resolve = vi.mocked(commands.resolveWorktreeGithub);

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
    const world = fakeGithub();
    const pr = pullRequest(482, { headRef: "feature/a" });
    addPr(world, pr);
    installFakeGithub(commands, world);
    seedChats(
      chatSession("chat", "/wt", "feature/a", {
        link: prLink("/wt", "feature/a", linkedPr(pr)),
      })
    );
  });

  afterEach(() => {
    resetFakeGithub();
  });

  it("resolves the pinned branch once and never again on reloads or commits", async () => {
    load.mockResolvedValue({ status: "ok", data: changesAt("sha-a") });

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
    expect(resolve).toHaveBeenCalledExactlyOnceWith("/wt", "feature/a");

    // A file edit, then a checkout of another branch at a new commit.
    watcherReload();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    load.mockResolvedValue({ status: "ok", data: changesAt("sha-b") });
    watcherReload();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(
      screen.getByRole("button", { name: "Open PR #482 on GitHub" })
    ).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("offers the PR bar's actions in the Changes palette", async () => {
    load.mockResolvedValue({ status: "ok", data: changesAt("sha-a") });
    render(
      <WorktreeChanges
        sessionId="chat"
        worktreePath="/wt"
        prBranch="feature/a"
      />
    );
    const toggle = await screen.findByTestId("pr-checks-toggle");
    const prEntries = () => {
      const { contexts, initial } = focusedPaletteScopes(toggle);
      act(() =>
        useCommandPaletteStore.getState().openPalette(initial, contexts)
      );
      const items =
        useCommandPaletteStore
          .getState()
          .contexts.find((scope) => scope.id === "changes")
          ?.items.filter((item) => item.id.startsWith("changes-pr-")) ?? [];
      act(() => useCommandPaletteStore.getState().closePalette());
      return items;
    };

    const items = prEntries();
    expect(items.map((item) => [item.label, item.hint])).toEqual([
      ["Show PR checks", "#482"],
      ["Refresh PR", "#482"],
      ["Open PR on GitHub", "#482"],
      ["Unlink PR (local only)", "#482"],
    ]);
    await act(async () => {
      await items[0].run();
    });
    expect(screen.getByTestId("pr-checks-drawer")).toBeInTheDocument();
    expect(prEntries()[0].label).toBe("Hide PR checks");
  });

  it("shows no PR bar and asks nothing without a pinned branch", async () => {
    load.mockResolvedValue({ status: "ok", data: changesAt("sha-a") });

    render(<WorktreeChanges sessionId="chat" worktreePath="/wt" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(screen.queryByTestId("pr-association-bar")).not.toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });
});
