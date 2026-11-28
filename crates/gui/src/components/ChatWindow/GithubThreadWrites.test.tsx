/**
 * Public writes from a GitHub thread's card, in the diff's thread group and
 * the Review rail, and from a private line discussion, against a synthetic
 * GitHub (`example/demo-repo`, made-up people). The discussions run on the
 * real provider and controller; GitHub answers each write as told.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useContext, useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  type GithubFailure,
  type GithubPrReviewThreads,
  type GithubReviewThread,
  type GithubThreadWrite,
} from "../../bindings";
import { useChatStore } from "../../stores/chatStore";
import { inlineDiscussionCatalog } from "../../test/inlineDiscussionCatalog";
import { SelectionDiscussionProvider } from "./SelectionDiscussionContext";
import { InlineSelectionDiscussion } from "./SelectionDiscussionThread";
import { SelectionDiscussionContext } from "./selectionDiscussionState";
import {
  SelectionDiscussions,
  captureCodeSelection,
} from "./selectionDiscussions";
import { parsePatch } from "../thread/toolChange/diffLineMapper";
import { GithubThreadGroup } from "./workspace/githubReview/GithubThreadCard";
import { ReviewRail } from "./workspace/githubReview/ReviewRail";
import { selectionSlot } from "./workspace/githubReview/SelectionGithub";
import { buildReviewModel } from "./workspace/githubReview/model";
import {
  anchored,
  applyThreadWrite,
  at,
  reviewThread,
} from "./workspace/githubReview/fixture";
import { GithubComposer } from "./workspace/githubReview/GithubWriteControls";
import { DiffCommentThread } from "../thread/toolChange/DiffCommentThread";
import {
  DIFF_COMPOSER_GITHUB_SHORTCUT,
  DIFF_COMPOSER_SUBMIT_SHORTCUT,
  shortcutText,
} from "./chatShortcuts";
import {
  ThreadWrites,
  type WriteAnswer,
  type WritePort,
} from "./workspace/githubReview/threadWrites";
import {
  GithubWritesContext,
  type GithubWritesValue,
} from "./workspace/githubReview/threadWritesContext";

vi.mock("../../bindings", () => {
  const listener = () => ({ listen: vi.fn(async () => () => {}) });
  return {
    commands: {
      getSupportedLocalChatHarnesses: vi.fn(),
      createLocalChatSession: vi.fn(async () => ({ status: "ok" })),
      sendLocalChatMessage: vi.fn(async () => ({ status: "ok", data: null })),
      interruptLocalChatTurn: vi.fn(async () => ({ status: "ok", data: null })),
      closeLocalChatSession: vi.fn(async () => ({ status: "ok" })),
      checkReviewAnchorWorktree: vi.fn(),
      getProjects: vi.fn(),
      captureReviewAnchor: vi.fn(),
      mapReviewThreads: vi.fn(),
      mapReviewSelection: vi.fn(),
      loadLocalChatSessionIndex: vi.fn(async () => ({
        status: "ok",
        data: [],
      })),
      listReviewThreads: vi.fn(async () => ({ status: "ok", data: [] })),
      readReviewAnchor: vi.fn(async () => ({ status: "ok", data: "selected" })),
      putReviewThread: vi.fn(async () => ({ status: "ok", data: null })),
    },
    events: {
      localChatTextEvent: listener(),
      localChatSessionEndEvent: listener(),
      localChatSessionErrorEvent: listener(),
      localChatToolCallEvent: listener(),
      localChatToolResultEvent: listener(),
      localChatSessionInitEvent: listener(),
      localChatTurnStartedEvent: listener(),
      localChatSessionTitleEvent: listener(),
      localChatSessionUsageEvent: listener(),
      localChatFileChangeEvent: listener(),
      permissionRequestEvent: listener(),
      localChatSessionWarningEvent: listener(),
      localChatCompactionEvent: listener(),
      localChatAnnotationEvent: listener(),
      reviewThreadChanged: listener(),
      reviewThreadCatalogRecovered: listener(),
    },
  };
});

const VIEWER = "octo-viewer";
const THREAD = "PRRT_kwDOsynthetic1";
const PR_URL = "https://github.com/example/demo-repo/pull/7";

/**
 * How GitHub answers a write. `timeout_applied`: no answer, though it
 * landed, and the read right after shows it; `timeout_unread`: the same, but
 * that read failed, so only Retry's check can tell.
 */
type Answer =
  | "posted"
  | "forbidden"
  | "transient"
  | "timeout_applied"
  | "timeout_unread";
const SCOPE = "example/demo-repo#7";

