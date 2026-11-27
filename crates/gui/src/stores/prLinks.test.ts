import { describe, expect, it } from "vitest";
import { savedPrOf, type LinkedPr } from "./prLinks";

const PR: LinkedPr = {
  host: "github.com",
  owner: "example",
  repo: "demo-repo",
  number: 482,
  title: "Retry flaky uploads",
  state: "open",
  url: "https://github.com/example/demo-repo/pull/482",
};

const session = (
  at: { worktreePath: string | null; branch: string | null },
  pullRequest: unknown
) => ({
  association: {
    ticketId: "t",
    ticketTitle: null,
    lastProcessedAt: null,
    processedAtCount: 0,
    awaitingWorktree: null,
    recentWorktrees: [],
    ...at,
    pullRequest,
  },
});

describe("savedPrOf", () => {
  it("keeps a PR saved on another machine's chat, pinned to no worktree", () => {
    const here = { worktreePath: null, branch: null };
    expect(
      savedPrOf(session(here, { ...here, pr: PR, changedAt: null }))
    ).toEqual(PR);
  });

  it("keeps a PR pinned to the chat's worktree branch", () => {
    const at = { worktreePath: "/wt/a", branch: "feature/retry" };
    expect(savedPrOf(session(at, { ...at, pr: PR, changedAt: null }))).toEqual(
      PR
    );
  });

  it("drops a PR pinned elsewhere, unlinked, or malformed", () => {
    const at = { worktreePath: "/wt/a", branch: "feature/retry" };
    const link = (over: object) => ({ ...at, pr: PR, changedAt: null, ...over });
    expect(savedPrOf(session(at, link({ branch: "other" })))).toBeNull();
    expect(savedPrOf(session(at, link({ worktreePath: null })))).toBeNull();
    expect(savedPrOf(session(at, link({ pr: null })))).toBeNull();
    expect(savedPrOf(session(at, link({ pr: { ...PR, number: 0 } })))).toBeNull();
    expect(savedPrOf(session(at, [link({})]))).toBeNull();
    expect(
      savedPrOf({ ...session(at, link({})), discussion: { id: "d" } })
    ).toBeNull();
  });
});
