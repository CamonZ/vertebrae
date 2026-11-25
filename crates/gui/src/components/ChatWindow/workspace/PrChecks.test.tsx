import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  commands,
  type GithubPrCheck,
  type GithubPrChecks,
  type GithubPullRequest,
  type WorktreePrPollBatch,
} from "../../../bindings";
import { useWorktreePrAssociation } from "../../../hooks/useWorktreePrAssociation";
import { useWorktreePrChecks } from "../../../hooks/useWorktreePrChecks";
import {
  linkedPullRequest,
  resetWorktreePrStore,
} from "../../../stores/worktreePrStore";
import { resetWorktreePrChecksStore } from "../../../stores/worktreePrChecksStore";
import { ChatHeaderPrChip } from "../GithubPr";
import { PrAssociationBar } from "./PrAssociationBar";

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
const getChecks = vi.mocked(commands.pollWorktreePrs);
const rerun = vi.mocked(commands.rerunWorktreePrCheck);
const cancel = vi.mocked(commands.cancelWorktreePrCheck);
const publishedHead = vi.mocked(commands.getWorktreePublishedHead);

const WORKTREE = "/wt/a";
const REPO = "example/demo-repo";
const BRANCH = "feature/retry";
const ok = <T,>(data: T) => ({ status: "ok" as const, data });

const PR: GithubPullRequest = {
  owner: "example",
  repo: "demo-repo",
  number: 482,
  title: "Reset retry budget after success",
  state: "open",
  headRef: BRANCH,
  headRepo: REPO,
  baseRef: "main",
  url: `https://github.com/${REPO}/pull/482`,
  author: "alice",
  updatedAt: null,
};

function check(
  id: string,
  name: string,
  status: GithubPrCheck["status"],
  overrides: Partial<GithubPrCheck> = {}
): GithubPrCheck {
  return {
    id,
    name,
    provider: "GitHub Actions",
    status,
    outcome:
      status === "failed" ? "failure" : status === "passed" ? "success" : null,
    startedAt: null,
    completedAt: null,
    url: `https://github.com/${REPO}/actions/runs/1/job/${id.slice(4)}`,
    summary: null,
    failedStep: null,
    actionsJob: true,
    actionsRun: "4100",
    rerun: status === "failed" ? "allowed" : "not_applicable",
    cancel:
      status === "running" || status === "queued"
        ? "allowed"
        : "not_applicable",
    ...overrides,
  };
}

const CHECKS: GithubPrCheck[] = [
  check("run:11", "test (ubuntu)", "failed", {
    failedStep: "Run cargo test",
  }),
  check("run:12", "lint", "failed", { rerun: "no_permission" }),
  check("status:ci/external", "external-ci", "failed", {
    provider: "External CI",
    actionsJob: false,
    actionsRun: null,
    rerun: "provider",
    url: "https://ci.example.test/build/7",
  }),
  check("run:13", "build", "running"),
  check("run:14", "docs", "queued", { actionsRun: "4200" }),
  check("run:15", "fmt", "passed"),
];

function snapshot(checks: GithubPrCheck[]): GithubPrChecks {
  return {
    prNumber: 482,
    repo: REPO,
    headSha: "abc1234",
    checks,
    truncated: false,
  };
}

function polled(checks: GithubPrCheck[]) {
  return ok<WorktreePrPollBatch>({
    results: [
      {
        worktreePath: WORKTREE,
        branch: BRANCH,
        result: {
          status: "linked",
          association: {
            status: "linked",
            branch: BRANCH,
            repo: REPO,
            pr: PR,
            staleError: null,
          },
          checks: snapshot(checks),
        },
      },
    ],
    holdOffSecs: null,
  });
}

/** The chat header's consumer of the same branch, as ChatWindow wires it. */
function HeaderChip() {
  const pr = linkedPullRequest(
    useWorktreePrAssociation(WORKTREE, BRANCH).association
  );
  const { entry, counts } = useWorktreePrChecks(WORKTREE, BRANCH);
  return pr ? (
    <ChatHeaderPrChip pr={pr} checks={entry.snapshot ? counts : null} />
  ) : null;
}

function renderSurfaces() {
  return render(
    <>
      <HeaderChip />
      <PrAssociationBar worktreePath={WORKTREE} branch={BRANCH} />
    </>
  );
}

