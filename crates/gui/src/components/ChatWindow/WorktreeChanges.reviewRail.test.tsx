import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type WorktreeChanges as Changes } from "../../bindings";
import { useChatSideColumnStore } from "../../stores/chatSideColumnStore";
import {
  addPr,
  chatSession,
  fakeGithub,
  installFakeGithub,
  linkedPr,
  prLink,
  prId,
  pullRequest,
  resetFakeGithub,
  seedChats,
  failure,
  settle,
  type FakeGithub,
} from "../../test/fakeGithub";
import { WorktreeChanges } from "./WorktreeChanges";
import {
  anchored,
  at,
  outdated,
  reviewThread,
} from "./workspace/githubReview/fixture";

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
    getGithubPrReviewThreads: vi.fn(),
    mapWorktreePrReviewThreads: vi.fn(),
  },
}));

const WORKTREE = "/work/demo-repo";
const BRANCH = "feature/total";
const pr = pullRequest(7, { headRef: BRANCH, title: "Total fix" });

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

let world: FakeGithub;

function renderChanges() {
  return render(
    <WorktreeChanges
      sessionId="chat"
      worktreePath={WORKTREE}
      prBranch={BRANCH}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatSideColumnStore.getState().forget();
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
  world = fakeGithub();
  addPr(world, pr);
  world.reviewThreads.set(prId("example/demo-repo", 7), threads);
  installFakeGithub(commands, world);
  seedChats(
    chatSession("chat", WORKTREE, BRANCH, {
      link: prLink(WORKTREE, BRANCH, linkedPr(pr)),
    })
  );
  vi.mocked(commands.mapWorktreePrReviewThreads).mockResolvedValue({
    status: "ok",
    data: [at("t1", anchored(13)), at("old", outdated(9, "let x = 0;"))],
  });
});

afterEach(() => resetFakeGithub());

describe("Review rail", () => {
  it("opens from the PR bar, lists threads by file and returns focus on Esc", async () => {
    renderChanges();
    const entry = await screen.findByRole("button", {
      name: /^2 open threads/,
    });
    expect(commands.getGithubPrReviewThreads).toHaveBeenCalledWith(
      WORKTREE,
      BRANCH,
      "example/demo-repo",
      7,
      false
    );
    // Placed once the comparison is loaded, locally.
    await waitFor(() =>
      expect(commands.mapWorktreePrReviewThreads).toHaveBeenCalledWith(
        WORKTREE,
        expect.objectContaining({
          headOid: "1".repeat(40),
          shownTarget: null,
          shownBase: COMPARISON.base_commit,
        })
      )
    );
    await settle();
    entry.focus();
    await act(async () => fireEvent.click(entry));
    const rail = screen.getByRole("complementary", { name: "Review rail" });
    expect(rail).toHaveFocus();
    expect(entry).toHaveAttribute("aria-expanded", "true");
    expect(rail).toHaveTextContent("PR #7");
    expect(rail).toHaveTextContent("Threads·2 open");
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
    expect(
      within(rail).queryByRole("region", { name: /^GitHub thread from/ })
    ).toBeNull();
    expect(outdated).toHaveFocus();

    // The PR's checks follow its threads.
    expect(
      within(rail).getByRole("region", { name: /^Checks/ })
    ).toBeInTheDocument();

    await act(async () => fireEvent.keyDown(rail, { key: "Escape" }));
    expect(
      screen.queryByRole("complementary", { name: "Review rail" })
    ).toBeNull();
    expect(entry).toHaveFocus();
  });

  it("says why the checks are missing when GitHub could not be read", async () => {
    world.failRemote.set(
      "example/demo-repo",
      failure("auth_expired", "gh auth expired")
    );
    useChatSideColumnStore
      .getState()
      .saveChanges("chat", WORKTREE, { reviewOpen: true });
    renderChanges();
    const rail = await screen.findByRole("complementary", {
      name: "Review rail",
    });
    await settle(20);
    const checks = within(rail).getByRole("region", { name: /^Checks/ });
    expect(within(checks).getByRole("alert")).toHaveTextContent(
      /Couldn’t read checks/
    );
    expect(within(checks).queryByText("Reading checks…")).toBeNull();
  });

  it("explains an empty rail when no PR is linked", async () => {
    // The user unlinked the branch.
    seedChats(
      chatSession("chat", WORKTREE, BRANCH, {
        link: prLink(WORKTREE, BRANCH, null),
      })
    );
    useChatSideColumnStore
      .getState()
      .saveChanges("chat", WORKTREE, { reviewOpen: true });
    renderChanges();
    const rail = await screen.findByRole("complementary", {
      name: "Review rail",
    });
    expect(rail).toHaveTextContent(
      "No linked PR, so there are no GitHub threads to list."
    );
    expect(commands.getGithubPrReviewThreads).not.toHaveBeenCalled();
  });
});