/** A synthetic GitHub: its threads, what it was sent, how it answers next. */
class World {
  threads: GithubReviewThread[] = [];
  sends: GithubThreadWrite[] = [];
  answers: Answer[] = [];
  private listeners = new Set<() => void>();
  private nodes = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  snapshot = () => this.threads;
  pr = (): GithubPrReviewThreads => ({
    repo: "example/demo-repo",
    prNumber: 7,
    pullRequestId: "PR_kwDOsynthetic7",
    viewerLogin: VIEWER,
    headOid: "1".repeat(40),
    baseOid: "2".repeat(40),
    threads: this.threads,
    truncated: false,
  });
  async send(write: GithubThreadWrite): Promise<WriteAnswer> {
    this.sends.push(write);
    const answer = this.answers.shift() ?? "posted";
    const id = `PRRT_started${++this.nodes}`;
    if (
      answer === "posted" ||
      answer === "timeout_applied" ||
      answer === "timeout_unread"
    ) {
      this.threads = applyThreadWrite(this.threads, write, VIEWER, id);
      this.listeners.forEach((listener) => listener());
    }
    const threads = answer === "timeout_unread" ? null : this.pr();
    if (answer === "posted")
      return {
        outcome: {
          ok: true,
          data: write.kind === "start" ? id : write.threadId,
        },
        threads,
      };
    const kind: GithubFailure["kind"] =
      answer === "forbidden"
        ? "forbidden"
        : answer === "transient"
          ? "other"
          : "ambiguous";
    return {
      outcome: {
        ok: false,
        failure: { kind, message: "GitHub returned 502", retryAfterSecs: null },
      },
      threads,
    };
  }
}

let world: World;
let store: ThreadWrites;
let controller: SelectionDiscussions;
let live!: NonNullable<React.ContextType<typeof SelectionDiscussionContext>>;

function writesValue(threads: GithubReviewThread[]): GithubWritesValue {
  return {
    store,
    scope: SCOPE,
    worktreePath: "/A",
    pr: { number: 7, url: PR_URL },
    viewer: VIEWER,
    threads: { ...world.pr(), threads },
    port: (started) => ({
      scope: SCOPE,
      shown: () => world.pr(),
      send: (write) => world.send(write),
      reread: async () => world.pr(),
      started,
    }),
  };
}

function Probe() {
  live = useContext(SelectionDiscussionContext)!;
  return null;
}

type Surface = "diff" | "rail";

/** One thread in one surface; `line` stands for the shown comparison. */
function ThreadSurface({ surface, line }: { surface: Surface; line: number }) {
  const threads = useSyncExternalStore(world.subscribe, world.snapshot);
  const [open, setOpen] = useState(false);
  const model = buildReviewModel(
    7,
    threads,
    threads.map((thread) => at(thread.id, anchored(line))),
    false
  );
  const placed = model.byThread.get(THREAD)!;
  return (
    <GithubWritesContext.Provider value={writesValue(threads)}>
      {surface === "diff" ? (
        open ? (
          <GithubThreadGroup
            label={`GitHub threads on line ${line}`}
            threads={[placed]}
            onClose={() => setOpen(false)}
          />
        ) : (
          <button type="button" onClick={() => setOpen(true)}>
            Open thread
          </button>
        )
      ) : (
        <ReviewRail
          prNumber={7}
          model={model}
          loading={false}
          error={null}
          threads={{
            inline: open ? new Set([THREAD]) : new Set(),
            select: () => setOpen(true),
            closeInline: () => setOpen(false),
          }}
          onClose={() => {}}
        />
      )}
    </GithubWritesContext.Provider>
  );
}

function tree(surface: Surface, line = 1, onAttachGithub = vi.fn()) {
  return (
    <SelectionDiscussionProvider
      controller={controller}
      snapshot={{
        wholeBranch: true,
        files: [fixtureFile],
        comparison: {
          base_commit: "a".repeat(40),
          selected_base_commit: "a".repeat(40),
          target_commit: line === 1 ? "b".repeat(40) : "c".repeat(40),
          working_tree: true,
          merge_base: false,
        },
      }}
      worktreePath="/A"
      parentChatId="main-chat"
      projectPath="/project"
      harness="claude"
      onOpen={vi.fn()}
      onAttach={vi.fn()}
      onAttachGithub={onAttachGithub}
      githubThreads={world.threads}
    >
      <Probe />
      <ThreadSurface surface={surface} line={line} />
    </SelectionDiscussionProvider>
  );
}

async function openCard(surface: Surface) {
  fireEvent.click(
    surface === "diff"
      ? screen.getByRole("button", { name: "Open thread" })
      : screen.getByRole("button", { name: /^line \d+/ })
  );
  return screen.findByRole("region", { name: /^GitHub thread from alice/ });
}

