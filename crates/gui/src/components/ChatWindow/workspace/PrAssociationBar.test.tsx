import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  commands,
  type GithubErrorKind,
  type GithubPullRequest,
} from "../../../bindings";
import { useWorktreePr } from "../../../hooks/useWorktreePr";
import { pollWatchedPrsNow } from "../../../stores/prSync";
import { linkedPullRequest } from "../../../stores/worktreePrStore";
import {
  REPO,
  addPr,
  chatLink,
  chatSession,
  failure,
  fakeGithub,
  github,
  installFakeGithub,
  linkedPr,
  prLink,
  pullRequest,
  resetFakeGithub,
  seedChats,
  settle,
  type FakeGithub,
} from "../../../test/fakeGithub";
import { ChatHeader } from "../ChatHeader";
import { ChatHeaderPrChip } from "../GithubPr";
import { OPEN_PR_LIST_LIMIT } from "./ManualPrLink";
import { Bar } from "../../../test/prBar";
import { parsePrReference } from "./prReference";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../bindings", () => ({
  commands: {
    resolveWorktreeGithub: vi.fn(),
    pollGithubPrs: vi.fn(),
    listGithubOpenPrs: vi.fn(),
    getGithubPr: vi.fn(),
    rerunGithubPrCheck: vi.fn(),
    cancelGithubPrCheck: vi.fn(),
    getWorktreePublishedHead: vi.fn(),
  },
}));

const resolve = vi.mocked(commands.resolveWorktreeGithub);
const poll = vi.mocked(commands.pollGithubPrs);
const listOpen = vi.mocked(commands.listGithubOpenPrs);
const getPr = vi.mocked(commands.getGithubPr);

const BRANCH = "feature/retry";

const PR_482 = pullRequest(482, { title: "Reset retry budget after success" });
const PR_479 = pullRequest(479, {
  title: "Retry budget experiments",
  state: "draft",
  headRepo: "bob/demo-repo",
  author: "bob",
});

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const commandError = (
  message: string,
  kind: GithubErrorKind = "other",
  retryAfterSecs: number | null = null
) => ({
  status: "error" as const,
  error: failure(kind, message, retryAfterSecs),
});

