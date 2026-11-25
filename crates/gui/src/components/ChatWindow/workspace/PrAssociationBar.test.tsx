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
  type GithubFailure,
  type GithubPullRequest,
  type WorktreePrAssociation,
  type WorktreePrPollBatch,
} from "../../../bindings";
import { useWorktreePrAssociation } from "../../../hooks/useWorktreePrAssociation";
import {
  linkedPullRequest,
  resetWorktreePrStore,
  useWorktreePrStore,
  worktreePrKey,
} from "../../../stores/worktreePrStore";
import {
  pollWatchedWorktreePrsNow,
  resetWorktreePrChecksStore,
} from "../../../stores/worktreePrChecksStore";
import { ChatHeader } from "../ChatHeader";
import { ChatHeaderPrChip } from "../GithubPr";
import { OPEN_PR_LIST_LIMIT } from "./ManualPrLink";
import { PrAssociationBar } from "./PrAssociationBar";
import { parsePrReference } from "./prReference";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../bindings", () => ({
  commands: {
    getWorktreePrAssociation: vi.fn(),
    listWorktreeOpenPrs: vi.fn(),
    linkWorktreePr: vi.fn(),
    unlinkWorktreePr: vi.fn(),
    pollWorktreePrs: vi.fn(),
    rerunWorktreePrCheck: vi.fn(),
    cancelWorktreePrCheck: vi.fn(),
    getWorktreePublishedHead: vi.fn(),
  },
}));

const getAssociation = vi.mocked(commands.getWorktreePrAssociation);
const listOpen = vi.mocked(commands.listWorktreeOpenPrs);
const link = vi.mocked(commands.linkWorktreePr);
const unlink = vi.mocked(commands.unlinkWorktreePr);
const poll = vi.mocked(commands.pollWorktreePrs);
const publishedHead = vi.mocked(commands.getWorktreePublishedHead);

const REPO = "example/demo-repo";
const BRANCH = "feature/retry";

function pullRequest(
  number: number,
  overrides: Partial<GithubPullRequest> = {}
): GithubPullRequest {
  return {
    owner: "example",
    repo: "demo-repo",
    number,
    title: `PR title ${number}`,
    state: "open",
    headRef: BRANCH,
    headRepo: REPO,
    baseRef: "main",
    url: `https://github.com/${REPO}/pull/${number}`,
    author: "alice",
    updatedAt: "2026-11-24T12:00:00Z",
    ...overrides,
  };
}

const PR_482 = pullRequest(482, { title: "Reset retry budget after success" });
const PR_479 = pullRequest(479, {
  title: "Retry budget experiments",
  state: "draft",
  headRepo: "bob/demo-repo",
  author: "bob",
});

const linked = (
  pr: GithubPullRequest,
  staleError: GithubFailure | null = null
): WorktreePrAssociation => ({
  status: "linked",
  branch: BRANCH,
  repo: REPO,
  pr,
  staleError,
});
const none = (branch = BRANCH): WorktreePrAssociation => ({
  status: "none",
  branch,
  repo: REPO,
  createPrUrl: `https://github.com/${REPO}/compare/${encodeURIComponent(branch)}?expand=1`,
});
const ambiguous = (
  candidates: GithubPullRequest[] = [PR_482, PR_479]
): WorktreePrAssociation => ({
  status: "ambiguous",
  branch: BRANCH,
  repo: REPO,
  candidates,
});

const ok = <T,>(data: T) => ({ status: "ok" as const, data });
type AssociationResult = ReturnType<typeof ok<WorktreePrAssociation>>;
const failure = (
  kind: GithubErrorKind,
  message = `${kind} failure`,
  retryAfterSecs: number | null = null
): GithubFailure => ({ kind, message, retryAfterSecs });
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
  const pr = linkedPullRequest(
    useWorktreePrAssociation(worktreePath, branch).association
  );
  return pr ? <ChatHeaderPrChip pr={pr} /> : null;
}

/** What GitHub says on the next poll; the stored association by default. */
let polledAssociation: (
  worktreePath: string,
  branch: string
) => WorktreePrAssociation | null = (worktreePath, branch) =>
  useWorktreePrStore.getState().entries[worktreePrKey(worktreePath, branch)]
    ?.association ?? null;