const replyBox = () =>
  screen.queryByRole("textbox", { name: "Reply to alice on GitHub" });

async function draftReply(card: HTMLElement, text: string) {
  fireEvent.click(
    within(card).getByRole("button", { name: "Reply on GitHub" })
  );
  const box = replyBox()!;
  fireEvent.change(box, { target: { value: text } });
  return box;
}

const fixtureFile = parsePatch(
  "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+selected\n"
)[0];

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().reset();
  world = new World();
  world.threads = [
    reviewThread(THREAD, {
      path: "a",
      line: 1,
      author: "alice",
      body: "Why retry here?",
    }),
  ];
  store = new ThreadWrites();
  controller = new SelectionDiscussions();
  vi.mocked(commands.getProjects).mockResolvedValue({
    status: "ok",
    data: [{ path: "/project", project_id: "project-1" }],
  } as never);
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({
    status: "ok",
    data: null,
  });
  vi.mocked(commands.captureReviewAnchor).mockResolvedValue({
    status: "ok",
    data: {
      originalBlobId: "blob",
      originalCommitId: "commit",
      code: "selected\n",
    },
  });
  vi.mocked(commands.mapReviewThreads).mockResolvedValue({
    status: "ok",
    data: [],
  });
  vi.mocked(commands.getSupportedLocalChatHarnesses).mockResolvedValue({
    status: "ok",
    data: inlineDiscussionCatalog,
  });
});
afterEach(() => vi.useRealTimers());

