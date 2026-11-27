/**
 * The PR sync's rules, driven through the real sync, poller and stores
 * against a synthetic GitHub (`test/fakeGithub`): which branches are
 * watched, what is linked automatically, and how answers are applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type GithubPrPollRequest } from "../bindings";
import { queryClient } from "../query/queryClient";
import { queryKeys } from "../query/queryKeys";
import { createMockTask } from "../test/test-utils";
import {
  REPO,
  addPr,
  chatLink,
  chatSession,
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
} from "../test/fakeGithub";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "./projectScopedStores";
import {
  acquireWorktreePr,
  linkWorktreePr,
  pollWatchedPrsNow,
  refreshWorktreePr,
  retainPrSync,
} from "./prSync";
import {
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
  },
}));

const poll = vi.mocked(commands.pollGithubPrs);
const BRANCH = "feature/retry";
const WT = "/wt/a";

let world: FakeGithub;

/** Every request the sync sent GitHub, flattened. */
const asked = (): GithubPrPollRequest[] => poll.mock.calls.flatMap(([r]) => r);

function cacheTask(id: string, done: boolean) {
  queryClient.setQueryData(
    queryKeys.tasks.detail(getProjectScopeGeneration(), id),
    createMockTask({
      id,
      completed_at: done ? "2026-11-20T10:00:00Z" : null,
    })
  );
}

async function run() {
  const release = retainPrSync();
  await settle(20);
  return release;
}

beforeEach(() => {
  vi.clearAllMocks();
  world = fakeGithub();
  installFakeGithub(commands, world);
});

afterEach(() => {
  resetFakeGithub();
  queryClient.clear();
});

describe("watching", () => {
  it("watches the branch of an unfinished or uncached ticket without any UI", async () => {
    addPr(world, pullRequest(482));
    cacheTask("open-ticket", false);
    seedChats(
      chatSession("open", WT, BRANCH, { ticketId: "open-ticket" }),
      chatSession("uncached", "/wt/b", "feature/b", { ticketId: "gone" })
    );
    await run();

    expect(chatLink("open")?.pr?.number).toBe(482);
    expect(
      asked()
        .map((r) => r.branches)
        .flat()
    ).toEqual(expect.arrayContaining([BRANCH, "feature/b"]));
  });

  it("stops polling a finished or archived ticket's branch, reading it once when shown", async () => {
    addPr(world, pullRequest(482));
    cacheTask("done", true);
    queryClient.setQueryData(
      queryKeys.tasks.detail(getProjectScopeGeneration(), "archived"),
      createMockTask({ id: "archived", archived: true })
    );
    seedChats(
      chatSession("done", WT, BRANCH, {
        ticketId: "done",
        link: prLink(WT, BRANCH, linkedPr(pullRequest(482))),
      }),
      chatSession("archived", "/wt/b", "feature/b", { ticketId: "archived" })
    );
    await run();
    expect(poll).not.toHaveBeenCalled();

    const hide = acquireWorktreePr(WT, BRANCH);
    await settle(20);
    expect(asked()).toEqual([
      { host: "github.com", repo: REPO, branches: [BRANCH], numbers: [482] },
    ]);
    expect(prEntryOf(worktreePrKey(WT, BRANCH)).snapshot?.prNumber).toBe(482);

    await pollWatchedPrsNow();
    await settle();
    expect(poll).toHaveBeenCalledTimes(1);
    hide();
    await settle();

    // Shown again, it is read again.
    const again = acquireWorktreePr(WT, BRANCH);
    await settle(20);
    expect(poll).toHaveBeenCalledTimes(2);
    again();
  });

  it("watches a chat without a ticket only while it is shown", async () => {
    addPr(world, pullRequest(482));
    seedChats(chatSession("loose", WT, BRANCH, { ticketId: null }));
    await run();
    expect(poll).not.toHaveBeenCalled();

    const hide = acquireWorktreePr(WT, BRANCH);
    await settle(20);
    expect(chatLink("loose")?.pr?.number).toBe(482);
    hide();
  });

  it("asks nothing for an unlinked branch, even once a PR opens", async () => {
    seedChats(
      chatSession("chat", WT, BRANCH, { link: prLink(WT, BRANCH, null) })
    );
    addPr(world, pullRequest(482));
    await run();
    await pollWatchedPrsNow();
    expect(asked()).toEqual([]);
    expect(chatLink("chat")?.pr).toBeNull();
  });
});