const FAILURE_TEXT: [GithubErrorKind, number | null, string][] = [
  [
    "gh_missing",
    null,
    "GitHub CLI (gh) not found · install gh and run gh auth login to connect PRs",
  ],
  [
    "auth_expired",
    null,
    "GitHub authentication expired · run gh auth login in your terminal",
  ],
  ["rate_limited", 120, "GitHub rate limit reached · try again in 2 min"],
  ["not_found", null, "PR #482 was not found in example/demo-repo"],
  ["other", null, "Unexpected gh output"],
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A second consumer of the same worktree, like ChatWindow's header chip. */
function HeaderConsumer({
  worktreePath,
  branch = BRANCH,
}: {
  worktreePath: string;
  branch?: string | null;
}) {
  const pr = linkedPullRequest(useWorktreePr(worktreePath, branch).association);
  return pr ? <ChatHeaderPrChip pr={pr} /> : null;
}

let world: FakeGithub;

/** One chat on the branch, then its bar. */
function renderBar(worktreePath: string, branch = BRANCH) {
  seedChats(chatSession("chat", worktreePath, branch));
  return render(<Bar worktreePath={worktreePath} branch={branch} />);
}

/** One scheduled poll of every watched branch. */
async function tick() {
  await act(async () => {
    await pollWatchedPrsNow();
  });
  await settle();
}

async function openManualLink() {
  fireEvent.click(await screen.findByRole("button", { name: "Link PR…" }));
  return screen.getByRole("textbox", { name: "Pull request number or URL" });
}

const openButton = (number: number) =>
  screen.findByRole("button", { name: `Open PR #${number} on GitHub` });

describe("PrAssociationBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Only the interval is faked so Testing Library's polling still runs.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    world = fakeGithub();
    installFakeGithub(commands, world);
  });

  afterEach(() => {
    resetFakeGithub();
    vi.useRealTimers();
  });

  it("shows the linked PR and unlinks locally, handing focus to Link PR…", async () => {
    addPr(world, PR_482);
    renderBar("/wt/a");

    const open = await openButton(482);
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText(PR_482.title)).toBeInTheDocument();
    fireEvent.click(open);
    expect(openUrl).toHaveBeenCalledWith(PR_482.url);

    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(screen.getByTestId("pr-unlink-action"));

    expect(await screen.findByText(/No PR for/)).toBeInTheDocument();
    expect(chatLink("chat")?.pr).toBeNull();
    expect(screen.getByRole("button", { name: "Link PR…" })).toHaveFocus();
  });

  it("links the chosen candidate and focuses the linked PR", async () => {
    addPr(world, PR_482);
    addPr(world, PR_479);
    renderBar("/wt/ambiguous");

    expect(
      await screen.findByTestId("pr-ambiguous-chooser")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/2 open PRs in example\/demo-repo match/)
    ).toBeInTheDocument();
    expect(document.body).toHaveFocus();

    const row = screen.getByRole("button", { name: /Link locally: #479/ });
    expect(row).toHaveAccessibleName(/fork bob\/demo-repo/);
    row.focus();
    fireEvent.click(row);

    expect(await openButton(479)).toHaveFocus();
    expect(getPr).toHaveBeenCalledExactlyOnceWith(
      "/wt/ambiguous",
      BRANCH,
      "example/demo-repo",
      479
    );
    expect(chatLink("chat")?.pr?.number).toBe(479);
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("marks the fork by identity even when the author is unknown", async () => {
    addPr(world, PR_482);
    addPr(world, { ...PR_479, author: null });
    renderBar("/wt/fork");

    const row = await screen.findByRole("button", {
      name: /Link locally: #479/,
    });
    expect(within(row).getByText("fork bob/demo-repo")).toHaveClass("is-warn");
    expect(within(row).getByText("feature/retry → main")).not.toHaveClass(
      "is-warn"
    );
  });

  it("explains a single fork PR, which is never linked automatically", async () => {
    addPr(world, PR_479);
    renderBar("/wt/single");

    const bar = await screen.findByTestId("pr-ambiguous-chooser");
    expect(bar.parentElement).toHaveTextContent(
      "PR #479 for feature/retry is from fork bob/demo-repo, so it wasn’t linked automatically"
    );
    expect(bar.parentElement).not.toHaveTextContent(/PRs match/);
    expect(chatLink("chat")).toBeUndefined();
  });

  it("moves through the chooser with arrows, Home and End, and focuses the first row on explicit open", async () => {
    for (const pr of [PR_482, PR_479, pullRequest(470)]) addPr(world, pr);
    renderBar("/wt/keys");

    const toggle = await screen.findByRole("button", { name: "Hide chooser" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Choose PR…" }));

    const rows = screen.getAllByRole("button", { name: /Link locally: #/ });
    expect(rows[0]).toHaveFocus();
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.keyDown(rows[0], { key: "ArrowUp" });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(rows[1]).toHaveFocus();
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(rows[1], { key: "End" });
    expect(rows[2]).toHaveFocus();
    fireEvent.keyDown(rows[2], { key: "ArrowDown" });
    expect(rows[2]).toHaveFocus();
    fireEvent.keyDown(rows[2], { key: "Home" });
    expect(rows[0]).toHaveFocus();

    fireEvent.keyDown(rows[0], { key: "Escape" });
    expect(
      screen.queryByTestId("pr-ambiguous-chooser")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose PR…" })).toHaveFocus();
    expect(chatLink("chat")).toBeUndefined();
  });

  it("ignores a second mutation while the first link is pending", async () => {
    addPr(world, PR_482);
    addPr(world, PR_479);
    const pending = deferred<ReturnType<typeof ok<GithubPullRequest>>>();
    getPr.mockReturnValueOnce(pending.promise);
    renderBar("/wt/serial");

    const first = await screen.findByRole("button", {
      name: /Link locally: #482/,
    });
    first.focus();
    fireEvent.click(first);

    const keep = screen.getByRole("button", { name: "Keep unlinked" });
    const other = screen.getByRole("button", { name: /Link locally: #479/ });
    await waitFor(() => expect(keep).toHaveAttribute("aria-disabled", "true"));
    expect(other).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(keep);
    fireEvent.click(other);
    expect(chatLink("chat")).toBeUndefined();
    expect(getPr).toHaveBeenCalledTimes(1);
    expect(first).toHaveFocus();

    await act(async () => pending.resolve(ok(PR_482)));
    expect(await openButton(482)).toBeInTheDocument();
  });

  it("records Keep unlinked locally and focuses Link PR…", async () => {
    addPr(world, PR_482);
    addPr(world, PR_479);
    renderBar("/wt/keep-unlinked");

    const keep = await screen.findByRole("button", { name: "Keep unlinked" });
    keep.focus();
    fireEvent.click(keep);

    expect(await screen.findByText(/No PR for/)).toBeInTheDocument();
    expect(chatLink("chat")).toMatchObject({
      worktreePath: "/wt/keep-unlinked",
      branch: BRANCH,
      pr: null,
    });
    expect(screen.getByRole("button", { name: "Link PR…" })).toHaveFocus();
  });

  it("offers Create PR on GitHub and shows progress while Check again runs", async () => {
    world.worktrees.set("/wt/none", github("feature/new"));
    renderBar("/wt/none");

    fireEvent.click(
      await screen.findByRole("button", { name: "Create PR on GitHub" })
    );
    expect(openUrl).toHaveBeenCalledWith(
      `https://github.com/${REPO}/compare/feature%2Fnew?expand=1`
    );

    const pending =
      deferred<ReturnType<typeof ok<ReturnType<typeof github>>>>();
    resolve.mockReturnValueOnce(pending.promise);
    const check = screen.getByRole("button", { name: "Check again" });
    check.focus();
    fireEvent.click(check);
    expect(resolve).toHaveBeenLastCalledWith("/wt/none", BRANCH);
    await waitFor(() => expect(check).toHaveTextContent("Checking…"));
    expect(check).toHaveAttribute("aria-busy", "true");
    expect(check).toHaveFocus();

    addPr(world, PR_482);
    await act(async () => pending.resolve(ok(github("feature/new"))));
    expect(await openButton(482)).toHaveFocus();
  });

  it("waits for the user after gh_missing or auth_expired: no reads on remount or tick", async () => {
    world.failRemote.set(REPO, failure("gh_missing"));
    seedChats(chatSession("chat", "/wt/missing", BRANCH));
    const view = render(
      <>
        <HeaderConsumer worktreePath="/wt/missing" />
        <Bar worktreePath="/wt/missing" branch={BRANCH} />
      </>
    );
    expect(await screen.findByText(/GitHub CLI \(/)).toBeInTheDocument();
    const reads = poll.mock.calls.length;

    view.rerender(<HeaderConsumer worktreePath="/wt/missing" />);
    view.rerender(
      <>
        <HeaderConsumer worktreePath="/wt/missing" />
        <Bar worktreePath="/wt/missing" branch={BRANCH} />
      </>
    );
    await tick();
    expect(screen.getByText(/GitHub CLI \(/)).toBeInTheDocument();
    expect(poll).toHaveBeenCalledTimes(reads);
    view.unmount();
    resetFakeGithub();

    world.failRemote.set(REPO, failure("auth_expired", "Bad credentials"));
    renderBar("/wt/expired");
    await screen.findByText(/GitHub authentication expired/);
    expect(screen.getByRole("status")).toHaveTextContent(
      /GitHub authentication expired/
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const after = poll.mock.calls.length;
    await tick();
    expect(poll).toHaveBeenCalledTimes(after);
  });

  it("shares one lookup between two consumers of the same worktree", async () => {
    addPr(world, PR_482);
    const pending =
      deferred<ReturnType<typeof ok<ReturnType<typeof github>>>>();
    resolve.mockReturnValueOnce(pending.promise);
    seedChats(chatSession("chat", "/wt/shared", BRANCH));
    render(
      <>
        <HeaderConsumer worktreePath="/wt/shared" />
        <Bar worktreePath="/wt/shared" branch={BRANCH} />
      </>
    );
    expect(
      screen.getByText("Looking for a GitHub pull request…")
    ).toBeInTheDocument();

    await act(async () => pending.resolve(ok(github(BRANCH))));
    expect(await screen.findByTestId("chat-header-pr-chip")).toHaveTextContent(
      "#482"
    );
    expect(await openButton(482)).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledExactlyOnceWith("/wt/shared", BRANCH);
  });

  it("keys links per worktree and branch, never sharing across branches", async () => {
    addPr(world, PR_482);
    addPr(world, pullRequest(479, { headRef: "feature/other" }));
    seedChats(
      chatSession("main", "/wt/keyed", BRANCH),
      chatSession("other", "/wt/keyed", "feature/other")
    );
    const view = render(
      <>
        <HeaderConsumer worktreePath="/wt/keyed" />
        <Bar worktreePath="/wt/keyed" branch="feature/other" />
      </>
    );

    expect(await screen.findByTestId("chat-header-pr-chip")).toHaveTextContent(
      "#482"
    );
    expect(await openButton(479)).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(screen.getByTestId("pr-unlink-action"));
    expect(await screen.findByText(/No PR for/)).toBeInTheDocument();
    expect(chatLink("other")?.pr).toBeNull();
    expect(chatLink("main")?.pr?.number).toBe(482);
    expect(screen.getByTestId("chat-header-pr-chip")).toHaveTextContent("#482");
    view.unmount();

    render(<HeaderConsumer worktreePath="/wt/keyed" branch={null} />);
    await settle();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("takes a linked PR's state from the poll and keeps it through a failed poll", async () => {
    addPr(world, PR_482);
    renderBar("/wt/linked");
    await openButton(482);
    await settle();

    world.failPoll = failure("other", "Network offline");
    await tick();
    // Only the checks line reports it; the PR stays as last read.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t refresh: Network offline"
    );
    expect(await openButton(482)).toBeInTheDocument();

    // Background ticks wait out the backoff; Retry now reads at once.
    world.failPoll = null;
    addPr(world, { ...PR_482, state: "merged" });
    await tick();
    expect(screen.queryByText("Merged")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(await screen.findByText("Merged")).toBeInTheDocument();
    expect(chatLink("chat")?.pr?.state).toBe("merged");
  });

  it("refreshes the PR and its checks with one poll", async () => {
    addPr(world, PR_482);
    renderBar("/wt/errors");
    await openButton(482);
    await settle();
    const polls = poll.mock.calls.length;

    world.failPoll = failure("other", "GitHub is down");
    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh PR" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t refresh: GitHub is down"
    );
    expect(poll).toHaveBeenCalledTimes(polls + 1);
  });

  it("reads again after a background poll when Refresh PR lands during it", async () => {
    addPr(world, PR_482);
    renderBar("/wt/race");
    await openButton(482);
    await settle();

    // The background poll answers with what GitHub said before the refresh.
    const before = await commands.pollGithubPrs(poll.mock.calls.at(-1)![0]);
    const background = deferred<typeof before>();
    poll.mockReturnValueOnce(background.promise);
    const background_tick = pollWatchedPrsNow();
    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh PR" }));
    addPr(world, { ...PR_482, state: "merged" });
    await act(async () => {
      background.resolve(before);
      await background_tick;
    });
    expect(await screen.findByText("Merged")).toBeInTheDocument();
  });

  it("keeps the typed number and focus when a link fails", async () => {
    renderBar("/wt/link-fail");

    const input = await openManualLink();
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "482" } });
    fireEvent.click(screen.getByRole("button", { name: "Link locally" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PR #482 was not found"
    );
    expect(getPr).toHaveBeenCalledExactlyOnceWith(
      "/wt/link-fail",
      BRANCH,
      null,
      482
    );
    expect(input).toHaveValue("482");
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute("readonly");
  });

  it("validates the manual entry and passes a URL's repo for the backend to check", async () => {
    getPr.mockResolvedValue(commandError("stop here"));
    renderBar("/wt/validate");
    const input = await openManualLink();
    const submit = () =>
      fireEvent.submit(input.closest("form") as HTMLFormElement);

    fireEvent.change(input, { target: { value: "abc" } });
    submit();
    const error = await screen.findByText(/Enter a PR number like 482/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
    expect(getPr).not.toHaveBeenCalled();

    for (const [value, number, repo] of [
      ["0482", 482, null],
      ["#17", 17, null],
      [`https://github.com/${REPO}/pull/479/files`, 479, REPO],
      ["https://github.com/other/repo/pull/12", 12, "other/repo"],
    ] as const) {
      fireEvent.change(input, { target: { value } });
      submit();
      await waitFor(() =>
        expect(getPr).toHaveBeenLastCalledWith(
          "/wt/validate",
          BRANCH,
          repo,
          number
        )
      );
      await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
    }
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("closes the manual panel with Escape and returns focus to Link PR…", async () => {
    renderBar("/wt/escape");
    const input = await openManualLink();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByTestId("pr-manual-link-panel")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link PR…" })).toHaveFocus();
  });

  it("retries a failed open-PR lookup while the number field stays usable", async () => {
    listOpen.mockRejectedValueOnce(new Error("Network offline"));
    renderBar("/wt/manual-retry");
    const input = await openManualLink();

    expect(
      await screen.findByText(/Couldn’t load open PRs: Network offline/)
    ).toBeInTheDocument();
    expect(input).not.toHaveAttribute("readonly");

    // Another branch's PR, so this branch stays unlinked.
    addPr(world, pullRequest(482, { headRef: "feature/elsewhere" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("PR title 482")).toBeInTheDocument();
  });

  it("says when the open-PR list is cut short or empty", async () => {
    const many = Array.from({ length: OPEN_PR_LIST_LIMIT + 2 }, (_, index) =>
      pullRequest(500 + index)
    );
    listOpen.mockResolvedValueOnce(ok(many)).mockResolvedValueOnce(ok([]));
    renderBar("/wt/list");

    await openManualLink();
    expect(
      await screen.findByText(
        `Showing ${OPEN_PR_LIST_LIMIT} of ${many.length} open PRs · enter a number to link another`
      )
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("list", { name: `Open pull requests in ${REPO}` })
      ).getAllByRole("button")
    ).toHaveLength(OPEN_PR_LIST_LIMIT);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openManualLink();
    expect(
      await screen.findByText(`No open PRs in ${REPO}.`)
    ).toBeInTheDocument();
  });

  it("renders unavailable with Check again and hides not-applicable worktrees", async () => {
    world.failRemote.set(REPO, failure("other", "GitHub API timed out"));
    const view = renderBar("/wt/unavailable");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Couldn’t check GitHub PR: GitHub API timed out"
    );
    world.failRemote.clear();
    addPr(world, PR_482);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await openButton(482)).toBeInTheDocument();
    view.unmount();

    world.worktrees.set("/wt/no-remote", {
      status: "not_applicable",
      branch: null,
      reason: "No GitHub remote configured for this repository",
    });
    renderBar("/wt/no-remote");
    await waitFor(() =>
      expect(screen.queryByTestId("pr-association-bar")).not.toBeInTheDocument()
    );
  });

  it("shows a chat's PR read-only when its worktree is not on this machine", async () => {
    world.worktrees.set("/elsewhere/wt", {
      status: "not_applicable",
      branch: null,
      reason: "Not a git repository",
    });
    seedChats(
      chatSession("synced", "/elsewhere/wt", BRANCH, {
        link: prLink(
          "/elsewhere/wt",
          BRANCH,
          linkedPr(PR_482, { title: "", state: null }),
          null
        ),
      })
    );
    render(<Bar worktreePath="/elsewhere/wt" branch={BRANCH} />);

    expect(await openButton(482)).toBeInTheDocument();
    expect(
      await screen.findByText("Worktree not on this machine")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    expect(screen.queryByTestId("pr-unlink-action")).not.toBeInTheDocument();
    await tick();
    expect(poll).not.toHaveBeenCalled();
  });

  it.each(FAILURE_TEXT)(
    "shows a %s link failure once, with recovery copy and no retry",
    async (kind, retryAfterSecs, text) => {
      getPr.mockResolvedValue(
        commandError(
          kind === "not_found" || kind === "other" ? text : `${kind} raw`,
          kind,
          retryAfterSecs
        )
      );
      renderBar(`/wt/link-${kind}`);
      const input = await openManualLink();
      fireEvent.change(input, { target: { value: "482" } });
      fireEvent.click(screen.getByRole("button", { name: "Link locally" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(
        screen.getAllByRole("button", { name: "Check again" })
      ).toHaveLength(1);
      await tick();
      expect(getPr).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  );

  it.each(FAILURE_TEXT)(
    "shows a %s open-PR list failure with a manual Retry",
    async (kind, retryAfterSecs, text) => {
      listOpen.mockResolvedValueOnce(
        commandError(
          kind === "not_found" || kind === "other" ? text : `${kind} raw`,
          kind,
          retryAfterSecs
        )
      );
      renderBar(`/wt/list-${kind}`);
      await openManualLink();

      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Couldn’t load open PRs: ${text}`
      );
      expect(listOpen).toHaveBeenCalledTimes(1);
      addPr(world, pullRequest(482, { headRef: "feature/elsewhere" }));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("PR title 482")).toBeInTheDocument();
      expect(listOpen).toHaveBeenCalledTimes(2);
    }
  );

  it("offers Check again beside a gh setup failure when the bar has none", async () => {
    addPr(world, PR_482);
    addPr(world, PR_479);
    getPr.mockResolvedValueOnce(commandError("raw", "auth_expired"));
    renderBar("/wt/ambiguous-auth");
    fireEvent.click(
      await screen.findByRole("button", { name: /Link locally: #482/ })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub authentication expired · run gh auth login in your terminal"
    );

    world.prs.delete("example/demo-repo#479");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(resolve).toHaveBeenLastCalledWith("/wt/ambiguous-auth", BRANCH);
    expect(await openButton(482)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed first lookup with Check again instead of a spinner", async () => {
    world.worktrees.set("/wt/first-fail", failure("rate_limited", "raw", 30));
    renderBar("/wt/first-fail");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Couldn’t check GitHub PR: GitHub rate limit reached · try again in 30s"
    );
    expect(
      screen.queryByText("Looking for a GitHub pull request…")
    ).not.toBeInTheDocument();
    await tick();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("links a candidate upstream with that repo, a typed number with null", async () => {
    const UPSTREAM = "upstream/demo";
    const fork = github(BRANCH, {
      baseRepo: UPSTREAM,
      searchRepos: [UPSTREAM, REPO],
    });
    const upstream = (number: number) =>
      pullRequest(number, {
        owner: "upstream",
        repo: "demo",
        url: `https://github.com/${UPSTREAM}/pull/${number}`,
      });
    addPr(world, upstream(91));
    addPr(world, upstream(92));
    world.worktrees.set("/wt/repos", fork);
    getPr.mockResolvedValue(commandError("stop here"));
    const view = renderBar("/wt/repos");

    fireEvent.click(
      await screen.findByRole("button", { name: /Link locally: #91/ })
    );
    await waitFor(() =>
      expect(getPr).toHaveBeenLastCalledWith("/wt/repos", BRANCH, UPSTREAM, 91)
    );
    view.unmount();

    renderBar("/wt/typed");
    const input = await openManualLink();
    fireEvent.change(input, { target: { value: "#91" } });
    fireEvent.click(screen.getByRole("button", { name: "Link locally" }));
    await waitFor(() =>
      expect(getPr).toHaveBeenLastCalledWith("/wt/typed", BRANCH, null, 91)
    );
    expect(getPr).toHaveBeenCalledTimes(2);
  });

  it("shows the backend's rejection of a URL from a repo that isn't a remote", async () => {
    getPr.mockResolvedValue(
      commandError("other/repo is not a GitHub remote of this worktree")
    );
    renderBar("/wt/foreign");
    const input = await openManualLink();
    fireEvent.change(input, {
      target: { value: "https://github.com/other/repo/pull/12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link locally" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "other/repo is not a GitHub remote of this worktree"
    );
    expect(getPr).toHaveBeenCalledExactlyOnceWith(
      "/wt/foreign",
      BRANCH,
      "other/repo",
      12
    );
    expect(input).toHaveValue("https://github.com/other/repo/pull/12");
  });

  it("does not open non-http(s) PR URLs", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    addPr(world, { ...PR_482, url: "file:///etc/passwd" });
    renderBar("/wt/bad-url");
    expect(await screen.findByText("#482")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open PR #482 on GitHub" })
    ).not.toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("asks before linking a newer PR after the linked one merged", async () => {
    seedChats(
      chatSession("chat", "/wt/merged", BRANCH, {
        link: prLink(
          "/wt/merged",
          BRANCH,
          linkedPr({ ...PR_482, state: "merged" })
        ),
      })
    );
    addPr(world, { ...PR_482, state: "merged" });
    addPr(world, pullRequest(490, { title: "Follow-up" }));
    render(<Bar worktreePath="/wt/merged" branch={BRANCH} />);

    const prompt = await screen.findByTestId("pr-newer-prompt");
    expect(prompt).toHaveTextContent(
      "PR #482 was merged. Link the newer #490?"
    );
    expect(chatLink("chat")?.pr?.number).toBe(482);

    fireEvent.click(within(prompt).getByRole("button", { name: "Link #490" }));
    expect(await openButton(490)).toBeInTheDocument();
    expect(chatLink("chat")?.pr?.number).toBe(490);
    expect(screen.queryByTestId("pr-newer-prompt")).not.toBeInTheDocument();
  });

  it("keeps the merged PR when the newer one is declined", async () => {
    seedChats(
      chatSession("chat", "/wt/keep-merged", BRANCH, {
        link: prLink(
          "/wt/keep-merged",
          BRANCH,
          linkedPr({ ...PR_482, state: "merged" })
        ),
      })
    );
    addPr(world, pullRequest(490));
    render(<Bar worktreePath="/wt/keep-merged" branch={BRANCH} />);

    fireEvent.click(await screen.findByRole("button", { name: "Keep #482" }));
    expect(screen.queryByTestId("pr-newer-prompt")).not.toBeInTheDocument();
    await tick();
    expect(screen.queryByTestId("pr-newer-prompt")).not.toBeInTheDocument();
    expect(chatLink("chat")?.pr?.number).toBe(482);
  });
});

describe("ChatHeader PR chip", () => {
  const header = {
    label: "Chat",
    attention: { state: "idle", reason: null, since: null },
    isClosing: false,
    canStopGeneration: false,
    onClearMessages: vi.fn(),
    onStopGeneration: vi.fn(),
  } as const;

  it("routes to Changes when a handler is given and is static otherwise", () => {
    const onOpenPrInChanges = vi.fn();
    const pr = linkedPr(PR_482);
    const view = render(
      <ChatHeader
        {...header}
        linkedPr={pr}
        onOpenPrInChanges={onOpenPrInChanges}
      />
    );
    const chip = screen.getByRole("button", {
      name: /^PR #482 · Open · .*\. Review in Changes$/,
    });
    expect(chip).toHaveAttribute(
      "title",
      expect.stringMatching(/PR #482 · Open/)
    );
    expect(chip).not.toHaveAttribute("aria-pressed");
    expect(chip).toHaveTextContent("#482");
    fireEvent.click(chip);
    expect(onOpenPrInChanges).toHaveBeenCalledTimes(1);

    // Once the PR's threads are read, the chip counts the unresolved ones.
    view.rerender(
      <ChatHeader
        {...header}
        linkedPr={pr}
        linkedPrOpenThreads={2}
        onOpenPrInChanges={onOpenPrInChanges}
      />
    );
    expect(
      screen.getByRole("button", {
        name: /^PR #482 · Open · .* · 2 open threads\. Review in Changes$/,
      })
    ).toHaveTextContent(/#482.*2$/);

    view.rerender(<ChatHeader {...header} linkedPr={pr} />);
    expect(screen.getByTestId("chat-header-pr-chip").tagName).toBe("SPAN");

    view.rerender(<ChatHeader {...header} linkedPr={null} />);
    expect(screen.queryByTestId("chat-header-pr-chip")).not.toBeInTheDocument();
  });

  it("names only the number of a link not yet read from GitHub", () => {
    render(
      <ChatHeader
        {...header}
        linkedPr={linkedPr(PR_482, { title: "", state: null })}
      />
    );
    expect(screen.getByTestId("chat-header-pr-chip")).toHaveAttribute(
      "title",
      "PR #482"
    );
  });
});

describe("parsePrReference", () => {
  it.each([
    ["482", 482, null],
    [" #482 ", 482, null],
    ["0482", 482, null],
    [`https://github.com/${REPO}/pull/9`, 9, REPO],
    [
      `https://github.com/EXAMPLE/Demo-Repo/pull/9#discussion`,
      9,
      "EXAMPLE/Demo-Repo",
    ],
    ["https://github.com/a/b/pull/9", 9, "a/b"],
  ])("reads %j as #%i in %s", (input, number, repo) => {
    expect(parsePrReference(input, REPO)).toEqual({ ok: true, number, repo });
  });

  it.each([
    ["", /Enter a PR number/],
    ["0", /start at 1/],
    ["99999999999", /too large/],
    ["#abc", /Enter a PR number like 482/],
    [`https://github.com/${REPO}/issues/9`, /isn’t a pull request URL/],
    ["https://github.com/a/b/pull/x", /isn’t a pull request URL/],
  ])("rejects %j", (input, message) => {
    const parsed = parsePrReference(input, REPO);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(message);
  });
});