describe.each<Surface>(["diff", "rail"])(
  "a GitHub thread's card in the %s",
  (surface) => {
    it("keeps a posted reply when its resolve fails, and offers the resolve again", async () => {
      render(tree(surface));
      const card = await openCard(surface);
      // The target and audience are named before anything posts.
      await draftReply(card, "Fixed in the next push.");
      expect(
        within(card).getByText(
          "#7, line 1 · visible to everyone on the PR as octo-viewer"
        )
      ).toBeInTheDocument();
      expect(world.sends).toEqual([]);

      world.answers = ["posted", "transient"];
      await act(async () =>
        fireEvent.click(
          within(card).getByRole("button", { name: "Reply and resolve" })
        )
      );
      expect(world.sends.map(({ kind }) => kind)).toEqual(["reply", "resolve"]);
      expect(world.threads[0].comments.at(-1)).toMatchObject({
        author: { login: VIEWER },
        body: "Fixed in the next push.",
      });
      expect(replyBox()).toBeNull();
      const alert = within(card).getByRole("alert");
      expect(alert).toHaveTextContent("Reply posted. Resolve failed.");
      expect(alert).toHaveTextContent("Your reply is kept.");

      await act(async () =>
        fireEvent.click(
          within(alert).getByRole("button", { name: "Retry resolve" })
        )
      );
      // Only the resolve is sent again; the reply posted once.
      expect(world.sends.map(({ kind }) => kind)).toEqual([
        "reply",
        "resolve",
        "resolve",
      ]);
      expect(world.threads[0].resolved).toBe(true);
      expect(within(card).queryByRole("alert")).toBeNull();
    });

    it("offers no Retry after a 403 on resolve, only Resolve on GitHub", async () => {
      render(tree(surface));
      const card = await openCard(surface);
      world.answers = ["forbidden"];
      await act(async () =>
        fireEvent.click(within(card).getByRole("button", { name: "Resolve" }))
      );
      const alert = within(card).getByRole("alert");
      expect(alert).toHaveTextContent("GitHub refused the resolve.");
      expect(
        within(alert).queryByRole("button", { name: /retry/i })
      ).toBeNull();
      expect(
        within(alert).getByRole("button", { name: "Resolve on GitHub" })
      ).toBeInTheDocument();
      // GitHub said no: no live Resolve contradicts the alert, here or as
      // the composer's Reply and resolve.
      expect(
        within(card).queryByRole("button", { name: "Resolve" })
      ).toBeNull();
      fireEvent.click(
        within(card).getByRole("button", { name: "Reply on GitHub" })
      );
      const composer = within(card).getByRole("region", {
        name: "Reply on GitHub",
      });
      // The thread's failure stays with the thread, not in the reply.
      expect(within(composer).queryByRole("alert")).toBeNull();
      expect(within(card).getByRole("alert")).toBe(alert);
      expect(
        within(composer).queryByRole("button", { name: "Reply and resolve" })
      ).toBeNull();
      expect(world.sends).toHaveLength(1);
    });

    it("hides Resolve and Reopen up front without GitHub's permission", async () => {
      world.threads = [
        { ...world.threads[0], viewerCanResolve: false, viewerCanReply: false },
      ];
      const view = render(tree(surface));
      let card = await openCard(surface);
      expect(
        within(card).queryByRole("button", { name: "Resolve" })
      ).toBeNull();
      expect(
        within(card).queryByRole("button", { name: "Reply on GitHub" })
      ).toBeNull();

      act(() => {
        world.threads = [
          { ...world.threads[0], resolved: true, viewerCanUnresolve: false },
        ];
      });
      view.rerender(tree(surface, 2));
      card = screen.getByRole("region", { name: /^GitHub thread from alice/ });
      expect(within(card).queryByRole("button", { name: "Reopen" })).toBeNull();

      world.threads = [{ ...world.threads[0], viewerCanUnresolve: true }];
      view.rerender(tree(surface, 1));
      card = screen.getByRole("region", { name: /^GitHub thread from alice/ });
      await act(async () =>
        fireEvent.click(within(card).getByRole("button", { name: "Reopen" }))
      );
      expect(world.sends).toEqual([{ kind: "reopen", threadId: THREAD }]);
      expect(world.threads[0].resolved).toBe(false);
    });

    it("unfolds a folded resolved thread once it is open again", async () => {
      world.threads = [{ ...world.threads[0], resolved: true }];
      const view = render(tree(surface));
      let card = await openCard(surface);
      expect(
        within(card).getByRole("button", { name: "Show" })
      ).toHaveAttribute("aria-expanded", "false");

      // Reopened, here or on GitHub: open threads are never folded.
      world.threads = [{ ...world.threads[0], resolved: false }];
      view.rerender(tree(surface, 2));
      card = screen.getByRole("region", { name: /^GitHub thread from alice/ });
      expect(within(card).queryByRole("button", { name: "Show" })).toBeNull();
      expect(within(card).getByRole("list")).toBeVisible();
    });

    it("keeps a reply that failed to post; Discard then Undo brings it back", async () => {
      render(tree(surface));
      const card = await openCard(surface);
      const box = await draftReply(card, "Thanks, fixed.");
      world.answers = ["transient"];
      await act(async () =>
        fireEvent.click(
          within(card).getByRole("button", { name: "Reply on GitHub" })
        )
      );
      expect(box).toHaveValue("Thanks, fixed.");
      const alert = within(card).getByRole("alert");
      expect(alert).toHaveTextContent("Reply didn’t post.");
      expect(alert).toHaveTextContent("Your draft is kept.");
      expect(
        within(alert).getByRole("button", { name: "Retry reply" })
      ).toBeInTheDocument();

      fireEvent.click(within(card).getByRole("button", { name: "Discard" }));
      expect(replyBox()).toBeNull();
      expect(within(card).getByRole("status")).toHaveTextContent(
        "Reply on GitHub draft discarded."
      );
      fireEvent.click(within(card).getByRole("button", { name: "Undo" }));
      expect(replyBox()).toHaveValue("Thanks, fixed.");
      expect(world.sends).toHaveLength(1);
    });

    it("settles a timed-out reply that landed from the read after it, with no alert", async () => {
      render(tree(surface));
      const card = await openCard(surface);
      await draftReply(card, "Done.");
      world.answers = ["timeout_applied"];
      await act(async () =>
        fireEvent.click(
          within(card).getByRole("button", { name: "Reply on GitHub" })
        )
      );
      expect(world.sends).toHaveLength(1);
      expect(replyBox()).toBeNull();
      expect(within(card).queryByRole("alert")).toBeNull();
      expect(within(card).getByText("Done.")).toBeInTheDocument();
    });

    it("checks the thread after a timeout it could not read and does not post a reply that landed", async () => {
      render(tree(surface));
      const card = await openCard(surface);
      await draftReply(card, "Done.");
      world.answers = ["timeout_unread"];
      await act(async () =>
        fireEvent.click(
          within(card).getByRole("button", { name: "Reply on GitHub" })
        )
      );
      expect(within(card).getByRole("alert")).toHaveTextContent(
        "GitHub didn’t confirm the reply."
      );
      await act(async () =>
        fireEvent.click(
          within(card).getByRole("button", { name: "Check thread and retry" })
        )
      );
      expect(world.sends).toHaveLength(1);
      expect(replyBox()).toBeNull();
      expect(within(card).queryByRole("alert")).toBeNull();
    });

    it("posts the primary post on a single ⌘↵, naming it in the hint", async () => {
      render(tree(surface));
      const card = await openCard(surface);
      const box = await draftReply(card, "Ship it.");
      // The primary post is Reply and resolve where the viewer may resolve.
      expect(within(card).getByRole("status")).toHaveTextContent(
        `${shortcutText(DIFF_COMPOSER_SUBMIT_SHORTCUT)} reply and resolve`
      );
      fireEvent.keyDown(box, { key: "Enter", metaKey: true, repeat: true });
      expect(world.sends).toEqual([]);
      await act(async () =>
        fireEvent.keyDown(box, { key: "Enter", metaKey: true })
      );
      expect(world.sends.map(({ kind }) => kind)).toEqual(["reply", "resolve"]);
    });

    it("keeps the public reply and the private question apart through closing and a comparison switch", async () => {
      const attach = vi.fn();
      const view = render(tree(surface, 1, attach));
      let card = await openCard(surface);
      await waitFor(() => expect(live.canAsk).toBe(true));
      fireEvent.click(
        within(card).getByRole("button", { name: "Discuss inline" })
      );
      const question = await screen.findByRole("textbox", {
        name: "Ask about this GitHub thread",
      });
      fireEvent.change(question, { target: { value: "Is it idempotent?" } });
      // Drafted from the discussion, posted only by its own action.
      fireEvent.click(
        within(card).getByRole("button", { name: "Draft reply" })
      );
      fireEvent.change(replyBox()!, { target: { value: "Yes: it is." } });

      // Esc in the reply closes the card; the drafts stay.
      fireEvent.keyDown(replyBox()!, { key: "Escape" });
      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: /^GitHub thread from alice/ })
        ).toBeNull()
      );
      view.rerender(tree(surface, 2, attach));
      card = await openCard(surface);
      expect(replyBox()).toHaveValue("Yes: it is.");
      if (
        !screen.queryByRole("textbox", { name: "Ask about this GitHub thread" })
      )
        fireEvent.click(
          within(card).getByRole("button", { name: "Show private discussion" })
        );
      expect(
        screen.getByRole("textbox", { name: "Ask about this GitHub thread" })
      ).toHaveValue("Is it idempotent?");

      fireEvent.click(
        within(
          screen.getByRole("region", { name: "Private discussion" })
        ).getByRole("button", { name: "Send to main chat" })
      );
      expect(attach).toHaveBeenCalledTimes(1);
      expect(world.sends).toEqual([]);
      expect(replyBox()).toHaveValue("Yes: it is.");

      await act(async () =>
        fireEvent.click(
          within(card).getByRole("button", { name: "Reply on GitHub" })
        )
      );
      expect(world.sends).toEqual([
        { kind: "reply", threadId: THREAD, body: "Yes: it is." },
      ]);
      expect(
        screen.getByRole("textbox", { name: "Ask about this GitHub thread" })
      ).toHaveValue("Is it idempotent?");
    });
  }
);