describe("linking automatically", () => {
  it("links every chat on the branch, and gives all of them the newest link", async () => {
    addPr(world, pullRequest(482));
    seedChats(
      chatSession("a", WT, BRANCH),
      chatSession("b", WT, BRANCH, { ticketId: "other-ticket" })
    );
    await run();
    expect(chatLink("a")?.pr?.number).toBe(482);
    expect(chatLink("a")).toEqual(chatLink("b"));

    const newer = prLink(
      WT,
      BRANCH,
      linkedPr(pullRequest(490)),
      "2099-01-01T00:00:00.000Z"
    );
    seedChats(
      chatSession("a", WT, BRANCH, { link: chatLink("a") }),
      chatSession("b", WT, BRANCH, { link: newer })
    );
    await settle(20);
    expect(chatLink("a")).toEqual(newer);
  });

  it("matches the branch's own head repository case-insensitively", async () => {
    addPr(world, pullRequest(482, { headRepo: "Example/Demo-Repo" }));
    seedChats(chatSession("chat", WT, BRANCH));
    await run();
    expect(chatLink("chat")?.pr?.number).toBe(482);
  });

  it("finds a fork checkout's PR in the upstream repository", async () => {
    world.worktrees.set(
      WT,
      github(BRANCH, {
        baseRepo: "upstream/demo",
        searchRepos: ["upstream/demo", REPO],
      })
    );
    addPr(
      world,
      pullRequest(91, {
        owner: "upstream",
        repo: "demo",
        url: "https://github.com/upstream/demo/pull/91",
      })
    );
    seedChats(chatSession("chat", WT, BRANCH));
    await run();
    expect(chatLink("chat")?.pr).toMatchObject({
      owner: "upstream",
      repo: "demo",
      number: 91,
    });
  });

  it("links nothing while the open-PR list is cut short", async () => {
    world.incomplete.add(BRANCH);
    addPr(world, pullRequest(482));
    seedChats(chatSession("chat", WT, BRANCH));
    await run();
    expect(chatLink("chat")).toBeUndefined();
  });

  it("replaces a closed PR with the branch's only open one", async () => {
    addPr(world, pullRequest(470, { state: "closed" }));
    addPr(world, pullRequest(482));
    seedChats(
      chatSession("chat", WT, BRANCH, {
        link: prLink(
          WT,
          BRANCH,
          linkedPr(pullRequest(470, { state: "closed" }))
        ),
      })
    );
    await run();
    // A closed link is not polled on its own…
    expect(poll).not.toHaveBeenCalled();

    // …but its branch is listed with a watched branch on the same remote.
    seedChats(
      chatSession("chat", WT, BRANCH, {
        link: prLink(
          WT,
          BRANCH,
          linkedPr(pullRequest(470, { state: "closed" }))
        ),
      }),
      chatSession("sibling", "/wt/b", "feature/b")
    );
    await settle(20);
    expect(asked()).toContainEqual({
      host: "github.com",
      repo: REPO,
      branches: ["feature/b", BRANCH],
      numbers: [],
    });
    expect(chatLink("chat")?.pr?.number).toBe(482);
    expect(prEntryOf(worktreePrKey(WT, BRANCH)).newer).toBeNull();
  });

  it("asks rather than replacing a merged PR", async () => {
    addPr(world, pullRequest(470, { state: "merged" }));
    addPr(world, pullRequest(482));
    seedChats(
      chatSession("chat", WT, BRANCH, {
        link: prLink(
          WT,
          BRANCH,
          linkedPr(pullRequest(470, { state: "merged" }))
        ),
      })
    );
    await run();
    expect(poll).not.toHaveBeenCalled();

    // Shown, the merged PR is read once with its branch's open PRs.
    const hide = acquireWorktreePr(WT, BRANCH);
    await settle(20);
    expect(chatLink("chat")?.pr?.number).toBe(470);
    const entry = prEntryOf(worktreePrKey(WT, BRANCH));
    expect(entry.newer?.number).toBe(482);
    // Its checks are read too: the bar never stays on "Loading checks…".
    expect(entry.snapshot?.prNumber).toBe(470);
    expect(entry.read.status).toBe("idle");
    hide();
  });
});