function pollAnswer(targets: { worktreePath: string; branch: string }[]) {
  return ok<WorktreePrPollBatch>({
    results: targets.map((target) => {
      const association = polledAssociation(target.worktreePath, target.branch);
      const pr = linkedPullRequest(association);
      return {
        ...target,
        result:
          association && pr
            ? {
                status: "linked" as const,
                association,
                checks: {
                  prNumber: pr.number,
                  repo: REPO,
                  headSha: "abc1234",
                  checks: [],
                  truncated: false,
                },
              }
            : { status: "not_linked" as const },
      };
    }),
    holdOffSecs: null,
  });
}

/** One scheduled poll of every watched branch. */
async function tickRevalidation() {
  await act(async () => {
    await pollWatchedWorktreePrsNow();
  });
}

async function openManualLink() {
  fireEvent.click(await screen.findByRole("button", { name: "Link PR…" }));
  return screen.getByRole("textbox", { name: "Pull request number or URL" });
}

describe("PrAssociationBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Only the interval is faked so Testing Library's polling still runs.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    listOpen.mockResolvedValue(ok([PR_482]));
    polledAssociation = (worktreePath, branch) =>
      useWorktreePrStore.getState().entries[worktreePrKey(worktreePath, branch)]
        ?.association ?? null;
    poll.mockImplementation(async (targets) => pollAnswer(targets));
    publishedHead.mockResolvedValue(ok(null));
  });

  afterEach(() => {
    resetWorktreePrChecksStore();
    resetWorktreePrStore();
    vi.useRealTimers();
  });

  it("shows the linked PR and unlinks locally, handing focus to Link PR…", async () => {
    getAssociation.mockResolvedValue(ok(linked(PR_482)));
    unlink.mockResolvedValue(ok(none()));

    render(<PrAssociationBar worktreePath="/wt/a" branch={BRANCH} />);

    const open = await screen.findByRole("button", {
      name: "Open PR #482 on GitHub",
    });
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText(PR_482.title)).toBeInTheDocument();
    fireEvent.click(open);
    expect(openUrl).toHaveBeenCalledWith(PR_482.url);

    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(screen.getByTestId("pr-unlink-action"));

    expect(await screen.findByText(/No PR for/)).toBeInTheDocument();
    expect(unlink).toHaveBeenCalledExactlyOnceWith("/wt/a", BRANCH);
    expect(screen.getByRole("button", { name: "Link PR…" })).toHaveFocus();
  });

  it("links the chosen candidate and focuses the linked PR", async () => {
    getAssociation.mockResolvedValue(ok(ambiguous()));
    link.mockResolvedValue(ok(linked(PR_479)));

    render(<PrAssociationBar worktreePath="/wt/ambiguous" branch={BRANCH} />);

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

    expect(
      await screen.findByRole("button", { name: "Open PR #479 on GitHub" })
    ).toHaveFocus();
    expect(link).toHaveBeenCalledExactlyOnceWith(
      "/wt/ambiguous",
      BRANCH,
      479,
      "example/demo-repo"
    );
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("marks the fork by identity even when the author is unknown", async () => {
    getAssociation.mockResolvedValue(
      ok(ambiguous([PR_482, { ...PR_479, author: null }]))
    );
    render(<PrAssociationBar worktreePath="/wt/fork" branch={BRANCH} />);

    const row = await screen.findByRole("button", {
      name: /Link locally: #479/,
    });
    expect(within(row).getByText("fork bob/demo-repo")).toHaveClass("is-warn");
    expect(within(row).getByText("feature/retry → main")).not.toHaveClass(
      "is-warn"
    );
  });

  it("explains a single candidate that was not linked automatically", async () => {
    getAssociation.mockResolvedValue(ok(ambiguous([PR_479])));
    render(<PrAssociationBar worktreePath="/wt/single" branch={BRANCH} />);

    const bar = await screen.findByTestId("pr-ambiguous-chooser");
    expect(bar.parentElement).toHaveTextContent(
      "PR #479 for feature/retry is from fork bob/demo-repo, so it wasn’t linked automatically"
    );
    expect(bar.parentElement).not.toHaveTextContent(/PRs match/);
  });

  it("moves through the chooser with arrows, Home and End, and focuses the first row on explicit open", async () => {
    const PR_470 = pullRequest(470);
    getAssociation.mockResolvedValue(ok(ambiguous([PR_482, PR_479, PR_470])));
    render(<PrAssociationBar worktreePath="/wt/keys" branch={BRANCH} />);

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
    expect(unlink).not.toHaveBeenCalled();
  });

  it("ignores a second mutation while the first link is pending", async () => {
    getAssociation.mockResolvedValue(ok(ambiguous()));
    const pending = deferred<AssociationResult>();
    link.mockReturnValue(pending.promise);

    render(<PrAssociationBar worktreePath="/wt/serial" branch={BRANCH} />);
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
    expect(unlink).not.toHaveBeenCalled();
    expect(link).toHaveBeenCalledTimes(1);
    expect(first).toHaveFocus();

    await act(async () => pending.resolve(ok(linked(PR_482))));
    expect(
      await screen.findByRole("button", { name: "Open PR #482 on GitHub" })
    ).toBeInTheDocument();
  });

  it("records Keep unlinked locally and focuses Link PR…", async () => {
    getAssociation.mockResolvedValue(ok(ambiguous()));
    unlink.mockResolvedValue(ok(none()));
    render(
      <PrAssociationBar worktreePath="/wt/keep-unlinked" branch={BRANCH} />
    );

    const keep = await screen.findByRole("button", { name: "Keep unlinked" });
    keep.focus();
    fireEvent.click(keep);

    expect(await screen.findByText(/No PR for/)).toBeInTheDocument();
    expect(unlink).toHaveBeenCalledExactlyOnceWith("/wt/keep-unlinked", BRANCH);
    expect(screen.getByRole("button", { name: "Link PR…" })).toHaveFocus();
  });

  it("offers Create PR on GitHub and shows progress while Check again runs", async () => {
    getAssociation.mockResolvedValueOnce(ok(none("feature/new")));
    const pending = deferred<AssociationResult>();
    getAssociation.mockReturnValueOnce(pending.promise);

    render(<PrAssociationBar worktreePath="/wt/none" branch={BRANCH} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Create PR on GitHub" })
    );
    expect(openUrl).toHaveBeenCalledWith(
      `https://github.com/${REPO}/compare/feature%2Fnew?expand=1`
    );

    const check = screen.getByRole("button", { name: "Check again" });
    check.focus();
    fireEvent.click(check);
    expect(getAssociation).toHaveBeenLastCalledWith("/wt/none", BRANCH, true);
    expect(check).toHaveTextContent("Checking…");
    expect(check).toHaveAttribute("aria-busy", "true");
    expect(check).toHaveFocus();

    await act(async () => pending.resolve(ok(linked(PR_482))));
    expect(
      await screen.findByRole("button", { name: "Open PR #482 on GitHub" })
    ).toHaveFocus();
  });

  it("does not poll gh_missing or auth_expired on remount, reload, or interval", async () => {
    getAssociation.mockResolvedValueOnce(
      ok({ status: "gh_missing", branch: BRANCH, repo: REPO })
    );
    const view = render(
      <>
        <HeaderConsumer worktreePath="/wt/missing" />
        <PrAssociationBar worktreePath="/wt/missing" branch={BRANCH} />
      </>
    );
    expect(await screen.findByText(/GitHub CLI \(/)).toBeInTheDocument();

    view.rerender(<HeaderConsumer worktreePath="/wt/missing" />);
    view.rerender(
      <>
        <HeaderConsumer worktreePath="/wt/missing" />
        <PrAssociationBar worktreePath="/wt/missing" branch={BRANCH} />
      </>
    );
    await tickRevalidation();
    expect(screen.getByText(/GitHub CLI \(/)).toBeInTheDocument();
    expect(getAssociation).toHaveBeenCalledTimes(1);
    view.unmount();

    getAssociation.mockResolvedValueOnce(
      ok({
        status: "auth_expired",
        branch: BRANCH,
        repo: REPO,
        reason: "Bad credentials",
      })
    );
    render(<PrAssociationBar worktreePath="/wt/expired" branch={BRANCH} />);
    await screen.findByText(/GitHub authentication expired/);
    expect(screen.getByRole("status")).toHaveTextContent(
      /GitHub authentication expired/
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await tickRevalidation();
    expect(getAssociation).toHaveBeenCalledTimes(2);
  });

  it("shares one discovery between two consumers of the same worktree", async () => {
    const pending = deferred<AssociationResult>();
    getAssociation.mockReturnValue(pending.promise);

    render(
      <>
        <HeaderConsumer worktreePath="/wt/shared" />
        <PrAssociationBar worktreePath="/wt/shared" branch={BRANCH} />
      </>
    );
    expect(
      screen.getByText("Looking for a GitHub pull request…")
    ).toBeInTheDocument();
    expect(getAssociation).toHaveBeenCalledExactlyOnceWith(
      "/wt/shared",
      BRANCH,
      false
    );

    await act(async () => pending.resolve(ok(linked(PR_482))));
    expect(await screen.findByTestId("chat-header-pr-chip")).toHaveTextContent(
      "#482"
    );
    expect(
      screen.getByRole("button", { name: "Open PR #482 on GitHub" })
    ).toBeInTheDocument();
    expect(getAssociation).toHaveBeenCalledTimes(1);
  });

  it("keys associations per worktree and branch, never sharing across branches", async () => {
    getAssociation.mockImplementation(async (_path, branch) =>
      ok({
        ...linked(branch === BRANCH ? PR_482 : PR_479),
        branch,
      })
    );
    const view = render(
      <>
        <HeaderConsumer worktreePath="/wt/keyed" />
        <PrAssociationBar worktreePath="/wt/keyed" branch="feature/other" />
      </>
    );

    expect(await screen.findByTestId("chat-header-pr-chip")).toHaveTextContent(
      "#482"
    );
    expect(
      await screen.findByRole("button", { name: "Open PR #479 on GitHub" })
    ).toBeInTheDocument();
    expect(getAssociation).toHaveBeenCalledTimes(2);
    expect(getAssociation).toHaveBeenCalledWith("/wt/keyed", BRANCH, false);
    expect(getAssociation).toHaveBeenCalledWith(
      "/wt/keyed",
      "feature/other",
      false
    );

    unlink.mockResolvedValue(ok(none("feature/other")));
    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(screen.getByTestId("pr-unlink-action"));
    expect(await screen.findByText(/No PR for/)).toBeInTheDocument();
    expect(unlink).toHaveBeenCalledExactlyOnceWith(
      "/wt/keyed",
      "feature/other"
    );
    expect(screen.getByTestId("chat-header-pr-chip")).toHaveTextContent("#482");
    view.unmount();

    render(<HeaderConsumer worktreePath="/wt/keyed" branch={null} />);
    await act(async () => {});
    expect(getAssociation).toHaveBeenCalledTimes(2);
  });

  it("takes a linked PR's state from the poller and keeps it through a failed poll", async () => {
    getAssociation.mockResolvedValueOnce(ok(linked(PR_482)));
    render(<PrAssociationBar worktreePath="/wt/linked" branch={BRANCH} />);
    await screen.findByRole("button", { name: "Open PR #482 on GitHub" });

    poll.mockResolvedValueOnce({
      status: "error",
      error: {
        kind: "other",
        message: "Network offline",
        retryAfterSecs: null,
      },
    });
    await tickRevalidation();
    // Only the checks line reports it; the PR stays as last read.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t refresh: Network offline"
    );
    expect(
      screen.getByRole("button", { name: "Open PR #482 on GitHub" })
    ).toBeInTheDocument();

    polledAssociation = () => linked({ ...PR_482, state: "merged" });
    await tickRevalidation();
    expect(await screen.findByText("Merged")).toBeInTheDocument();
    // The poller answers for the PR; discovery is not asked again.
    expect(getAssociation).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit refresh error through a later poll", async () => {
    getAssociation.mockResolvedValueOnce(ok(linked(PR_482)));
    render(<PrAssociationBar worktreePath="/wt/errors" branch={BRANCH} />);
    await screen.findByRole("button", { name: "Open PR #482 on GitHub" });

    getAssociation.mockResolvedValueOnce(commandError("GitHub is down"));
    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh PR" }));
    expect(
      await screen.findByText(/GitHub is down/, { selector: "[role=alert] *" })
    ).toBeInTheDocument();

    await tickRevalidation();
    expect(screen.getByText(/GitHub is down/)).toBeInTheDocument();
  });

  it("does not let a poll answer replace an explicit refresh result", async () => {
    getAssociation.mockResolvedValueOnce(ok(linked(PR_482)));
    render(<PrAssociationBar worktreePath="/wt/race" branch={BRANCH} />);
    await screen.findByRole("button", { name: "Open PR #482 on GitHub" });
    await act(async () => {});

    const background = deferred<ReturnType<typeof pollAnswer>>();
    poll.mockReturnValueOnce(background.promise);
    const tick = pollWatchedWorktreePrsNow();
    getAssociation.mockResolvedValueOnce(ok(linked(PR_479)));
    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh PR" }));
    expect(
      await screen.findByRole("button", { name: "Open PR #479 on GitHub" })
    ).toBeInTheDocument();
    // The poll answers with what GitHub said before the refresh.
    polledAssociation = () => linked(PR_482);
    await act(async () => {
      background.resolve(
        pollAnswer([{ worktreePath: "/wt/race", branch: BRANCH }])
      );
      await tick;
    });
    expect(
      screen.getByRole("button", { name: "Open PR #479 on GitHub" })
    ).toBeInTheDocument();

    polledAssociation = () => none();
    await tickRevalidation();
    expect(
      screen.getByRole("button", { name: "Open PR #479 on GitHub" })
    ).toBeInTheDocument();
    expect(screen.queryByText(/No PR for/)).not.toBeInTheDocument();
  });

  it("keeps the typed number and focus when a link fails", async () => {
    getAssociation.mockResolvedValue(ok(none()));
    link.mockResolvedValue(commandError("PR #482 was not found"));
    render(<PrAssociationBar worktreePath="/wt/link-fail" branch={BRANCH} />);

    const input = await openManualLink();
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "482" } });
    fireEvent.click(screen.getByRole("button", { name: "Link locally" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PR #482 was not found"
    );
    expect(link).toHaveBeenCalledExactlyOnceWith(
      "/wt/link-fail",
      BRANCH,
      482,
      null
    );
    expect(input).toHaveValue("482");
    expect(input).toHaveFocus();
    expect(input).not.toHaveAttribute("readonly");
  });

  it("validates the manual entry and passes a URL's repo for the backend to check", async () => {
    getAssociation.mockResolvedValue(ok(none()));
    link.mockResolvedValue(commandError("stop here"));
    render(<PrAssociationBar worktreePath="/wt/validate" branch={BRANCH} />);
    const input = await openManualLink();
    const submit = () =>
      fireEvent.submit(input.closest("form") as HTMLFormElement);

    fireEvent.change(input, { target: { value: "abc" } });
    submit();
    const error = await screen.findByText(/Enter a PR number like 482/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
    expect(link).not.toHaveBeenCalled();

    for (const [value, number, repo] of [
      ["0482", 482, null],
      ["#17", 17, null],
      [`https://github.com/${REPO}/pull/479/files`, 479, REPO],
      ["https://github.com/other/repo/pull/12", 12, "other/repo"],
    ] as const) {
      fireEvent.change(input, { target: { value } });
      submit();
      await waitFor(() =>
        expect(link).toHaveBeenLastCalledWith(
          "/wt/validate",
          BRANCH,
          number,
          repo
        )
      );
      await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
    }
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("closes the manual panel with Escape and returns focus to Link PR…", async () => {
    getAssociation.mockResolvedValue(ok(none()));
    render(<PrAssociationBar worktreePath="/wt/escape" branch={BRANCH} />);
    const input = await openManualLink();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByTestId("pr-manual-link-panel")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link PR…" })).toHaveFocus();
  });

  it("retries a failed open-PR lookup while the number field stays usable", async () => {
    getAssociation.mockResolvedValue(ok(none()));
    listOpen
      .mockRejectedValueOnce(new Error("Network offline"))
      .mockResolvedValueOnce(ok([PR_482]));
    render(
      <PrAssociationBar worktreePath="/wt/manual-retry" branch={BRANCH} />
    );
    const input = await openManualLink();

    expect(
      await screen.findByText(/Couldn’t load open PRs: Network offline/)
    ).toBeInTheDocument();
    expect(input).not.toHaveAttribute("readonly");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(PR_482.title)).toBeInTheDocument();
  });

  it("says when the open-PR list is cut short or empty", async () => {
    getAssociation.mockResolvedValue(ok(none()));
    const many = Array.from({ length: OPEN_PR_LIST_LIMIT + 2 }, (_, index) =>
      pullRequest(500 + index)
    );
    listOpen.mockResolvedValueOnce(ok(many)).mockResolvedValueOnce(ok([]));
    render(<PrAssociationBar worktreePath="/wt/list" branch={BRANCH} />);

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
    getAssociation.mockResolvedValueOnce(
      ok({
        status: "unavailable",
        branch: BRANCH,
        repo: REPO,
        error: failure("other", "GitHub API timed out"),
      })
    );
    const view = render(
      <PrAssociationBar worktreePath="/wt/unavailable" branch={BRANCH} />
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Couldn’t check GitHub PR: GitHub API timed out"
    );
    getAssociation.mockResolvedValueOnce(ok(linked(PR_482)));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(
      await screen.findByRole("button", { name: "Open PR #482 on GitHub" })
    ).toBeInTheDocument();
    view.unmount();

    getAssociation.mockResolvedValueOnce(
      ok({
        status: "not_applicable",
        branch: null,
        reason: "No GitHub remote configured for this repository",
      })
    );
    render(<PrAssociationBar worktreePath="/wt/no-remote" branch={BRANCH} />);
    await waitFor(() =>
      expect(screen.queryByTestId("pr-association-bar")).not.toBeInTheDocument()
    );
  });

  it.each([
    [failure("gh_missing"), "gh not found"],
    [failure("auth_expired"), "gh sign-in expired"],
    [
      failure("rate_limited", "slow down", 45),
      "rate limited · try again in 45s",
    ],
    [failure("not_found"), "PR not found on GitHub"],
    [failure("other", "gh exited with 1"), "gh exited with 1"],
  ])(
    "keeps a linked PR visible with a quiet %j refresh note",
    async (staleError, note) => {
      getAssociation.mockResolvedValueOnce(ok(linked(PR_482, staleError)));
      render(<PrAssociationBar worktreePath="/wt/stale" branch={BRANCH} />);
      const status = await screen.findByText(`Couldn’t refresh · ${note}`);
      expect(status).toHaveAttribute("role", "status");
      expect(status).toHaveClass("pr-assoc-mute");
      expect(
        screen.getByRole("button", { name: "Open PR #482 on GitHub" })
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
  );

  it.each(FAILURE_TEXT)(
    "shows a %s link failure once, with recovery copy and no retry",
    async (kind, retryAfterSecs, text) => {
      getAssociation.mockResolvedValue(ok(none()));
      link.mockResolvedValue(
        commandError(
          kind === "not_found" || kind === "other" ? text : `${kind} raw`,
          kind,
          retryAfterSecs
        )
      );
      render(
        <PrAssociationBar worktreePath={`/wt/link-${kind}`} branch={BRANCH} />
      );
      const input = await openManualLink();
      fireEvent.change(input, { target: { value: "482" } });
      fireEvent.click(screen.getByRole("button", { name: "Link locally" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(
        screen.getAllByRole("button", { name: "Check again" })
      ).toHaveLength(1);
      await tickRevalidation();
      expect(link).toHaveBeenCalledTimes(1);
      expect(getAssociation).toHaveBeenCalledTimes(1);
    }
  );

  it.each(FAILURE_TEXT)(
    "shows a %s open-PR list failure with a manual Retry",
    async (kind, retryAfterSecs, text) => {
      getAssociation.mockResolvedValue(ok(none()));
      listOpen.mockResolvedValueOnce(
        commandError(
          kind === "not_found" || kind === "other" ? text : `${kind} raw`,
          kind,
          retryAfterSecs
        )
      );
      render(
        <PrAssociationBar worktreePath={`/wt/list-${kind}`} branch={BRANCH} />
      );
      await openManualLink();

      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Couldn’t load open PRs: ${text}`
      );
      expect(listOpen).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText(PR_482.title)).toBeInTheDocument();
      expect(listOpen).toHaveBeenCalledTimes(2);
    }
  );

  it("offers Check again beside a gh setup failure when the bar has none", async () => {
    getAssociation.mockResolvedValueOnce(ok(ambiguous()));
    link.mockResolvedValueOnce(commandError("raw", "auth_expired"));
    render(
      <PrAssociationBar worktreePath="/wt/ambiguous-auth" branch={BRANCH} />
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Link locally: #482/ })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub authentication expired · run gh auth login in your terminal"
    );

    getAssociation.mockResolvedValueOnce(ok(linked(PR_482)));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(getAssociation).toHaveBeenLastCalledWith(
      "/wt/ambiguous-auth",
      BRANCH,
      true
    );
    expect(
      await screen.findByRole("button", { name: "Open PR #482 on GitHub" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed first lookup with Check again instead of a spinner", async () => {
    getAssociation.mockResolvedValueOnce(
      commandError("raw", "rate_limited", 30)
    );
    render(<PrAssociationBar worktreePath="/wt/first-fail" branch={BRANCH} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Couldn’t check GitHub PR: GitHub rate limit reached · try again in 30s"
    );
    expect(
      screen.queryByText("Looking for a GitHub pull request…")
    ).not.toBeInTheDocument();
    await tickRevalidation();
    expect(getAssociation).toHaveBeenCalledTimes(1);
  });

  it("links a candidate from another repo with that repo, a typed number with null", async () => {
    const MIRROR = pullRequest(91, {
      owner: "upstream",
      repo: "demo",
      headRepo: REPO,
      url: "https://github.com/upstream/demo/pull/91",
    });
    getAssociation.mockResolvedValueOnce(ok(ambiguous([PR_482, MIRROR])));
    link.mockResolvedValue(commandError("stop here"));
    const view = render(
      <PrAssociationBar worktreePath="/wt/repos" branch={BRANCH} />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Link locally: #91/ })
    );
    await waitFor(() =>
      expect(link).toHaveBeenLastCalledWith(
        "/wt/repos",
        BRANCH,
        91,
        "upstream/demo"
      )
    );
    view.unmount();

    getAssociation.mockResolvedValueOnce(ok(none()));
    render(<PrAssociationBar worktreePath="/wt/typed" branch={BRANCH} />);
    const input = await openManualLink();
    fireEvent.change(input, { target: { value: "#91" } });
    fireEvent.click(screen.getByRole("button", { name: "Link locally" }));
    await waitFor(() =>
      expect(link).toHaveBeenLastCalledWith("/wt/typed", BRANCH, 91, null)
    );
    expect(link).toHaveBeenCalledTimes(2);
  });

  it("shows the backend's rejection of a URL from a repo that isn't a remote", async () => {
    getAssociation.mockResolvedValue(ok(none()));
    link.mockResolvedValue(
      commandError("other/repo is not a GitHub remote of this worktree")
    );
    render(<PrAssociationBar worktreePath="/wt/foreign" branch={BRANCH} />);
    const input = await openManualLink();
    fireEvent.change(input, {
      target: { value: "https://github.com/other/repo/pull/12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link locally" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "other/repo is not a GitHub remote of this worktree"
    );
    expect(link).toHaveBeenCalledExactlyOnceWith(
      "/wt/foreign",
      BRANCH,
      12,
      "other/repo"
    );
    expect(input).toHaveValue("https://github.com/other/repo/pull/12");
  });

  it("does not open non-http(s) PR URLs", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    getAssociation.mockResolvedValueOnce(
      ok(linked({ ...PR_482, url: "file:///etc/passwd" }))
    );
    render(<PrAssociationBar worktreePath="/wt/bad-url" branch={BRANCH} />);
    expect(await screen.findByText("#482")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open PR #482 on GitHub" })
    ).not.toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
    consoleError.mockRestore();
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
    const view = render(
      <ChatHeader
        {...header}
        linkedPr={PR_482}
        onOpenPrInChanges={onOpenPrInChanges}
      />
    );
    const chip = screen.getByRole("button", { name: /PR #482 · Open/ });
    expect(chip).not.toHaveAttribute("aria-pressed");
    expect(chip).toHaveTextContent("#482");
    fireEvent.click(chip);
    expect(onOpenPrInChanges).toHaveBeenCalledTimes(1);

    view.rerender(<ChatHeader {...header} linkedPr={PR_482} />);
    expect(screen.getByTestId("chat-header-pr-chip").tagName).toBe("SPAN");

    view.rerender(<ChatHeader {...header} linkedPr={null} />);
    expect(screen.queryByTestId("chat-header-pr-chip")).not.toBeInTheDocument();
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