describe("Comment on GitHub from a line discussion", () => {
  const anchor = captureCodeSelection(
    fixtureFile,
    { start: 1, end: 1, side: "additions" },
    { kind: "worktree", wholeBranch: true }
  )!;

  function LineDiscussion() {
    const discussion = useContext(SelectionDiscussionContext)!;
    return (
      <>
        <button
          type="button"
          onClick={() => void discussion.discuss(anchor, "")}
        >
          Start discussion
        </button>
        {discussion.threads.map((thread) => (
          <InlineSelectionDiscussion key={thread.id} threadId={thread.id} />
        ))}
      </>
    );
  }

  function lineTree() {
    return (
      <SelectionDiscussionProvider
        controller={controller}
        snapshot={null}
        worktreePath="/A"
        parentChatId="main-chat"
        projectPath="/project"
        harness="claude"
        onOpen={vi.fn()}
        onAttach={vi.fn()}
      >
        <Probe />
        <GithubWritesContext.Provider value={writesValue(world.threads)}>
          <LineDiscussion />
        </GithubWritesContext.Provider>
      </SelectionDiscussionProvider>
    );
  }

  async function startDiscussion() {
    await waitFor(() => expect(live.canAsk).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Start discussion" }));
    await screen.findByTestId("selection-mini-thread");
    return screen.findByRole("button", { name: "Comment on GitHub" });
  }

  const published = (status: "open" | "outdated" | "unavailable") =>
    vi
      .mocked(commands.mapReviewThreads)
      .mockImplementation(async (_worktree, requests) => ({
        status: "ok",
        data: requests.map(({ threadId, location }) =>
          // Only the PR head is asked about; other mappings find nothing.
          location.source.kind === "worktree" &&
          location.source.commit === "1".repeat(40)
            ? { threadId, startLine: 1, line: 1, status }
            : { threadId, startLine: null, line: null, status: "unavailable" }
        ),
      }));

  it("stays unavailable while the lines are not on the PR", async () => {
    published("outdated");
    render(lineTree());
    const button = await startDiscussion();
    await waitFor(() =>
      expect(button).toHaveAttribute(
        "title",
        "These lines aren’t on PR #7 yet · push them first"
      )
    );
    expect(button).toBeDisabled();
  });

  it("starts a thread on a published line and moves the discussion under it", async () => {
    published("open");
    render(lineTree());
    const button = await startDiscussion();
    await waitFor(() => expect(button).toBeEnabled());
    const id = live.threads[0].id;
    fireEvent.click(button);
    const box = screen.getByRole("textbox", { name: "Comment on GitHub" });
    expect(
      screen.getByText(
        "starts a thread on #7, a:1 · visible to everyone on the PR as octo-viewer"
      )
    ).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "Should this retry?" } });

    world.answers = ["transient"];
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Post comment" }))
    );
    // A failed post leaves the discussion on its lines, its draft kept.
    expect(box).toHaveValue("Should this retry?");
    expect(live.threads[0].githubThreadId).toBeNull();
    expect(commands.putReviewThread).not.toHaveBeenCalledWith(
      "project-1",
      id,
      expect.objectContaining({ kind: "github_thread" })
    );

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Retry comment" }))
    );
    expect(world.sends.at(-1)).toEqual({
      kind: "start",
      pullRequestId: "PR_kwDOsynthetic7",
      path: "a",
      side: "RIGHT",
      startLine: null,
      line: 1,
      body: "Should this retry?",
    });
    const started = world.threads.at(-1)!.id;
    expect(commands.putReviewThread).toHaveBeenCalledWith("project-1", id, {
      kind: "github_thread",
      githubThreadId: started,
    });
    // The same discussion, now under the new thread.
    expect(live.threads).toHaveLength(1);
    expect(live.threads[0]).toMatchObject({ id, githubThreadId: started });
  });
});