describe("applying answers", () => {
  it("keeps what GitHub said about the linked PR on the chats", async () => {
    addPr(world, pullRequest(482, { title: "Renamed", state: "draft" }));
    seedChats(
      chatSession("chat", WT, BRANCH, {
        link: prLink(
          WT,
          BRANCH,
          linkedPr(pullRequest(482), { title: "", state: null })
        ),
      })
    );
    await run();
    expect(chatLink("chat")?.pr).toMatchObject({
      title: "Renamed",
      state: "draft",
    });
  });

  it("drops an answer about a PR the branch no longer links", async () => {
    addPr(world, pullRequest(482));
    addPr(world, pullRequest(490, { headRef: "feature/elsewhere" }));
    seedChats(
      chatSession("chat", WT, BRANCH, {
        link: prLink(WT, BRANCH, linkedPr(pullRequest(482))),
      })
    );
    let answer!: () => void;
    const fake = poll.getMockImplementation()!;
    poll.mockImplementationOnce(
      (requests) =>
        new Promise((resolve) => {
          answer = () => void fake(requests).then(resolve);
        })
    );
    await run();

    await linkWorktreePr(WT, BRANCH, 490, null);
    answer();
    await settle(20);
    const entry = prEntryOf(worktreePrKey(WT, BRANCH));
    expect(chatLink("chat")?.pr?.number).toBe(490);
    expect(entry.link?.pr?.number).toBe(490);
    expect(entry.snapshot?.prNumber).not.toBe(482);
  });
});

describe("linking by hand", () => {
  it("reads a merged PR's checks once when it is linked on a finished ticket", async () => {
    addPr(world, pullRequest(482, { state: "merged" }));
    cacheTask("done", true);
    seedChats(chatSession("chat", WT, BRANCH, { ticketId: "done" }));
    const hide = acquireWorktreePr(WT, BRANCH);
    await run();
    const before = poll.mock.calls.length;

    await linkWorktreePr(WT, BRANCH, 482, null);
    await settle(20);
    const entry = prEntryOf(worktreePrKey(WT, BRANCH));
    expect(entry.link?.pr?.state).toBe("merged");
    expect(entry.snapshot?.prNumber).toBe(482);
    expect(poll.mock.calls.length).toBeGreaterThan(before);

    // Merged and not watched: ticks leave it alone.
    const after = poll.mock.calls.length;
    await pollWatchedPrsNow();
    await settle();
    expect(poll).toHaveBeenCalledTimes(after);
    hide();
  });
});

describe("switching projects", () => {
  it("writes nothing from a read that started before the switch", async () => {
    addPr(world, pullRequest(482));
    let finish: () => void = () => {};
    const resolved = vi.mocked(commands.resolveWorktreeGithub);
    const real = resolved.getMockImplementation()!;
    resolved.mockImplementationOnce(
      (path, branch) =>
        new Promise((done) => (finish = () => done(real(path, branch))))
    );
    const refreshed = refreshWorktreePr(WT, BRANCH);
    expect(prEntryOf(worktreePrKey(WT, BRANCH)).read.status).toBe(
      "refreshing"
    );

    resetProjectScopedStores();
    finish();
    expect(await refreshed).toBe(false);
    expect(useWorktreePrStore.getState().entries).toEqual({});
  });
});