async function openDrawer() {
  const toggle = await screen.findByTestId("pr-checks-toggle");
  fireEvent.click(toggle);
  return screen.getByTestId("pr-checks-drawer");
}

function rowNamed(drawer: HTMLElement, name: string) {
  const row = within(drawer)
    .getAllByTestId("pr-check-row")
    .find((item) => within(item).queryByText(name));
  if (!row) throw new Error(`no check row ${name}`);
  return row;
}

describe("PR checks in the review bar, drawer and chip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    getAssociation.mockResolvedValue(
      ok({
        status: "linked",
        branch: BRANCH,
        repo: REPO,
        pr: PR,
        staleError: null,
      })
    );
    getChecks.mockResolvedValue(polled(CHECKS));
    publishedHead.mockResolvedValue(ok(null));
  });

  afterEach(() => {
    resetWorktreePrChecksStore();
    resetWorktreePrStore();
    vi.useRealTimers();
  });

  it("shows the same counts in the bar, the drawer and the header chip", async () => {
    renderSurfaces();
    const toggle = await screen.findByTestId("pr-checks-toggle");
    expect(toggle).toHaveAccessibleName(
      "Checks: 3 failed, 1 running, 1 queued, 1 passed. Show details"
    );
    expect(toggle).toHaveTextContent("3failed1running1queued1passed");

    const drawer = await openDrawer();
    const rows = within(drawer).getAllByTestId("pr-check-row");
    const statuses = rows.map((row) =>
      row.className.replace("pr-check is-", "")
    );
    expect(statuses).toEqual([
      "failed",
      "failed",
      "failed",
      "running",
      "queued",
      "passed",
    ]);

    expect(screen.getByTestId("chat-header-pr-checks")).toHaveTextContent("3");
    expect(screen.getByTestId("chat-header-pr-chip")).toHaveAttribute(
      "title",
      expect.stringContaining("Checks: 3 failed, 1 running, 1 queued, 1 passed")
    );
    expect(getChecks).toHaveBeenCalledTimes(1);
  });

  it("offers Re-run only for permitted Actions jobs and links other providers out", async () => {
    renderSurfaces();
    const drawer = await openDrawer();

    const allowed = rowNamed(drawer, "test (ubuntu)");
    expect(
      within(allowed).getByRole("button", {
        name: "Re-run test (ubuntu) on GitHub Actions",
      })
    ).toBeInTheDocument();
    // The first failure starts expanded with its failed step.
    expect(within(allowed).getByText("Run cargo test")).toBeInTheDocument();

    const denied = rowNamed(drawer, "lint");
    expect(
      within(denied).queryByRole("button", { name: /^Re-run/ })
    ).toBeNull();
    expect(within(denied).getByText("No re-run access")).toBeInTheDocument();

    const external = rowNamed(drawer, "external-ci");
    fireEvent.click(
      within(external).getByRole("button", {
        name: "Re-run external-ci on External CI",
      })
    );
    expect(openUrl).toHaveBeenCalledWith("https://ci.example.test/build/7");
    expect(rerun).not.toHaveBeenCalled();

    for (const name of ["build", "docs", "fmt"]) {
      expect(
        within(rowNamed(drawer, name)).queryByRole("button", {
          name: /^Re-run/,
        })
      ).toBeNull();
    }
  });

  it("keeps an in-progress re-run when the drawer closes and reopens", async () => {
    let accept: (value: { status: "ok"; data: null }) => void = () => {};
    rerun.mockReturnValue(new Promise((resolve) => (accept = resolve)));
    renderSurfaces();
    let drawer = await openDrawer();
    fireEvent.click(
      within(rowNamed(drawer, "test (ubuntu)")).getByRole("button", {
        name: "Re-run test (ubuntu) on GitHub Actions",
      })
    );
    expect(rerun).toHaveBeenCalledExactlyOnceWith(WORKTREE, BRANCH, "run:11");

    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByTestId("pr-checks-drawer")).toBeNull();
    expect(screen.getByTestId("pr-checks-toggle")).toHaveFocus();

    drawer = await openDrawer();
    const pending = within(rowNamed(drawer, "test (ubuntu)")).getByRole(
      "button",
      {
        name: "Re-run test (ubuntu) on GitHub Actions",
      }
    );
    expect(pending).toHaveTextContent("Requesting…");
    expect(pending).toHaveAttribute("aria-busy", "true");
    fireEvent.click(pending);
    expect(rerun).toHaveBeenCalledTimes(1);

    await act(async () => accept(ok(null)));
    const row = rowNamed(
      screen.getByTestId("pr-checks-drawer"),
      "test (ubuntu)"
    );
    expect(row).toHaveClass("is-queued");
    expect(row).toHaveTextContent("re-run queued");
    expect(screen.getByTestId("pr-checks-toggle")).toHaveAccessibleName(
      "Checks: 2 failed, 1 running, 2 queued, 1 passed. Hide details"
    );
    expect(screen.getByTestId("chat-header-pr-checks")).toHaveTextContent("2");
  });

  it("keeps the last checks after a failed refresh and offers Retry now", async () => {
    renderSurfaces();
    await screen.findByTestId("pr-checks-toggle");
    getChecks.mockResolvedValueOnce({
      status: "error",
      error: {
        kind: "rate_limited",
        message: "API rate limit exceeded",
        retryAfterSecs: 40,
      },
    });
    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Refresh PR/ })
    );

    const alert = await screen.findByText(
      /Couldn’t refresh: GitHub rate limit reached/
    );
    expect(alert).toHaveTextContent("Showing last known state from");
    expect(screen.getByText(/auto in 40s/)).toBeInTheDocument();
    expect(screen.getByTestId("pr-checks-toggle")).toHaveAccessibleName(
      /^Checks: 3 failed/
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(await screen.findByText(/^Updated/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
  });

  it("marks only the routine refresh line as hideable in a narrow bar", async () => {
    renderSurfaces();
    const updated = await screen.findByText(/^Updated/);
    expect(updated).toHaveClass("is-routine");

    getChecks.mockResolvedValueOnce({
      status: "error",
      error: { kind: "other", message: "offline", retryAfterSecs: null },
    });
    fireEvent.click(screen.getByTestId("pr-actions-menu"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Refresh PR/ })
    );
    const failed = await screen.findByRole("alert");
    expect(failed.closest(".pr-checks-refresh")).not.toHaveClass("is-routine");
    // Counts stay readable from the glyphs, numbers and accessible name.
    expect(screen.getByTestId("pr-checks-toggle")).toHaveAccessibleName(
      /^Checks: 3 failed, 1 running, 1 queued, 1 passed/
    );
  });

  it("asks before cancelling a run and names how many jobs stop with it", async () => {
    const twoJobs = [
      check("run:13", "build", "running"),
      check("run:16", "build (macos)", "queued"),
      check("run:15", "fmt", "passed"),
      check("status:ci/ext", "external-ci", "running", {
        provider: "External CI",
        actionsJob: false,
        actionsRun: null,
        cancel: "provider",
      }),
      check("run:17", "deploy", "running", {
        actionsRun: "4300",
        cancel: "no_permission",
      }),
    ];
    getChecks.mockResolvedValue(polled(twoJobs));
    cancel.mockResolvedValue(ok(null));
    renderSurfaces();
    const drawer = await openDrawer();

    const build = rowNamed(drawer, "build");
    fireEvent.click(
      within(build).getByRole("button", {
        name: "Cancel the workflow run of build",
      })
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(
      within(build).getByText("Stops all 2 jobs in the run")
    ).toBeVisible();
    fireEvent.click(
      within(build).getByRole("button", { name: "Keep running" })
    );
    expect(within(build).queryByText(/Stops all/)).toBeNull();

    fireEvent.click(
      within(build).getByRole("button", {
        name: "Cancel the workflow run of build",
      })
    );
    await act(async () => {
      fireEvent.click(
        within(build).getByRole("button", {
          name: "Confirm: cancel the workflow run of build on GitHub Actions",
        })
      );
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(WORKTREE, BRANCH, "run:13");
    // Every job of the run reads as cancelling until GitHub reports it.
    const after = screen.getByTestId("pr-checks-drawer");
    expect(rowNamed(after, "build")).toHaveTextContent("cancelling");
    expect(rowNamed(after, "build (macos)")).toHaveTextContent("cancelling");

    expect(
      within(rowNamed(after, "external-ci")).queryByRole("button", {
        name: /^Cancel/,
      })
    ).toBeNull();
    expect(
      within(rowNamed(after, "deploy")).getByText("No cancel access")
    ).toBeInTheDocument();
    expect(
      within(rowNamed(after, "fmt")).queryByRole("button", { name: /^Cancel/ })
    ).toBeNull();
  });
});