describe("Comment on GitHub from a selection", () => {
  const anchor = captureCodeSelection(
    fixtureFile,
    { start: 1, end: 1, side: "additions" },
    { kind: "worktree", wholeBranch: true }
  )!;
  const mapped = (
    status: "open" | "outdated" | "unavailable",
    line: number | null = 1
  ) =>
    vi.mocked(commands.mapReviewSelection).mockResolvedValue({
      status: "ok",
      data: { status, startLine: line, line },
    });

  function selectionTree(posted = vi.fn(), cancel = vi.fn()) {
    return (
      <SelectionDiscussionProvider
        controller={controller}
        snapshot={{
          wholeBranch: true,
          files: [fixtureFile],
          comparison: {
            base_commit: "a".repeat(40),
            selected_base_commit: "a".repeat(40),
            target_commit: "b".repeat(40),
            working_tree: true,
            merge_base: false,
          },
        }}
        worktreePath="/A"
        parentChatId="main-chat"
        projectPath="/project"
        harness="claude"
        onOpen={vi.fn()}
        onAttach={vi.fn()}
      >
        <GithubWritesContext.Provider value={writesValue(world.threads)}>
          <DiffCommentThread
            annotation={{ commentIds: [], draft: true }}
            draftAnchor={anchor}
            onGithubPosted={posted}
            onCancelDraft={cancel}
            onDiscussDraft={vi.fn()}
            onAttachDraft={vi.fn()}
          />
        </GithubWritesContext.Provider>
      </SelectionDiscussionProvider>
    );
  }

  const commentButton = () =>
    screen.findByRole("button", { name: "Comment on GitHub" });

  const draftBox = () =>
    screen.getByRole("textbox", { name: "New selection discussion" });
  const ready = async () => {
    const button = await commentButton();
    await waitFor(() => expect(button).toBeEnabled());
    return button;
  };
  const started = (line: number, body: string) => ({
    kind: "start",
    pullRequestId: "PR_kwDOsynthetic7",
    path: "a",
    side: "RIGHT",
    startLine: null,
    line,
    body,
  });

  it("posts the typed text straight to GitHub as a new thread and closes the selection", async () => {
    mapped("open", 3);
    const posted = vi.fn();
    render(selectionTree(posted));
    fireEvent.change(draftBox(), { target: { value: "  Rename this?  " } });
    const button = await ready();
    // The shown lines are mapped onto the PR head, nothing retained.
    expect(commands.mapReviewSelection).toHaveBeenCalledWith(
      "/A",
      { path: "a", side: "RIGHT", source: { kind: "worktree", commit: null } },
      { startLine: 1, line: 1 },
      {
        path: "a",
        side: "RIGHT",
        source: { kind: "worktree", commit: world.pr().headOid },
      }
    );
    expect(commands.captureReviewAnchor).not.toHaveBeenCalled();
    // Where it posts and who sees it, before it is sent.
    expect(button).toHaveAttribute(
      "title",
      expect.stringContaining(
        "Post to PR #7, a:3 · visible to everyone on the PR as octo-viewer"
      )
    );
    expect(button).toHaveAttribute("aria-keyshortcuts", "Meta+Alt+Enter");
    expect(world.sends).toEqual([]);

    await act(async () => fireEvent.click(button));
    // One click posts; no second composer, no private discussion.
    expect(world.sends).toEqual([started(3, "Rename this?")]);
    expect(
      screen.queryByRole("textbox", { name: "Comment on GitHub" })
    ).toBeNull();
    expect(posted).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().threads).toEqual([]);
  });

  it("posts on ⌘⌥↵ from the selection box", async () => {
    mapped("open", 3);
    const posted = vi.fn();
    render(selectionTree(posted));
    fireEvent.change(draftBox(), { target: { value: "Rename this?" } });
    await ready();
    // The hint names where the key posts, and as whom.
    expect(draftBox().closest(".diff-comment-editor")).toHaveTextContent(
      `${shortcutText(DIFF_COMPOSER_GITHUB_SHORTCUT)} comment on GitHub → #7 a:3 as octo-viewer`
    );
    // ⌘⇧⌥↵ is not the GitHub key.
    fireEvent.keyDown(draftBox(), {
      key: "Enter",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(world.sends).toEqual([]);

    await act(async () =>
      fireEvent.keyDown(draftBox(), {
        key: "Enter",
        metaKey: true,
        altKey: true,
      })
    );
    expect(world.sends).toEqual([started(3, "Rename this?")]);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it("does nothing on ⌘⌥↵ while the lines aren’t on the PR, saying why on the button", async () => {
    mapped("outdated", null);
    const posted = vi.fn();
    render(selectionTree(posted));
    fireEvent.change(draftBox(), { target: { value: "Rename this?" } });
    const button = await commentButton();
    await waitFor(() =>
      expect(button).toHaveAttribute(
        "title",
        "These lines aren’t on PR #7 yet · push them first"
      )
    );
    expect(button).toBeDisabled();
    fireEvent.keyDown(draftBox(), {
      key: "Enter",
      metaKey: true,
      altKey: true,
    });
    expect(world.sends).toEqual([]);
    expect(posted).not.toHaveBeenCalled();
    expect(draftBox()).toHaveValue("Rename this?");
  });

  it("is unavailable with no text to post", async () => {
    mapped("open");
    render(selectionTree());
    const button = await commentButton();
    await waitFor(() => expect(commands.mapReviewSelection).toHaveBeenCalled());
    expect(button).toBeDisabled();
  });

  it("keeps the text and offers a retry when the post fails", async () => {
    mapped("open", 3);
    const posted = vi.fn();
    world.answers = ["transient"];
    render(selectionTree(posted));
    fireEvent.change(draftBox(), { target: { value: "Rename this?" } });
    const button = await ready();

    await act(async () => fireEvent.click(button));
    expect(screen.getByText("Comment didn’t post.")).toBeVisible();
    expect(draftBox()).toHaveValue("Rename this?");
    expect(posted).not.toHaveBeenCalled();

    // The retry posts the text as it is now.
    fireEvent.change(draftBox(), { target: { value: "Rename this, please?" } });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Retry comment" }))
    );
    expect(world.sends).toEqual([
      started(3, "Rename this?"),
      started(3, "Rename this, please?"),
    ]);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it("holds the text as sent while the post is out", async () => {
    mapped("open", 3);
    const posted = vi.fn();
    const cancel = vi.fn();
    let answer!: () => void;
    const send = world.send.bind(world);
    world.send = (write) =>
      new Promise((resolve) => {
        answer = () => resolve(send(write));
      });
    render(selectionTree(posted, cancel));
    fireEvent.change(draftBox(), { target: { value: "Rename this?" } });
    const button = await ready();

    await act(async () => fireEvent.click(button));
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(draftBox()).toHaveAttribute("readonly");
    fireEvent.keyDown(draftBox(), { key: "Enter", metaKey: true });
    fireEvent.keyDown(draftBox(), { key: "Escape" });
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => answer());
    expect(world.sends).toEqual([started(3, "Rename this?")]);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it("checks GitHub before posting again after a timeout, so nothing posts twice", async () => {
    mapped("open", 3);
    const posted = vi.fn();
    world.answers = ["timeout_unread"];
    render(selectionTree(posted));
    fireEvent.change(draftBox(), { target: { value: "Rename this?" } });
    const button = await ready();

    await act(async () => fireEvent.click(button));
    expect(
      screen.getByText("GitHub didn’t confirm the comment.")
    ).toBeVisible();
    await act(async () =>
      fireEvent.keyDown(draftBox(), {
        key: "Enter",
        metaKey: true,
        altKey: true,
      })
    );
    expect(world.sends).toHaveLength(1);
    expect(posted).toHaveBeenCalledTimes(1);
  });

  it("holds the text as sent after a timeout, until the check says what happened", async () => {
    mapped("open", 3);
    world.answers = ["timeout_unread"];
    render(selectionTree());
    fireEvent.change(draftBox(), { target: { value: "Rename this?" } });
    const button = await ready();
    await act(async () => fireEvent.click(button));
    expect(
      screen.getByText("GitHub didn’t confirm the comment.")
    ).toBeVisible();
    // An edit now would be lost if the post landed.
    expect(draftBox()).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("forgets a failed post once the selection closes", async () => {
    mapped("open", 3);
    world.answers = ["transient"];
    const key = selectionSlot(SCOPE, anchor);
    const { unmount } = render(selectionTree());
    fireEvent.change(draftBox(), { target: { value: "Rename this?" } });
    const button = await ready();
    await act(async () => fireEvent.click(button));
    expect(store.slot(key).failure).not.toBeNull();
    act(() => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(store.slot(key)).toEqual(store.slot("never-used"));

    world.answers = ["transient"];
    fireEvent.change(draftBox(), { target: { value: "Again?" } });
    await ready();
    await act(async () => fireEvent.click(button));
    expect(store.slot(key).failure).not.toBeNull();
    unmount();
    expect(store.slot(key)).toEqual(store.slot("never-used"));
  });

  it("tells lines it cannot check apart from lines that need pushing", async () => {
    mapped("unavailable", null);
    const view = render(selectionTree());
    fireEvent.change(draftBox(), { target: { value: "Rename this?" } });
    const button = await commentButton();
    await waitFor(() =>
      expect(button).toHaveAttribute(
        "title",
        expect.stringContaining("Can’t check these lines against PR #7")
      )
    );
    expect(button).toBeDisabled();
    expect(button.title).not.toContain("push them first");
    view.unmount();

    vi.mocked(commands.mapReviewSelection).mockRejectedValue(
      new Error("Git could not load the review anchor.")
    );
    render(selectionTree());
    const failed = await commentButton();
    await waitFor(() =>
      expect(failed).toHaveAttribute(
        "title",
        expect.stringContaining("Can’t check these lines")
      )
    );

    mapped("outdated", null);
    cleanup();
    render(selectionTree());
    const changed = await commentButton();
    await waitFor(() =>
      expect(changed).toHaveAttribute(
        "title",
        expect.stringContaining("push them first")
      )
    );
    expect(world.sends).toEqual([]);
  });

  it("is not offered with no PR to post to", async () => {
    mapped("open");
    render(
      <DiffCommentThread
        annotation={{ commentIds: [], draft: true }}
        draftAnchor={anchor}
        onCancelDraft={vi.fn()}
        onDiscussDraft={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: "Discuss inline" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Comment on GitHub" })
    ).toBeNull();
  });
});

describe("A GitHub composer coming into view", () => {
  function Composer({ store }: { store: ThreadWrites }) {
    return (
      <GithubComposer
        store={store}
        slotKey="slot"
        title="Comment on GitHub"
        audience="starts a thread on #7, a:1"
        textLabel="Comment on GitHub"
        placeholder="Write a comment…"
        posts={[]}
        // Nothing posts here.
        port={{} as WritePort}
        url={null}
      />
    );
  }
  const scrolled = () =>
    vi
      .mocked(Element.prototype.scrollIntoView)
      .mock.contexts.filter(
        (element) =>
          element instanceof Element && element.matches(".gh-composer")
      );

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("is scrolled to and focused when opened or brought back by Undo", () => {
    const writes = new ThreadWrites();
    render(<Composer store={writes} />);
    expect(scrolled()).toHaveLength(0);

    act(() => writes.open("slot", "Draft"));
    const box = screen.getByRole("textbox", { name: "Comment on GitHub" });
    expect(box).toHaveFocus();
    expect(scrolled()).toHaveLength(1);
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({
      block: "nearest",
    });

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    // The focused text is gone; focus moves to Undo, not the page.
    expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      screen.getByRole("textbox", { name: "Comment on GitHub" })
    ).toHaveFocus();
    expect(scrolled()).toHaveLength(2);
  });

  it("leaves a kept draft where it is when shown again", () => {
    const writes = new ThreadWrites();
    writes.open("slot", "Kept");
    render(<Composer store={writes} />);

    expect(
      screen.getByRole("textbox", { name: "Comment on GitHub" })
    ).not.toHaveFocus();
    expect(scrolled()).toHaveLength(0);
  });
});
