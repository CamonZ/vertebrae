import { inlineDiscussionCatalog } from "../../test/inlineDiscussionCatalog";
import { useUIStore } from "../../stores/uiStore";
import { useProviderSettingsStore } from "../../stores/providerSettingsStore";
import { SelectionDiscussionContext } from "./selectionDiscussionState";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { ContextType } from "react";
import { useDiffComments } from "../../hooks/useDiffComments";
import { DiffReviewContext } from "../thread/toolChange/DiffReviewContext";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useContext } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  LocalChatTextEvent,
  LocalChatSessionEndEvent,
  LocalChatSessionErrorEvent,
  LocalChatSessionInitEvent,
  LocalChatToolCallEvent,
  LocalChatToolResultEvent,
  LocalChatTurnStartedEvent,
} from "../../bindings";
import { commands, events, type ReviewThread } from "../../bindings";
import { useChatStore } from "../../stores/chatStore";
import { flushPendingLocalChatText } from "../../utils/localChatTextBatch";
import {
  resetLocalChatTurnRoutingForTests,
  useLocalChatEventRouter,
} from "../../hooks/useLocalChatEventRouter";
import {
  SelectionDiscussionProvider,
  DiscussionSnapshot,
  InlineSelectionDiscussion,
} from "./SelectionDiscussionContext";
import { captureCodeSelection, isOutdated } from "./selectionDiscussions";
import { parsePatch } from "../thread/toolChange/diffLineMapper";

const transport = vi.hoisted(() => ({
  text: null as ((event: { payload: LocalChatTextEvent }) => void) | null,
  end: null as ((event: { payload: LocalChatSessionEndEvent }) => void) | null,
  error: null as
    | ((event: { payload: LocalChatSessionErrorEvent }) => void)
    | null,
  toolCall: null as
    | ((event: { payload: LocalChatToolCallEvent }) => void)
    | null,
  toolResult: null as
    | ((event: { payload: LocalChatToolResultEvent }) => void)
    | null,
  init: null as
    | ((event: { payload: LocalChatSessionInitEvent }) => void)
    | null,
  started: null as
    | ((event: { payload: LocalChatTurnStartedEvent }) => void)
    | null,
  unlisten: vi.fn(),
}));

vi.mock("../../bindings", () => {
  const listener = (key?: keyof typeof transport) => ({
    listen: vi.fn(async (handler: never) => {
      if (key) (transport as Record<string, unknown>)[key] = handler;

      return transport.unlisten;
    }),
  });

  return {
    commands: {
      getSupportedLocalChatHarnesses: vi.fn(),
      createLocalChatSession: vi.fn(async () => ({ status: "ok" })),
      sendLocalChatMessage: vi.fn(async () => ({ status: "ok", data: null })),
      interruptLocalChatTurn: vi.fn(async () => ({ status: "ok", data: null })),
      closeLocalChatSession: vi.fn(async () => ({ status: "ok" })),
      checkReviewAnchorWorktree: vi.fn(),
      getProjects: vi.fn(async () => ({ status: "ok", data: [] })),
      captureReviewAnchor: vi.fn(),
      mapReviewThreads: vi.fn(),
      loadLocalChatSessionIndex: vi.fn(async () => ({ status: "ok", data: [] })),
      listReviewThreads: vi.fn(async () => ({ status: "ok", data: [] })),
      readReviewAnchor: vi.fn(async () => ({ status: "ok", data: "selected" })),
      putReviewThread: vi.fn(async () => ({ status: "ok", data: null })),
    },
    events: {
      localChatTextEvent: listener("text"),
      localChatSessionEndEvent: listener("end"),
      localChatSessionErrorEvent: listener("error"),
      localChatToolCallEvent: listener("toolCall"),
      localChatToolResultEvent: listener("toolResult"),
      localChatSessionInitEvent: listener("init"),
      localChatTurnStartedEvent: listener("started"),
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

const fixturePatch =
  "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+selected\n";
const fixtureFile = parsePatch(fixturePatch)[0];
const anchor = captureCodeSelection(
  fixtureFile,
  { start: 1, end: 1, side: "additions" },
  { kind: "worktree", wholeBranch: true }
)!;

let liveDiscussion!: NonNullable<
  ContextType<typeof SelectionDiscussionContext>
>;

function Controls({ showThreads = true }: { showThreads?: boolean }) {
  const context = useContext(SelectionDiscussionContext)!;

  liveDiscussion = context;

  return (
    <>
      <button onClick={() => context.select(anchor)}>Select fixture</button>
      <button onClick={() => {
        if (context.selection) void context.discuss(context.selection, "");
      }}>Open mini</button>
      <button onClick={() => context.attach(anchor)}>Attach fixture</button>
      {showThreads && context.threads.map((thread) => (
        <InlineSelectionDiscussion key={thread.id} threadId={thread.id} />
      ))}
    </>
  );
}

/** The thread's screen-reader turn status. */
function announcement() {
  const status = document.querySelector(
    "[data-testid='selection-mini-thread'] p.sr-only[role='status']"
  );

  expect(status).not.toBeNull();
  return status!;
}

/** Discussion sessions in the chat store. */
function discussionSessions() {
  return Object.values(useChatStore.getState().sessions).filter(
    (session) => session.discussion
  );
}

// The app's always-mounted router delivers harness events to chat sessions.
function Router() {
  useLocalChatEventRouter();

  return null;
}

function fixture(scope = "A", onAttach = vi.fn(), parentChatId = `parent-${scope}`, projectPath = "/project") {
  return (
    <SelectionDiscussionProvider
      key={scope}
      worktreePath={`/${scope}`}
      parentChatId={parentChatId}
      projectPath={projectPath}
      harness="claude"
      onOpen={vi.fn()}
      onAttach={onAttach}
    >
      <Controls />
    </SelectionDiscussionProvider>
  );
}

// The harness reports a new provider turn id for every turn it starts.
const turnIds = new Map<string, string>();
let turnSequence = 0;

function startTurn(backend: string) {
  const turn_id = `turn-${++turnSequence}`;

  turnIds.set(backend, turn_id);
  act(() =>
    transport.started?.({
      payload: {
        backend_session_id: backend,
        harness: "claude",
        turn_id,
        is_root: true,
      },
    })
  );
}

async function open() {
  await waitFor(() => expect(liveDiscussion.canAsk).toBe(true));
  fireEvent.click(screen.getByText("Select fixture"));
  fireEvent.click(screen.getByText("Open mini"));
  await screen.findByTestId("selection-mini-thread");
}

async function send(text = "Question") {
  const composer = screen.getByRole("textbox", {
    name: "Ask about selected code",
  });
  const askButton = screen.getByRole("button", { name: "Ask" });

  fireEvent.change(composer, { target: { value: text } });

  await waitFor(() => {
    expect(askButton).toBeEnabled();
  });

  const sends = vi.mocked(commands.sendLocalChatMessage).mock.calls.length;
  const creates = vi.mocked(commands.createLocalChatSession).mock.calls.length;

  fireEvent.click(askButton);

  await waitFor(() => {
    const sent = vi.mocked(commands.sendLocalChatMessage).mock.calls.length;
    const made = vi.mocked(commands.createLocalChatSession).mock.calls.length;

    expect(sent + made).toBeGreaterThan(sends + creates);
  });

  const sent = vi.mocked(commands.sendLocalChatMessage).mock.calls;
  const backend =
    sent.length > sends
      ? sent.at(-1)![0]
      : vi.mocked(commands.createLocalChatSession).mock.calls.at(-1)![0]
          .backend_session_id;

  startTurn(backend);

  return backend;
}

function end(
  id: string,
  handler = transport.end,
  completion_status = "completed"
) {
  handler?.({
    payload: {
      backend_session_id: id,
      harness: "claude",
      turn_id: turnIds.get(id) ?? "turn",
      is_root: true,
      completion_status,
      duration_ms: 1,
      cost_usd: 0,
      num_turns: 1,
      result: "",
      is_error: false,
      context_tokens: 0,
      context_window: 0,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState().reset();
  resetLocalChatTurnRoutingForTests();
  vi.mocked(commands.checkReviewAnchorWorktree).mockReset().mockResolvedValue({ status: "ok", data: null });
  vi.mocked(commands.captureReviewAnchor).mockReset().mockResolvedValue({
    status: "ok", data: { originalBlobId: "blob", originalCommitId: "commit" },
  });
  vi.mocked(commands.mapReviewThreads).mockReset().mockResolvedValue({ status: "ok", data: [] });
  render(<Router />);

  useUIStore.setState({
    inlineDiscussionPreference: { mode: "follow" },
    thinkingIndicatorStyle: "shimmer",
  });

  const catalogCommand = vi.mocked(commands.getSupportedLocalChatHarnesses);

  catalogCommand.mockResolvedValue({
    status: "ok",
    data: inlineDiscussionCatalog,
  });

  const createSession = vi.mocked(commands.createLocalChatSession);

  createSession.mockResolvedValue({
    status: "ok",
    data: null,
  });
});

it("selection, opening a thread and attaching are passive; explicit asks capture context", async () => {
  const attach = vi.fn();

  render(fixture("A", attach));
  await open();
  fireEvent.click(screen.getByText("Attach fixture"));

  expect(attach).toHaveBeenCalledWith(anchor);
  expect(commands.createLocalChatSession).not.toHaveBeenCalled();

  const id = await send();

  const selectedCodeMatcher = expect.stringContaining('"code":"selected"');
  const requestMatcher = expect.objectContaining({
    read_only: true,
    working_dir: "/A",
    provider_resume_id: null,
    initial_prompt: selectedCodeMatcher,
  });

  expect(commands.createLocalChatSession).toHaveBeenLastCalledWith(
    requestMatcher
  );

  act(() => {
    transport.text?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        text: "Partial",
        is_partial: true,
        parent_tool_use_id: null,
      },
    });
    transport.text?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        text: "Full answer",
        is_partial: false,
        parent_tool_use_id: null,
      },
    });
    end(id);
  });

  expect(screen.getByText("Full answer", { exact: false })).toBeVisible();

  const followUpId = await send("Follow up");

  // The follow-up is a new turn in the same session: one launch, one send,
  // and a payload with only the question.
  expect(followUpId).toBe(id);
  expect(commands.createLocalChatSession).toHaveBeenCalledOnce();
  expect(commands.sendLocalChatMessage).toHaveBeenCalledOnce();
  expect(commands.sendLocalChatMessage).toHaveBeenLastCalledWith(
    id,
    "Follow up",
    expect.objectContaining({ model_id: expect.any(String) })
  );
  expect(commands.closeLocalChatSession).not.toHaveBeenCalled();
});

it("cancels during creation and interrupts only the first turn of a runtime that appears late", async () => {
  let complete!: (
    value: Awaited<ReturnType<typeof commands.createLocalChatSession>>
  ) => void;

  vi.mocked(commands.createLocalChatSession).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  render(fixture());
  await open();

  const id = await send();

  expect(screen.getByTestId("thinking-indicator")).toBeVisible();

  fireEvent.click(screen.getByText("Cancel response"));

  // Nothing to interrupt until the process exists.
  expect(screen.getByText("Stopping...")).toBeInTheDocument();
  expect(commands.interruptLocalChatTurn).not.toHaveBeenCalled();

  await act(async () => complete({ status: "ok", data: null }));

  expect(commands.interruptLocalChatTurn).toHaveBeenCalledWith(id);
  expect(commands.closeLocalChatSession).not.toHaveBeenCalled();

  act(() => end(id, transport.end, "interrupted"));

  expect(screen.queryByTestId("thinking-indicator")).toBeNull();

  // The session survives the cancel: the follow-up continues it.
  const followUp = await send("After cancel");

  expect(followUp).toBe(id);
  expect(commands.createLocalChatSession).toHaveBeenCalledOnce();
});

it("cancel interrupts the in-flight turn of a live session without closing it", async () => {
  render(fixture());
  await open();

  const id = await send();
  const text = (text: string) =>
    act(() => {
      transport.text?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text,
          turn_id: turnIds.get(id),
          is_root: true,
          is_partial: false,
          parent_tool_use_id: null,
        },
      });
      flushPendingLocalChatText();
    });

  fireEvent.click(screen.getByText("Cancel response"));

  expect(commands.interruptLocalChatTurn).toHaveBeenCalledWith(id);
  expect(commands.closeLocalChatSession).not.toHaveBeenCalled();
  expect(screen.getByText("Stopping...")).toBeInTheDocument();

  // Output the provider produced before it stopped stays, as in the main chat.
  text("interrupted tail");
  expect(screen.getByText("interrupted tail")).toBeInTheDocument();

  act(() => end(id, transport.end, "interrupted"));

  expect(screen.queryByTestId("thinking-indicator")).toBeNull();
  expect(announcement()).toHaveTextContent("Reply cancelled.");
  expect(await send("Next")).toBe(id);
  expect(commands.createLocalChatSession).toHaveBeenCalledTimes(1);
  expect(commands.closeLocalChatSession).not.toHaveBeenCalled();
});

it("switching worktree closes the process and ignores its late events", async () => {
  const view = render(fixture());

  await open();

  const id = await send();
  const oldText = transport.text;
  const oldError = transport.error;

  view.rerender(fixture("B"));

  expect(commands.closeLocalChatSession).toHaveBeenCalledWith(id);

  act(() => {
    oldText?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        text: "wrong scope",
        is_partial: false,
        parent_tool_use_id: null,
      },
    });
    oldError?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        error: "old failure",
      },
    });
  });

  expect(screen.queryByTestId("selection-mini-thread")).toBeNull();
  expect(screen.queryByText(/wrong scope|old failure/)).toBeNull();
  expect(discussionSessions()).toHaveLength(1);
});

it("keeps a captured discussion when the checkout changes and closes its process", async () => {
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({ status: "ok", data: null });
  vi.mocked(commands.captureReviewAnchor).mockResolvedValue({
    status: "ok", data: { originalBlobId: "blob", originalCommitId: "commit" },
  });
  vi.mocked(commands.mapReviewThreads).mockResolvedValue({ status: "ok", data: [] });
  const view = render(fixture("A", vi.fn(), "main", "/project"));
  await waitFor(() => expect(liveDiscussion.canAsk).toBe(true));
  await open();
  await screen.findByTestId("selection-mini-thread");
  const backendId = await send();
  const session = discussionSessions()[0];
  expect(session.discussion).toMatchObject({ parentChatId: "main", worktreePath: "/A" });
  expect(commands.createLocalChatSession).toHaveBeenCalledWith(expect.objectContaining({
    working_dir: "/A",
  }));
  await act(async () => {
    liveDiscussion.reconcile({ wholeBranch: false, files: [fixtureFile] });
    liveDiscussion.reconcile({ wholeBranch: true, files: [fixtureFile] });
  });
  expect(commands.getProjects).toHaveBeenCalledOnce();

  view.rerender(fixture("B"));
  await waitFor(() => expect(commands.closeLocalChatSession).toHaveBeenCalledWith(backendId));
  await waitFor(() => expect(useChatStore.getState().sessions[session.id]?.backendSessionId).toBeNull());
  expect(useChatStore.getState().sessions[session.id].discussion).toEqual(session.discussion);
});

const selectionCallbacks: ReturnType<
  typeof useDiffComments
>["onSelectionChange"][] = [];

const codeSelections: unknown[] = [];

function CodeFixture({
  surface = "tool_call",
  files = fixtureFiles,
  side = "additions",
}: {
  surface?: "worktree" | "tool_call";
  files?: typeof fixtureFiles;
  side?: "additions" | "deletions";
}) {
  const review = useDiffComments(
    surface === "worktree" ? { kind: "worktree" } : { kind: "tool_call", toolUseId: "fixture-tool" },
    files
  );

  selectionCallbacks.push(review.onSelectionChange);
  codeSelections.push(review.selectedLinesFor("a"));

  const range = { start: 1, end: 1, side };

  return (
    <div data-testid="code-fixture" {...review.keyboardProps}>
      <pre>selected</pre>
      <button onClick={() => review.onSelectionChange("a", range)}>
        Select code
      </button>
      <button onClick={() => review.onSelectionChange("a", null)}>
        Clear renderer selection
      </button>
      <button
        aria-label="Add code comment"
        onClick={() => review.openComposer("a", range)}
      >
        +
      </button>
      {review.annotationsFor("a").map((annotation) => (
        <div
          key={`${annotation.side}:${annotation.lineNumber}`}
          data-testid={`fixture-line-${annotation.lineNumber}`}
        >
          {review.renderAnnotation(annotation)}
        </div>
      ))}
    </div>
  );
}

const fixtureFiles = [anchor.file];

function codeFixture(
  onAttach = vi.fn(),
  onOpen = vi.fn(),
  parentChatId?: string,
  surface?: "worktree" | "tool_call",
  side?: "additions" | "deletions"
) {
  return (
    <SelectionDiscussionProvider
      worktreePath="/A"
      parentChatId={parentChatId ?? "code-fixture"}
      projectPath="/project"
      harness="claude"
      onOpen={onOpen}
      onAttach={onAttach}
    >
      <DiffReviewContext.Provider
        value={{
          comments: [],
          placements: [],
          chain: [],
          worktree: null,
          focus: null,
          addComment: vi.fn(),
          updateComment: vi.fn(),
          removeComment: vi.fn(),
        }}
      >
        <CodeFixture surface={surface} side={side} />
      </DiffReviewContext.Provider>
    </SelectionDiscussionProvider>
  );
}

it.each([
  ["dark", "follow"],
  ["dark", "dedicated"],
  ["light", "follow"],
  ["light", "dedicated"],
] as const)(
  "opens a %s %s composer without model labels and renders questions beneath code",
  async (theme, mode) => {
    const inlineDiscussionPreference =
      mode === "follow"
        ? { mode }
        : { mode, providerId: "custom", modelId: "dedicated" };

    document.documentElement.classList.toggle("light", theme === "light");
    useUIStore.setState({ inlineDiscussionPreference });

    const onOpen = vi.fn();
    const onAttach = vi.fn();
    const component = codeFixture(onAttach, onOpen);

    await act(async () => render(component));

    const selectButton = screen.getByText("Select code");

    fireEvent.click(selectButton);

    const unopenedDialog = screen.queryByRole("dialog");

    expect(unopenedDialog).toBeNull();
    expect(commands.createLocalChatSession).not.toHaveBeenCalled();

    const addCommentButton = screen.getByRole("button", {
      name: "Add code comment",
    });

    fireEvent.click(addCommentButton);

    const dialog = screen.getByRole("dialog", {
      name: "Comment on selected code",
    });
    const initialDiscussButton = screen.getByRole("button", {
      name: "Discuss inline",
    });

    expect(dialog).toBeVisible();
    expect(initialDiscussButton).toBeDisabled();

    await waitFor(() => {
      const alert = screen.queryByRole("alert");

      expect(alert).toBeNull();
    });

    const initialModelLabel = screen.queryByText(
      /Next reply:|Reply:|Anthropic|Custom · Dedicated/
    );
    const attachButton = screen.getByRole("button", {
      name: "Send to main chat",
    });

    expect(initialModelLabel).toBeNull();
    expect(attachButton).toBeEnabled();

    const questionInput = screen.getByRole("textbox", {
      name: "New diff comment",
    });

    fireEvent.change(questionInput, { target: { value: "Why selected?" } });

    await waitFor(() => {
      const discussButton = screen.getByRole("button", {
        name: "Discuss inline",
      });

      expect(discussButton).toBeEnabled();
    });

    const discussButton = screen.getByRole("button", {
      name: "Discuss inline",
    });

    fireEvent.click(discussButton);

    await waitFor(() => {
      expect(commands.createLocalChatSession).toHaveBeenCalledOnce();
    });

    const createSession = vi.mocked(commands.createLocalChatSession);
    const request = createSession.mock.calls[0][0];
    const id = request.backend_session_id;

    act(() => {
      transport.text?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text: "Inline answer",
          is_partial: false,
          parent_tool_use_id: null,
        },
      });
      end(id);
    });

    const closedDialog = screen.queryByRole("dialog");
    const codeBlock = screen.getByTestId("code-fixture");
    const thread = screen.getByTestId("selection-mini-thread");
    const threadModelLabel = screen.queryByText(
      /Next reply:|Reply:|Anthropic|Custom · Dedicated/
    );

    expect(closedDialog).toBeNull();
    expect(codeBlock).toContainElement(thread);
    expect(thread).toHaveTextContent("Why selected?");
    expect(thread).toHaveTextContent("Inline answer");
    expect(threadModelLabel).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();

    const closeButton = screen.getByRole("button", {
      name: "Close discussion",
    });

    fireEvent.click(closeButton);

    const closedThread = screen.queryByTestId("selection-mini-thread");

    expect(closedThread).toBeNull();

    const reopenButton = screen.getByRole("button", {
      name: "Reopen selection discussion",
    });

    fireEvent.click(reopenButton);

    const reopenedThread = screen.getByTestId("selection-mini-thread");

    expect(reopenedThread).toHaveTextContent("Inline answer");
  }
);

it("sends the dialog question and snapshot to the main composer without dispatching", () => {
  const attach = vi.fn();

  render(codeFixture(attach));
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: "Please explain in main chat" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));

  expect(attach).toHaveBeenCalledWith(
    expect.objectContaining({
      code: "selected",
      path: "a",
      startLine: 1,
      endLine: 1,
    }),
    false,
    "Please explain in main chat"
  );
  expect(commands.createLocalChatSession).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByTestId("selection-mini-thread")).toBeNull();
});

it("can attach selected code from the dialog before writing a question", () => {
  const attach = vi.fn();

  render(codeFixture(attach));
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));

  expect(attach).toHaveBeenCalledWith(
    expect.objectContaining({ code: "selected" }),
    false,
    ""
  );
  expect(commands.createLocalChatSession).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

async function openDraft() {
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  const draft = screen.getByRole("textbox", { name: "New diff comment" });
  fireEvent.change(draft, { target: { value: "Why?" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Discuss inline" })).toBeEnabled()
  );
  return draft;
}

it("moves focus from the draft to the new discussion's composer once it starts", async () => {
  render(codeFixture());
  const draft = await openDraft();
  draft.focus();

  fireEvent.click(screen.getByRole("button", { name: "Discuss inline" }));

  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Ask about selected code" })
    ).toHaveFocus()
  );
});

it("leaves focus where the user moved it while the discussion was starting", async () => {
  let capture!: (value: Awaited<ReturnType<typeof commands.captureReviewAnchor>>) => void;
  vi.mocked(commands.captureReviewAnchor).mockImplementationOnce(
    () => new Promise((resolve) => (capture = resolve))
  );
  render(codeFixture());
  const draft = await openDraft();
  draft.focus();
  fireEvent.click(screen.getByRole("button", { name: "Discuss inline" }));
  const elsewhere = document.createElement("input");
  document.body.append(elsewhere);
  elsewhere.focus();

  await act(async () =>
    capture({ status: "ok", data: { originalBlobId: "blob", originalCommitId: "commit" } })
  );
  await screen.findByRole("textbox", { name: "Ask about selected code" });

  expect(elsewhere).toHaveFocus();
  elsewhere.remove();
});

it("keeps diff callbacks stable during streaming and announces only completed turns", async () => {
  render(codeFixture());
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: "Question" },
  });
  await waitFor(() => {
    const discussButton = screen.getByRole("button", {
      name: "Discuss inline",
    });

    expect(discussButton).toBeEnabled();
  });
  fireEvent.click(screen.getByRole("button", { name: "Discuss inline" }));
  await waitFor(() =>
    expect(commands.createLocalChatSession).toHaveBeenCalledOnce()
  );

  const request = vi.mocked(commands.createLocalChatSession).mock.calls[0][0];
  const id = request.backend_session_id;

  startTurn(id);
  const callback = selectionCallbacks.at(-1);
  const renders = selectionCallbacks.length;

  for (const text of ["First ", "second ", "third"]) {
    act(() => {
      transport.text?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text,
          is_partial: true,
          parent_tool_use_id: null,
        },
      });
      flushPendingLocalChatText();
    });

    expect(selectionCallbacks.length).toBe(renders);
    expect(selectionCallbacks.at(-1)).toBe(callback);
    expect(announcement().textContent).toBe("");
  }

  const liveAnnouncement = screen
    .getByText("First second third", { exact: false })
    .closest("[aria-live]");

  expect(liveAnnouncement).toBeNull();

  act(() => end(id));

  expect(announcement()).toHaveTextContent("Reply complete.");
  expect(selectionCallbacks.length).toBe(renders);
});

it("renders a start failure like the main chat and starts afresh on the next ask", async () => {
  vi.mocked(commands.createLocalChatSession).mockResolvedValueOnce({
    status: "error",
    error: { StartFailed: "provider unavailable" },
  });

  render(fixture());
  await open();
  const failed = await send();

  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Discussion failed.")
  );
  expect(screen.getByTestId("selection-mini-thread")).toHaveTextContent(
    "provider unavailable"
  );
  expect(announcement()).toHaveTextContent("Discussion failed.");

  // Nothing holds the conversation yet, so the retry carries the anchor again.
  const retry = await send("Again");
  const request = vi.mocked(commands.createLocalChatSession).mock.calls[1][0];

  expect(retry).not.toBe(failed);
  expect(request.initial_prompt).toContain("Context: ");
  expect(request.initial_prompt).toContain("Question: Again");
  expect(discussionSessions()).toHaveLength(1);
});

it("generated provider journeys observe command dispatch and retire responses across identities", async () => {
  await hegel.testAsync(
    async (tc) => {
      for (const command of [
        commands.createLocalChatSession,
        commands.sendLocalChatMessage,
        commands.interruptLocalChatTurn,
        commands.closeLocalChatSession,
      ])
        vi.mocked(command).mockClear();

      const sequence = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 168 }), {
          minSize: 1,
          maxSize: 45,
        })
      );
      const attach = vi.fn();
      let session = 0;
      let worktree = 0;
      let generation = 0;
      let selected = false;
      let active: number | null = null;
      const expected = {
        creates: 0,
        sends: 0,
        interrupts: 0,
        closes: 0,
        attachments: 0,
      };
      type State = "none" | "live" | "in_flight" | "stopping" | "closed";
      // Facts only: the model shares no routing with the provider.
      let facts: {
        id: string;
        backend: string | null;
        state: State;
        resumeId: string | null;
        rows: number;
        outdated: boolean;
      }[] = [];
      const processes: {
        generation: number;
        thread: number;
        backend: string;
      }[] = [];
      const scope = () => `session-${session}:worktree-${worktree}`;
      const view = await act(async () => render(fixture(scope(), attach)));
      const settleInactive = () => {
        facts.forEach((fact, index) => {
          if (index !== active && fact.state === "live") {
            fact.state = "closed";
            expected.closes++;
          }
        });
      };

      try {
        // Cancellation, follow-up, resume and both identity boundaries.
        const prefix = [0, 1, 2, 11, 3, 2, 9, 12, 2, 7, 0, 1, 2, 8, 0, 1, 2];

        for (const encoded of [...prefix, ...sequence]) {
          const operation = encoded % 13;
          const choice = Math.floor(encoded / 13);
          const current = active === null ? null : facts[active];

          if (operation === 0) {
            await act(async () => liveDiscussion.select(anchor));
            selected = true;
          }

          if (operation === 1) {
            await act(async () => {
              const selection = liveDiscussion.selection;
              if (selection) await liveDiscussion.discuss(selection, "");
            });

            if (selected) {
              active = facts.length;
              facts.push({
                id: liveDiscussion.threads.at(-1)!.id,
                backend: null,
                state: "none",
                resumeId: null,
                rows: 0,
                outdated: false,
              });
            }
          }

          if (operation === 2 && current) {
            await act(async () => liveDiscussion.send(current.id, "question"));

            if (current.state !== "in_flight" && current.state !== "stopping") {
              current.rows++;
              if (current.state === "live") {
                expected.sends++;
                expect(
                  vi.mocked(commands.sendLocalChatMessage).mock.calls.at(-1)
                ).toEqual([
                  current.backend,
                  expect.any(String),
                  expect.anything(),
                ]);
                expect(
                  vi.mocked(commands.sendLocalChatMessage).mock.calls.at(-1)![1]
                ).not.toContain('"code"');
              } else {
                expected.creates++;
                const input = vi
                  .mocked(commands.createLocalChatSession)
                  .mock.calls.at(-1)![0];
                const resumes =
                  current.state === "closed" && current.resumeId !== null;

                expect(input).toMatchObject({
                  read_only: true,
                  working_dir: `/${scope()}`,
                  provider_resume_id: resumes ? current.resumeId : null,
                });
                if (resumes)
                  expect(input.initial_prompt).not.toContain('"code"');
                else
                  expect(input.initial_prompt).toContain('"code":"selected"');
                current.backend = input.backend_session_id;
                processes.push({
                  generation,
                  thread: active!,
                  backend: input.backend_session_id,
                });
              }
              current.state = "in_flight";
              startTurn(current.backend!);
            }
          }

          if (operation === 3 && current) {
            await act(async () => liveDiscussion.cancel(current.id));
            if (current.state === "in_flight") {
              expected.interrupts++;
              current.state = "stopping";
            }
          }

          if (operation === 4 && facts.length) {
            active = choice % facts.length;
            await act(async () => liveDiscussion.reopen(facts[active!].id));
            selected = true;
          }

          if (operation === 5) {
            await act(async () => liveDiscussion.reopen(null));
            active = null;
          }

          if (operation === 6) {
            act(() =>
              liveDiscussion.reconcile({
                wholeBranch: true,
                files: [],
                comparisonIdentity: "edited",
              })
            );
            selected = false;

          }

          if (operation === 7 || operation === 8) {
            if (operation === 7) session++;
            else worktree++;

            // Unmounting the provider closes every live process.
            for (const fact of facts)
              if (fact.state !== "none" && fact.state !== "closed")
                expected.closes++;
            generation++;
            await act(async () => view.rerender(fixture(scope(), attach)));
            facts = [];
            active = null;
            selected = false;
          }

          if (operation === 9 && processes.length) {
            const process = processes[choice % processes.length];
            const fact =
              process.generation === generation
                ? facts[process.thread]
                : undefined;
            const current = fact?.backend === process.backend;
            const accepted =
              current &&
              (fact!.state === "in_flight" || fact!.state === "stopping");

            // A settled turn of the current process is the router's concern;
            // the model checks the in-flight turn and stale processes.
            if (accepted || !current)
              await act(async () => {
                transport.text?.({
                  payload: {
                    backend_session_id: process.backend,
                    harness: "claude",
                    text: "deterministic answer",
                    turn_id: turnIds.get(process.backend),
                    is_root: true,
                    is_partial: false,
                    parent_tool_use_id: null,
                  },
                });
                end(process.backend);
              });

            if (accepted) {
              fact!.rows++;
              fact!.state = "live";
            }
          }

          if (operation === 10 && selected) {
            act(() => liveDiscussion.attach(anchor));
            expected.attachments++;
          }

          if (operation === 11 && current?.backend) {
            await act(async () =>
              transport.init?.({
                payload: {
                  backend_session_id: current.backend!,
                  harness: "claude",
                  provider_resume_id: `provider-${current.id}`,
                  model: "sonnet",
                  tools: ["Read", "Grep", "Glob"],
                },
              })
            );
            if (current.state !== "none" && current.state !== "closed")
              current.resumeId = `provider-${current.id}`;
          }

          if (operation === 12 && current?.backend) {
            // The process exits; the next follow-up resumes the conversation.
            await act(async () =>
              transport.error?.({
                payload: {
                  backend_session_id: current.backend!,
                  harness: "claude",
                  error: "process exited",
                  is_root: true,
                },
              })
            );
            if (current.state !== "none" && current.state !== "closed") {
              current.state = "closed";
              current.rows++;
            }
          }

          settleInactive();

          expect(commands.createLocalChatSession).toHaveBeenCalledTimes(
            expected.creates
          );
          expect(commands.sendLocalChatMessage).toHaveBeenCalledTimes(
            expected.sends
          );
          expect(commands.interruptLocalChatTurn).toHaveBeenCalledTimes(
            expected.interrupts
          );
          expect(commands.closeLocalChatSession).toHaveBeenCalledTimes(
            expected.closes
          );
          expect(attach).toHaveBeenCalledTimes(expected.attachments);
          expect(liveDiscussion.selection !== null).toBe(selected);
          expect(liveDiscussion.activeId).toBe(
            active === null ? null : facts[active].id
          );
          const { sessions } = useChatStore.getState();

          expect(
            liveDiscussion.threads.map((thread) => {
              const session = thread.sessionId
                ? sessions[thread.sessionId]
                : undefined;

              return {
                code: thread.anchor.code,
                waiting: !!session?.activeTurn,
                live: !!session?.backendSessionId,
                outdated: isOutdated(thread),
                rows: session?.messages.length ?? 0,
              };
            })
          ).toEqual(
            facts.map((fact) => ({
              code: "selected",
              waiting: fact.state === "in_flight" || fact.state === "stopping",
              live: fact.state !== "none" && fact.state !== "closed",
              outdated: fact.outdated,
              rows: fact.rows,
            }))
          );
          // Discussions stay out of the main chat history.
          expect(useChatStore.getState().listLocalSessions("/project")).toEqual([]);
        }
      } finally {
        view.unmount();
      }
    },
    { seed: 0x8640ee9e, testCases: 40 }
  );
}, 30000);

it("keeps the code highlight through dialog focus and clears it only on submission", async () => {
  render(codeFixture());
  fireEvent.click(screen.getByRole("button", { name: "Select code" }));
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));

  const expected = { start: 1, end: 1, side: "additions" };

  expect(codeSelections.at(-1)).toEqual(expected);

  fireEvent.click(
    screen.getByRole("button", { name: "Clear renderer selection" })
  );

  expect(codeSelections.at(-1)).toEqual(expected);

  fireEvent.focus(screen.getByRole("textbox", { name: "New diff comment" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: "Keep selected" },
  });

  expect(codeSelections.at(-1)).toEqual(expected);

  await waitFor(() => {
    const discussButton = screen.getByRole("button", {
      name: "Discuss inline",
    });

    expect(discussButton).toBeEnabled();
  });
  fireEvent.click(screen.getByRole("button", { name: "Discuss inline" }));

  await waitFor(() => expect(codeSelections.at(-1)).toBeNull());

  await waitFor(() =>
    expect(commands.createLocalChatSession).toHaveBeenCalledOnce()
  );

  const followUp = screen.getByRole("textbox", {
    name: "Ask about selected code",
  });

  expect(followUp.closest("form")).toHaveClass("diff-comment-editor");
  expect(followUp).toHaveAttribute("rows", "3");
});

it("retains the range after cancelling and clears it when attaching to main chat", () => {
  render(codeFixture());
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(codeSelections.at(-1)).toEqual({
    start: 1,
    end: 1,
    side: "additions",
  });

  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));

  expect(codeSelections.at(-1)).toBeNull();
  expect(commands.createLocalChatSession).not.toHaveBeenCalled();
});

it("renders Markdown replies and highlights the source from the discussion header", async () => {
  render(codeFixture());
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: "Explain this code" },
  });
  await waitFor(() => {
    const discussButton = screen.getByRole("button", {
      name: "Discuss inline",
    });

    expect(discussButton).toBeEnabled();
  });
  fireEvent.click(screen.getByRole("button", { name: "Discuss inline" }));
  await waitFor(() =>
    expect(commands.createLocalChatSession).toHaveBeenCalledOnce()
  );

  const request = vi.mocked(commands.createLocalChatSession).mock.calls[0][0];
  const id = request.backend_session_id;

  act(() => {
    transport.text?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        text: "**Explanation**\n\n- First item\n- Use `selected` here.\n\n<script>unsafe()</script>",
        is_partial: false,
        parent_tool_use_id: null,
      },
    });
    end(id);
  });

  const thread = screen.getByTestId("selection-mini-thread");

  expect(thread.querySelector(".markdown-content strong")).toHaveTextContent(
    "Explanation"
  );
  expect(thread.querySelectorAll(".markdown-content li")).toHaveLength(2);
  expect(thread.querySelector(".markdown-content code")).toHaveTextContent(
    "selected"
  );
  expect(thread.querySelector("script")).toBeNull();
  expect(thread.querySelector("details")).toBeNull();

  const close = screen.getByRole("button", { name: "Close discussion" });

  expect(close.textContent).toBe("");
  expect(close.querySelector("svg")).not.toBeNull();

  expect(codeSelections.at(-1)).toBeNull();

  const reply = thread.querySelector(".markdown-content strong")!;
  const range = document.createRange();
  range.selectNodeContents(reply);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    fireEvent.click(reply);
    expect(selection.toString()).toBe("Explanation");
    expect(codeSelections.at(-1)).toBeNull();
  } finally {
    selection.removeAllRanges();
  }

  fireEvent.click(
    screen.getByRole("button", { name: "Highlight selected code: a:1 (new)" })
  );

  expect(codeSelections.at(-1)).toEqual({
    start: 1,
    end: 1,
    side: "additions",
  });

  fireEvent.click(thread.querySelector(".selection-mini-messages")!);

  expect(codeSelections.at(-1)).toEqual({
    start: 1,
    end: 1,
    side: "additions",
  });
  expect(commands.createLocalChatSession).toHaveBeenCalledOnce();
});

it("asks with ⌘↵ and sends to the main chat with ⌘⇧↵ from the discussion composer", async () => {
  const onAttach = vi.fn();
  render(codeFixture(onAttach));
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: "Explain this code" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Discuss inline" })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole("button", { name: "Discuss inline" }));
  await waitFor(() =>
    expect(commands.createLocalChatSession).toHaveBeenCalledOnce()
  );
  const id = vi.mocked(commands.createLocalChatSession).mock.calls[0][0]
    .backend_session_id;
  startTurn(id);
  act(() => {
    transport.text?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        text: "first answer",
        is_partial: false,
        parent_tool_use_id: null,
      },
    });
    end(id);
  });

  const composer = screen.getByRole("textbox", { name: "Ask about selected code" });
  fireEvent.change(composer, { target: { value: "Send this along" } });
  fireEvent.keyDown(composer, { key: "Enter", metaKey: true, shiftKey: true });
  expect(onAttach).toHaveBeenCalledWith(
    expect.objectContaining({ path: "a", startLine: 1, endLine: 1 }),
    false,
    "Send this along"
  );
  expect(composer).toHaveValue("");

  fireEvent.change(composer, { target: { value: "And a follow-up?" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled()
  );
  fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
  expect(composer).toHaveValue("");
  await waitFor(() =>
    expect(
      vi.mocked(commands.sendLocalChatMessage).mock.calls.length +
        vi.mocked(commands.createLocalChatSession).mock.calls.length
    ).toBeGreaterThan(1)
  );
});

it("opens and closes a discussion from its anchor line and collapses earlier turns", async () => {
  render(codeFixture());
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: "Explain this code" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Discuss inline" })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole("button", { name: "Discuss inline" }));
  await waitFor(() =>
    expect(commands.createLocalChatSession).toHaveBeenCalledOnce()
  );
  const id = vi.mocked(commands.createLocalChatSession).mock.calls[0][0]
    .backend_session_id;
  act(() => {
    transport.text?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        text: "first answer",
        is_partial: false,
        parent_tool_use_id: null,
      },
    });
    end(id);
  });

  const composer = () =>
    screen.getByRole("textbox", { name: "Ask about selected code" });
  const group = screen.getByRole("group", { name: "Code diff selection" });

  // Esc closes the discussion and returns to its anchor line.
  composer().focus();
  fireEvent.keyDown(composer(), { key: "Escape" });
  expect(screen.queryByTestId("selection-mini-thread")).toBeNull();
  expect(group).toHaveFocus();
  expect(codeSelections.at(-1)).toEqual({ start: 1, end: 1, side: "additions" });

  // The marker and the line cursor both open it with the caret in the composer.
  fireEvent.click(screen.getByRole("button", { name: "Reopen selection discussion" }));
  await waitFor(() => expect(composer()).toHaveFocus());
  fireEvent.keyDown(composer(), { key: "Escape" });
  expect(group).toHaveFocus();
  fireEvent.keyDown(group, { key: "o" });
  await waitFor(() => expect(composer()).toHaveFocus());

  // Already open: the line cursor still moves focus into the composer.
  group.focus();
  fireEvent.click(screen.getByRole("button", { name: "Select code" }));
  fireEvent.keyDown(group, { key: "o" });
  await waitFor(() => expect(composer()).toHaveFocus());

  const session = Object.values(useChatStore.getState().sessions).find(
    (candidate) => candidate.discussion
  )!;
  const add = (kind: "user" | "assistant", text: string) =>
    act(() =>
      useChatStore
        .getState()
        .addMessage(session.id, { kind, text, timestamp: new Date().toISOString() })
    );
  add("user", "second question");
  add("assistant", "second answer");
  add("user", "third question");
  add("assistant", "third answer");
  const closed = vi.mocked(commands.closeLocalChatSession).mock.calls.length;
  const thread = screen.getByTestId("selection-mini-thread");

  fireEvent.keyDown(composer(), { key: "E", metaKey: true, shiftKey: true });
  expect(screen.getByRole("button", { name: "2 earlier turns" })).toBeInTheDocument();
  expect(thread).toHaveTextContent("third answer");
  expect(thread).not.toHaveTextContent("first answer");
  expect(thread).not.toHaveTextContent("second answer");
  expect(thread).not.toHaveTextContent("third question");

  fireEvent.keyDown(composer(), { key: "E", metaKey: true, shiftKey: true });
  expect(screen.queryByRole("button", { name: "2 earlier turns" })).toBeNull();
  expect(thread).toHaveTextContent("first answer");

  fireEvent.click(screen.getByRole("button", { name: "Show only the latest response" }));
  add("user", "fourth question");
  add("assistant", "fourth answer");
  expect(screen.getByRole("button", { name: "3 earlier turns" })).toBeInTheDocument();
  expect(thread).toHaveTextContent("fourth answer");
  expect(thread).not.toHaveTextContent("third answer");

  fireEvent.click(screen.getByRole("button", { name: "3 earlier turns" }));
  expect(thread).toHaveTextContent("third answer");

  // Presentation only: the session was neither restarted nor closed.
  expect(commands.createLocalChatSession).toHaveBeenCalledOnce();
  expect(commands.closeLocalChatSession).toHaveBeenCalledTimes(closed);
  expect(commands.interruptLocalChatTurn).not.toHaveBeenCalled();
});

it("restores each discussion's range when switching between two comments", async () => {
  const files = parsePatch(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-old\n-other\n+first\n+second\n"
  );
  let selected: unknown;

  function TwoSpans() {
    const review = useDiffComments({ kind: "worktree" }, files);

    selected = review.selectedLinesFor("a");

    return (
      <>
        {[1, 2].map((line) => (
          <button
            key={line}
            onClick={() =>
              review.openComposer("a", {
                start: line,
                end: line,
                side: "additions",
              })
            }
          >
            Comment {line}
          </button>
        ))}
        {review.annotationsFor("a").map((annotation) => (
          <div key={annotation.lineNumber}>
            {review.renderAnnotation(annotation)}
          </div>
        ))}
      </>
    );
  }

  const onOpen = vi.fn();
  const onAttach = vi.fn();
  const view = (
    <SelectionDiscussionProvider
      worktreePath="/A"
      parentChatId="two-spans"
      projectPath="/project"
      harness="claude"
      onOpen={onOpen}
      onAttach={onAttach}
    >
      <TwoSpans />
    </SelectionDiscussionProvider>
  );

  render(view);

  for (const line of [1, 2]) {
    fireEvent.click(screen.getByText(`Comment ${line}`));
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      {
        target: { value: `Question ${line}` },
      }
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Discuss inline" })
      ).toBeEnabled()
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Discuss inline" })));
  }

  fireEvent.click(
    screen.getByRole("button", { name: "Reopen selection discussion" })
  );

  expect(selected).toEqual({ start: 1, end: 1, side: "additions" });

  fireEvent.click(
    screen.getByRole("button", { name: "Reopen selection discussion" })
  );

  expect(selected).toEqual({ start: 2, end: 2, side: "additions" });

  fireEvent.click(screen.getByText("Comment 1"));
  fireEvent.click(
    screen.getByRole("button", { name: "Highlight selected code: a:2 (new)" })
  );

  expect(selected).toEqual({ start: 2, end: 2, side: "additions" });
});

it("keeps the captured provider when switching away from a dedicated model", async () => {
  const uiState = useUIStore.getState();
  const dedicatedPreference = {
    mode: "dedicated" as const,
    providerId: "custom",
    modelId: "dedicated",
  };
  const view = fixture();

  uiState.setInlineDiscussionPreference(dedicatedPreference);
  render(view);
  await open();

  const id = await send();
  const dedicatedRequest = expect.objectContaining({
    harness: "codex",
    provider_id: "custom",
    model_id: "dedicated",
    read_only: true,
    working_dir: "/A",
  });

  expect(commands.createLocalChatSession).toHaveBeenLastCalledWith(
    dedicatedRequest
  );

  act(() => uiState.setInlineDiscussionPreference({ mode: "follow" }));

  const modelLabel = screen.queryByText(/Reply:|Next reply:/);

  expect(modelLabel).toBeNull();
  expect(commands.createLocalChatSession).toHaveBeenCalledTimes(1);

  act(() => {
    transport.text?.({
      payload: {
        backend_session_id: id,
        harness: "codex",
        text: "Dedicated answer",
        is_partial: false,
        parent_tool_use_id: null,
      },
    });
    end(id);
  });

  expect(await send("Follow up after change")).toBe(id);
  expect(commands.createLocalChatSession).toHaveBeenCalledTimes(1);
  expect(commands.sendLocalChatMessage).toHaveBeenCalledWith(
    id, "Follow up after change", expect.objectContaining({ model_id: "dedicated" })
  );
});

it("resumes a bound discussion with its original provider and model after switching settings", async () => {
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({ status: "ok", data: null });
  vi.mocked(commands.captureReviewAnchor).mockResolvedValue({
    status: "ok", data: { originalBlobId: "blob", originalCommitId: "commit" },
  });
  const parentChatId = "provider-switch-parent";
  render(fixture("A", vi.fn(), parentChatId, "/project"));
  await waitFor(() => expect(liveDiscussion.canAsk).toBe(true));
  await open();
  await screen.findByTestId("selection-mini-thread");

  const backendId = await send();
  const sessionId = vi.mocked(commands.createLocalChatSession).mock.lastCall![0].chat_session_id;
  act(() => {
    transport.init?.({
      payload: {
        backend_session_id: backendId,
        harness: "claude",
        provider_resume_id: "original-resume",
        model: "sonnet",
        tools: ["Read"],
      },
    });
    end(backendId);
  });
  fireEvent.click(screen.getByRole("button", { name: "Close discussion" }));
  await waitFor(() =>
    expect(useChatStore.getState().sessions[sessionId].backendSessionId).toBeNull()
  );

  act(() => useUIStore.getState().setInlineDiscussionPreference({
    mode: "dedicated", providerId: "custom", modelId: "dedicated",
  }));
  fireEvent.click(screen.getByRole("button", { name: "Reopen selection discussion" }));
  await send("Follow up using the saved discussion");

  const boundSessions = discussionSessions().filter(({ discussion }) =>
    discussion && discussion.parentChatId === parentChatId
  );
  expect(boundSessions.map(({ id }) => id)).toEqual([sessionId]);
  expect(commands.createLocalChatSession).toHaveBeenCalledTimes(2);
  expect(commands.createLocalChatSession).toHaveBeenLastCalledWith(expect.objectContaining({
    harness: "claude",
    provider_id: "anthropic",
    provider_resume_id: "original-resume",
    model_id: "sonnet",
    working_dir: "/A",
    initial_prompt: "Follow up using the saved discussion",
  }));
});

it("applies a changed model to a follow-up in the same session as turn settings", async () => {
  const uiState = useUIStore.getState();

  render(fixture());
  await open();

  const id = await send();

  act(() => end(id));
  act(() =>
    uiState.setInlineDiscussionPreference({
      mode: "dedicated",
      providerId: "anthropic",
      modelId: "opus",
    })
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Ask" })).toBeDefined()
  );

  const followUp = await send("Next");

  expect(followUp).toBe(id);
  expect(commands.sendLocalChatMessage).toHaveBeenLastCalledWith(
    id,
    "Next",
    expect.objectContaining({ model_id: "opus" })
  );
});

it.each([
  { mode: "dedicated" as const, providerId: "removed", modelId: "dedicated" },
  { mode: "dedicated" as const, providerId: "custom", modelId: "removed" },
  { mode: "invalid" as const },
])(
  "blocks invalid saved choices without sending on another provider: %j",
  async (preference) => {
    const uiState = useUIStore.getState();
    const view = fixture();

    uiState.setInlineDiscussionPreference(preference);
    render(view);
    await open();
    await screen.findByText(
      /Open Settings → Diffs & code editor → Inline discussions/
    );

    const composer = screen.getByRole("textbox", {
      name: "Ask about selected code",
    });
    const askButton = screen.getByRole("button", { name: "Ask" });

    fireEvent.change(composer, { target: { value: "Question" } });

    expect(askButton).toBeDisabled();

    act(() => liveDiscussion.send(liveDiscussion.activeId!, "Question"));

    expect(commands.createLocalChatSession).not.toHaveBeenCalled();
  }
);

it("invalidates the catalog after provider settings change", async () => {
  const component = fixture();
  const view = render(component);

  await open();
  await waitFor(() => {
    const alert = screen.queryByRole("alert");

    expect(alert).toBeNull();
  });

  const catalogCommand = vi.mocked(commands.getSupportedLocalChatHarnesses);
  const removedProviderCatalog = { ...inlineDiscussionCatalog, providers: [] };
  const providerSettings = useProviderSettingsStore.getState();

  catalogCommand.mockResolvedValueOnce({
    status: "ok",
    data: removedProviderCatalog,
  });
  act(() => providerSettings.changed());
  await screen.findByText(/Provider anthropic is unavailable or removed/);

  expect(commands.createLocalChatSession).not.toHaveBeenCalled();

  view.unmount();
});

it("captures the provider and model when the question is asked", async () => {
  const uiState = useUIStore.getState();

  uiState.setInlineDiscussionPreference({
    mode: "dedicated",
    providerId: "custom",
    modelId: "dedicated",
  });
  render(fixture());
  await open();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

  await act(async () =>
    liveDiscussion.send(liveDiscussion.activeId!, "Which provider?")
  );
  act(() => uiState.setInlineDiscussionPreference({ mode: "follow" }));

  expect(commands.createLocalChatSession).toHaveBeenCalledOnce();
  expect(commands.createLocalChatSession).toHaveBeenLastCalledWith(
    expect.objectContaining({
      harness: "codex",
      provider_id: "custom",
      model_id: "dedicated",
      read_only: true,
    })
  );
});

it("shows catalog errors and retires a delayed catalog read after switching worktrees", async () => {
  let complete!: (
    value: Awaited<ReturnType<typeof commands.getSupportedLocalChatHarnesses>>
  ) => void;
  const catalogCommand = vi.mocked(commands.getSupportedLocalChatHarnesses);

  catalogCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );

  const initialComponent = fixture("A");
  const nextComponent = fixture("B");
  const view = render(initialComponent);

  await open();
  view.rerender(nextComponent);
  await open();
  await waitFor(() => {
    const alert = screen.queryByRole("alert");

    expect(alert).toBeNull();
  });

  const removedProviderCatalog = { ...inlineDiscussionCatalog, providers: [] };

  await act(async () =>
    complete({ status: "ok", data: removedProviderCatalog })
  );

  const alert = screen.queryByRole("alert");
  const modelLabel = screen.queryByText(/Next reply:/);

  expect(alert).toBeNull();
  expect(modelLabel).toBeNull();

  const catalogError = new Error("catalog unavailable");
  const providerSettings = useProviderSettingsStore.getState();

  catalogCommand.mockRejectedValueOnce(catalogError);
  act(() => providerSettings.changed());
  await screen.findByText(/Could not load providers/);

  expect(commands.createLocalChatSession).not.toHaveBeenCalled();
});

it("sends custom effort and speed without applying a removed personality preference", async () => {
  const ui = useUIStore.getState();
  const preference = {
    mode: "dedicated" as const,
    providerId: "custom",
    modelId: "dedicated",
    reasoningEffort: "high",
    speedTier: "fast",
    personality: "friendly",
  };
  const component = fixture();

  ui.setInlineDiscussionPreference(preference);
  render(component);
  await open();
  await send();

  const request = expect.objectContaining({
    read_only: true,
    reasoning_effort: "high",
    speed_tier: "fast",
    personality: null,
    // The harness's read-only policy owns permissions for discussions.
    permission_mode: "default",
  });

  expect(commands.createLocalChatSession).toHaveBeenLastCalledWith(request);
});

afterEach(() => {
  document.documentElement.classList.remove("light", "dark");
});

it.each(["dark", "light"])(
  "preserves bubbles, Markdown and pending state across live %s theme changes",
  async (theme) => {
    document.documentElement.classList.toggle("light", theme === "light");

    const component = fixture();

    await act(async () => render(component));
    await open();

    const id = await send("First line\nSecond line");
    const initialQuestion = screen.getByText("First line", { exact: false });
    const initialMessage = initialQuestion.closest(".evrow");
    const initialIndicator = screen.getByTestId("thinking-indicator");

    expect(initialMessage).toHaveClass("evrow--user");
    expect(initialIndicator).toBeVisible();

    act(() => {
      transport.text?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text: "**Bold answer**",
          is_partial: true,
          parent_tool_use_id: null,
        },
      });
      end(id);
    });

    const answer = screen.getByText("Bold answer");
    const indicatorAfterReply = screen.queryByTestId("thinking-indicator");

    expect(answer.tagName).toBe("STRONG");
    expect(indicatorAfterReply).toBeNull();

    const longText = "long".repeat(80);
    const followUpQuestion = `Follow-up\n${longText}`;
    const followUp = await send(followUpQuestion);

    act(() => {
      document.documentElement.classList.toggle("light", theme !== "light");
    });

    const retainedAnswer = screen.getByText("Bold answer");
    const followUpIndicator = screen.getByTestId("thinking-indicator");
    const followUpText = screen.getByText(/Follow-up/);
    const followUpMessage = followUpText.closest(".evrow");
    const pendingTurn = discussionSessions()[0].activeTurn;

    expect(retainedAnswer).toBeVisible();
    expect(followUpIndicator).toBeVisible();
    expect(followUpMessage).toHaveClass("evrow--user");
    expect(pendingTurn).not.toBeNull();
    expect(followUp).toBe(id);

    const closeButton = screen.getByRole("button", {
      name: "Close discussion",
    });

    fireEvent.click(closeButton);

    const reopenButton = screen.getByRole("button", {
      name: "Reopen selection discussion",
    });

    fireEvent.click(reopenButton);

    const reopenedIndicator = screen.getByTestId("thinking-indicator");
    const modelLabel = screen.queryByText(/Reply:|Next reply:/);

    expect(reopenedIndicator).toBeVisible();
    expect(modelLabel).toBeNull();

    act(() => end(followUp));

    const finishedIndicator = screen.queryByTestId("thinking-indicator");

    expect(finishedIndicator).toBeNull();
  }
);

it.each([
  ["shimmer", false],
  ["shimmer", true],
  ["uplink", false],
  ["uplink", true],
] as const)(
  "shows %s thinking for the whole turn with previous history=%s",
  async (style, history) => {
    useUIStore.setState({ thinkingIndicatorStyle: style });

    render(fixture());
    await open();

    if (history) {
      const first = await send();

      act(() => {
        transport.text?.({
          payload: {
            backend_session_id: first,
            harness: "claude",
            text: "Earlier answer",
            turn_id: turnIds.get(first),
            is_root: true,
            is_partial: false,
            parent_tool_use_id: null,
          },
        });
        end(first);
      });
    }

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    let complete!: (value: { status: "ok"; data: null }) => void;
    const deferred = () =>
      new Promise<{ status: "ok"; data: null }>((resolve) => {
        complete = resolve;
      });

    if (history)
      vi.mocked(commands.sendLocalChatMessage).mockImplementationOnce(deferred);
    else
      vi.mocked(commands.createLocalChatSession).mockImplementationOnce(
        deferred
      );

    const threadId = liveDiscussion.activeId!;

    act(() => liveDiscussion.send(threadId, "Waiting follow-up"));

    expect(screen.getByTestId("thinking-indicator")).toHaveAttribute(
      "data-style",
      style
    );

    await act(async () => complete({ status: "ok", data: null }));

    const id = discussionSessions()[0].backendSessionId!;

    expect(commands.createLocalChatSession).toHaveBeenCalledOnce();
    startTurn(id);

    act(() => {
      transport.text?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text: "Now streaming",
          turn_id: turnIds.get(id),
          is_root: true,
          is_partial: true,
          parent_tool_use_id: null,
        },
      });
      flushPendingLocalChatText();
    });

    // As in the main chat, the indicator stays for the whole turn.
    expect(screen.getByTestId("thinking-indicator")).toBeVisible();

    act(() => end(id));

    expect(screen.queryByTestId("thinking-indicator")).toBeNull();
  }
);

it.each(["end", "rejection", "error", "cancel", "unmount"])(
  "clears pending UI on %s and ignores retired events",
  async (terminal) => {
    const component = fixture();
    const view = render(component);

    await open();

    if (terminal === "rejection") {
      const setupError = new Error("setup failure");
      const createSession = vi.mocked(commands.createLocalChatSession);

      createSession.mockRejectedValueOnce(setupError);
    }

    const id = await send();
    const lateText = transport.text;

    if (terminal !== "rejection") {
      const pendingIndicator = screen.getByTestId("thinking-indicator");

      expect(pendingIndicator).toBeVisible();
    }

    if (terminal === "end") act(() => end(id));

    if (terminal === "error") {
      act(() =>
        transport.error?.({
          payload: {
            backend_session_id: id,
            harness: "claude",
            error: "session failure",
            is_root: true,
          },
        })
      );
    }

    if (terminal === "cancel") {
      const cancelButton = screen.getByRole("button", {
        name: "Cancel response",
      });

      fireEvent.click(cancelButton);
      act(() => end(id, transport.end, "interrupted"));
    }

    if (terminal === "unmount") {
      const nextComponent = fixture("B");

      view.rerender(nextComponent);
      await open();
    }

    await waitFor(() => {
      const indicator = screen.queryByTestId("thinking-indicator");

      expect(indicator).toBeNull();
    });

    act(() =>
      lateText?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text: "Retired reply",
          turn_id: turnIds.get(id),
          is_root: true,
          is_partial: true,
          parent_tool_use_id: null,
        },
      })
    );

    const retiredReply = screen.queryByText("Retired reply");

    expect(retiredReply).toBeNull();
  }
);

it.each(["dark", "light"])(
  "retains actionable configuration alerts in the initial %s composer",
  async (theme) => {
    document.documentElement.classList.toggle("light", theme === "light");
    useUIStore.setState({
      inlineDiscussionPreference: {
        mode: "dedicated",
        providerId: "removed",
        modelId: "removed",
      },
    });

    const component = codeFixture();

    await act(async () => render(component));

    const selectButton = screen.getByText("Select code");

    fireEvent.click(selectButton);

    const addCommentButton = screen.getByRole("button", {
      name: "Add code comment",
    });

    fireEvent.click(addCommentButton);

    await screen.findByRole("alert");
    await screen.findByText(
      /Open Settings → Diffs & code editor → Inline discussions/
    );

    const questionInput = screen.getByRole("textbox", {
      name: "New diff comment",
    });

    fireEvent.change(questionInput, { target: { value: "Question" } });

    const discussButton = screen.getByRole("button", {
      name: "Discuss inline",
    });
    const attachButton = screen.getByRole("button", {
      name: "Send to main chat",
    });

    expect(discussButton).toBeDisabled();
    expect(attachButton).toBeEnabled();
    expect(commands.createLocalChatSession).not.toHaveBeenCalled();
  }
);

it("renders a discussion's tool calls, results and errors with the main chat's Thread rows", async () => {
  const view = render(fixture());

  await open();

  const id = await send("Please explain what this file does");

  act(() => {
    transport.toolCall?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        tool_id: "read-1",
        tool_name: "Read",
        input: JSON.stringify({ file_path: "/A/a" }),
        parent_tool_use_id: null,
      },
    });
    transport.toolResult?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        tool_id: "read-1",
        result: "selected",
        is_error: false,
        parent_tool_use_id: null,
      },
    });
    transport.text?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        text: "The file holds one line.",
        is_partial: false,
        parent_tool_use_id: null,
      },
    });
    // Another process's tool call never reaches this thread.
    transport.toolCall?.({
      payload: {
        backend_session_id: "foreign",
        harness: "claude",
        tool_id: "write-1",
        tool_name: "Write",
        input: "{}",
        parent_tool_use_id: null,
      },
    });
    end(id);
  });

  const thread = screen.getByTestId("selection-mini-thread");
  const messages = thread.querySelector(".selection-mini-messages")!;
  // A real tool call is a tool row (grouped like the main chat), never prose.
  const group = messages.querySelector(".tool-activity-summary")!;

  expect(group).toHaveTextContent("1 call");
  expect(messages.querySelector(".evrow--agent")).toHaveTextContent(
    "The file holds one line."
  );
  expect(messages.textContent).not.toMatch(
    /<invoke|tool_use|"file_path"|Write/
  );


  fireEvent.click(group);

  const calls = [...messages.querySelectorAll(".tool-activity-call")];

  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveAttribute("data-evt", "read-1");

  fireEvent.click(calls[0].querySelector("button")!);

  // The raw call and its recorded result render inside the tool row.
  expect(calls[0]).toHaveTextContent("/A/a");
  expect(calls[0]).toHaveTextContent("selected");

  act(() =>
    transport.error?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        error: "provider overloaded",
        is_root: true,
      },
    })
  );

  expect(
    thread.querySelector(".selection-mini-messages .evrow--error")
  ).toHaveTextContent("provider overloaded");

  view.unmount();
});

it.each(["worktree", "tool_call"] as const)(
  "hides inline Ask on %s until the worktree has a first commit",
  async (surface) => {
    vi.mocked(commands.checkReviewAnchorWorktree)
      .mockReset()
      .mockResolvedValueOnce({ status: "error", error: "not_repository" })
      .mockResolvedValueOnce({ status: "error", error: "unborn_head" })
      .mockResolvedValue({ status: "ok", data: null });
    render(codeFixture(vi.fn(), vi.fn(), "main-chat", surface));
    await act(async () => {});
    expect(commands.checkReviewAnchorWorktree).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add code comment" })));
    expect(screen.queryByRole("button", { name: "Discuss inline" })).toBeNull();
    await act(async () => fireEvent(window, new Event("focus")));
    expect(screen.getByRole("button", { name: "Discuss inline" })).toBeVisible();
    expect(commands.captureReviewAnchor).not.toHaveBeenCalled();
  }
);

it("captures the selected range before starting an inline thread", async () => {
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({
    status: "ok", data: null,
  });
  vi.mocked(commands.captureReviewAnchor).mockResolvedValue({
    status: "ok",
    data: { originalCommitId: "commit", originalBlobId: "blob" },
  });
  render(codeFixture(vi.fn(), vi.fn(), "main-chat"));
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  const submit = await screen.findByRole("button", { name: "Discuss inline" });
  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: "Why?" },
  });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  expect(await screen.findByRole("region", { name: "Selection discussion" })).toBeVisible();
  expect(commands.captureReviewAnchor).toHaveBeenCalledWith({
    worktree: "/A",
    threadId: expect.any(String),
    location: {
      path: "a",
      side: "RIGHT",
      source: { kind: "tool_call", chatId: "main-chat", toolUseId: "fixture-tool" },
    },
    range: { startLine: 1, line: 1 },
    selectedText: "selected",
    parent: { chatId: "main-chat", projectPath: "/project" },
  });
});

it("moves a Git-anchored discussion and displays the captured lines when outdated", async () => {
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({
    status: "ok",
    data: null,
  });
  vi.mocked(commands.captureReviewAnchor).mockResolvedValue({
    status: "ok",
    data: { originalCommitId: "commit", originalBlobId: "blob" },
  });
  vi.mocked(commands.mapReviewThreads)
    .mockImplementationOnce(async (_worktree, [request]) => ({
      status: "ok",
      data: [{ threadId: request.threadId, status: "open", startLine: 3, line: 3 }],
    }))
    .mockImplementationOnce(async (_worktree, [request]) => ({
      status: "ok",
      data: [{ threadId: request.threadId, status: "outdated", startLine: null, line: null }],
    }));

  const shifted = parsePatch(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,1 +1,3 @@\n-old\n+first\n+second\n+selected\n"
  );
  const tree = (files: typeof fixtureFiles) => (
    <SelectionDiscussionProvider
      worktreePath="/A"
      parentChatId="main-chat"
      projectPath="/project"
      harness="claude"
      onOpen={vi.fn()}
      onAttach={vi.fn()}
    >
      <Controls showThreads={false} />
      <CodeFixture surface="worktree" files={files} />
      <DiscussionSnapshot snapshot={null} />
    </SelectionDiscussionProvider>
  );
  const view = render(tree(fixtureFiles));
  await waitFor(() => expect(liveDiscussion.canAsk).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Select fixture" }));
  fireEvent.click(screen.getByRole("button", { name: "Open mini" }));
  const original = await screen.findByRole("button", { name: "Highlight selected code: a:1 (new)" });
  expect(screen.getByTestId("fixture-line-1")).toContainElement(original);

  view.rerender(tree(shifted));
  await act(async () => liveDiscussion.reconcile({ wholeBranch: false, files: shifted }));
  const moved = await screen.findByRole("button", { name: "Highlight selected code: a:3 (new)" });
  expect(screen.getByTestId("fixture-line-3")).toContainElement(moved);

  const edited = parsePatch(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,1 +1,3 @@\n-old\n+edited\n+second\n+first\n"
  );
  view.rerender(tree(edited));
  await act(async () => liveDiscussion.reconcile({ wholeBranch: false, files: edited }));
  expect(await screen.findByText("Outdated context")).toBeVisible();
  const snippet = screen.getByLabelText("Original selected code");
  expect(snippet).toHaveTextContent("selected");
  expect(screen.getByTestId("code-fixture")).not.toContainElement(snippet);
});

it("keeps the newest mapping and clears a transient mapping error", async () => {
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({ status: "ok", data: null });
  vi.mocked(commands.captureReviewAnchor).mockResolvedValue({
    status: "ok",
    data: { originalCommitId: "commit", originalBlobId: "blob" },
  });
  type Mapping = Awaited<ReturnType<typeof commands.mapReviewThreads>>;
  let resolveOlder!: (result: Mapping) => void;
  const older = new Promise<Mapping>((resolve) => { resolveOlder = resolve; });
  vi.mocked(commands.mapReviewThreads)
    .mockReset()
    .mockResolvedValueOnce({ status: "error", error: "git" })
    .mockReturnValueOnce(older)
    .mockImplementationOnce(async (_worktree, [request]) => ({
      status: "ok",
      data: [{ threadId: request.threadId, status: "open", startLine: 4, line: 4 }],
    }));

  render(fixture("A", vi.fn(), "main-chat"));
  await waitFor(() => expect(liveDiscussion.canAsk).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Select fixture" }));
  fireEvent.click(screen.getByRole("button", { name: "Open mini" }));
  await screen.findByRole("button", { name: "Highlight selected code: a:1 (new)" });
  await act(async () => liveDiscussion.reconcile({ wholeBranch: false, files: [] }));
  expect(liveDiscussion.anchorError).toBe("Git could not load the review anchor.");
  act(() => liveDiscussion.reconcile({ wholeBranch: false, files: [] }));
  await act(async () => liveDiscussion.reconcile({ wholeBranch: false, files: [] }));
  expect(liveDiscussion.anchorError).toBeNull();
  await act(async () => resolveOlder({ status: "error", error: "git" }));
  expect(liveDiscussion.anchorError).toBeNull();
  expect(screen.getByRole("button", { name: "Highlight selected code: a:4 (new)" })).toBeVisible();
});

it("keeps an unavailable anchor separate from a confirmed outdated selection", async () => {
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({ status: "ok", data: null });
  vi.mocked(commands.captureReviewAnchor).mockResolvedValue({
    status: "ok",
    data: { originalCommitId: "commit", originalBlobId: "blob" },
  });
  vi.mocked(commands.mapReviewThreads)
    .mockReset()
    .mockImplementationOnce(async (_worktree, [request]) => ({
      status: "ok",
      data: [{ threadId: request.threadId, status: "unavailable", startLine: null, line: null }],
    }))
    .mockImplementationOnce(async (_worktree, [request]) => ({
      status: "ok",
      data: [{ threadId: request.threadId, status: "open", startLine: 1, line: 1 }],
    }));
  render(fixture("A", vi.fn(), "main-chat"));
  await waitFor(() => expect(liveDiscussion.canAsk).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Select fixture" }));
  fireEvent.click(screen.getByRole("button", { name: "Open mini" }));
  await screen.findByRole("region", { name: "Selection discussion" });
  await act(async () => liveDiscussion.reconcile({ wholeBranch: false, files: fixtureFiles }));
  expect(await screen.findByText("Anchor unavailable")).toBeVisible();
  expect(liveDiscussion.threads[0]).toMatchObject({ status: { kind: "unavailable", lastKnown: "open" }, outdatedNoted: false });
  await act(async () => liveDiscussion.reconcile({ wholeBranch: false, files: fixtureFiles }));
  expect(screen.queryByText("Anchor unavailable")).toBeNull();
  expect(liveDiscussion.threads[0]).toMatchObject({ status: { kind: "inline" }, outdatedNoted: false });
});

it("restores sessionless threads and applies refreshed positions and tombstones in place", async () => {
  const row: ReviewThread = {
    threadId: "restored", revision: 1, checkoutPath: "/A",
    payload: {
      parentChatId: "parent-A", path: "a", side: "RIGHT", homeKind: "worktree",
      toolUseId: null, originalCommitId: "commit", originalBlobId: "blob",
      originalStartLine: 1, originalLine: 1, startLine: 1, line: 1,
      status: "open", outdatedNoted: false, originKind: "local", originRef: null,
    },
  };
  let rows: ReviewThread[] = [row];
  vi.mocked(commands.getProjects).mockResolvedValueOnce({
    status: "ok", data: [{ path: "/project", project_id: "project-id", slug: "project" }],
  });
  vi.mocked(commands.listReviewThreads).mockImplementation(async () => ({ status: "ok", data: rows }));
  vi.mocked(commands.mapReviewThreads).mockResolvedValue({
    status: "ok", data: [{ threadId: row.threadId, status: "unavailable", startLine: null, line: null }],
  });

  render(fixture());
  await screen.findByRole("button", { name: "Reopen selection discussion" });
  expect(liveDiscussion.threads[0].sessionId).toBeNull();
  const snapshot = { wholeBranch: false, files: fixtureFiles };
  await act(async () => liveDiscussion.reconcile(snapshot));
  expect(commands.putReviewThread).not.toHaveBeenCalled();
  expect(liveDiscussion.threads[0]).toMatchObject({ status: { kind: "unavailable" }, anchor: { startLine: 1 } });

  vi.mocked(commands.mapReviewThreads).mockResolvedValue({
    status: "ok", data: [{ threadId: row.threadId, status: "open", startLine: 3, line: 3 }],
  });
  await act(async () => liveDiscussion.reconcile(snapshot));
  expect(commands.putReviewThread).toHaveBeenCalledWith("project-id", row.threadId,
    { kind: "position", position: { status: "open", startLine: 3, line: 3 } });
  rows = [{ ...row, revision: 2, payload: { ...row.payload, startLine: 3, line: 3 } }];
  const changed = vi.mocked(events.reviewThreadChanged.listen).mock.lastCall![0];
  const update = { event: "review-thread-changed", id: 3,
    payload: { projectId: "project-id", threadId: row.threadId, thread: rows[0] } };
  const maps = vi.mocked(commands.mapReviewThreads).mock.calls.length;
  await act(async () => { await changed(update); await changed(update); });
  expect(commands.listReviewThreads).toHaveBeenCalledTimes(1);
  expect(commands.mapReviewThreads).toHaveBeenCalledTimes(maps);
  const recovered = vi.mocked(events.reviewThreadCatalogRecovered.listen).mock.lastCall![0];
  await act(async () => recovered({ event: "review-thread-catalog-recovered", id: 1, payload: { projectId: "project-id" } }));
  await act(async () => liveDiscussion.reconcile(snapshot));
  expect(commands.putReviewThread).toHaveBeenCalledTimes(1);
  expect(commands.readReviewAnchor).toHaveBeenCalledTimes(1);

  rows = [];
  await act(async () => changed({
    event: "review-thread-changed", id: 2,
    payload: { projectId: "project-id", threadId: row.threadId, thread: null },
  }));
  expect(liveDiscussion.threads).toEqual([]);
  expect(screen.queryByRole("button", { name: "Reopen selection discussion" })).toBeNull();
  vi.mocked(commands.listReviewThreads).mockResolvedValue({ status: "ok", data: [] });
});

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function restoredRow(overrides: Partial<ReviewThread["payload"]> = {}): ReviewThread {
  return {
    threadId: "restored", revision: 1, checkoutPath: "/A",
    payload: {
      parentChatId: "parent-A", path: "a", side: "RIGHT", homeKind: "worktree",
      toolUseId: null, originalCommitId: "commit", originalBlobId: "blob",
      originalStartLine: 1, originalLine: 1, startLine: 1, line: 1,
      status: "open", outdatedNoted: false, originKind: "local", originRef: null,
      ...overrides,
    },
  };
}

function findFixtureProject() {
  vi.mocked(commands.getProjects).mockResolvedValueOnce({
    status: "ok", data: [{ path: "/project", project_id: "project-id", slug: "project" }],
  });
}

function emitChange(thread: ReviewThread | null, id = "restored") {
  return vi.mocked(events.reviewThreadChanged.listen).mock.lastCall![0]({
    event: "review-thread-changed", id: 1,
    payload: { projectId: "project-id", threadId: id, thread },
  });
}

function emitRecovery() {
  return vi.mocked(events.reviewThreadCatalogRecovered.listen).mock.lastCall![0]({
    event: "review-thread-catalog-recovered", id: 2, payload: { projectId: "project-id" },
  });
}

it("disposes a listener that finishes registering after unmount", async () => {
  findFixtureProject();
  const deferred = defer<() => void>();
  const unlisten = vi.fn();
  vi.mocked(events.reviewThreadChanged.listen).mockReturnValueOnce(deferred.promise);
  const view = render(fixture());
  await waitFor(() => expect(events.reviewThreadChanged.listen).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => deferred.resolve(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
  expect(commands.listReviewThreads).not.toHaveBeenCalled();
});

it("releases the other listener on partial registration failure and still loads the catalog", async () => {
  findFixtureProject();
  const deferred = defer<() => void>();
  const unlisten = vi.fn();
  vi.mocked(events.reviewThreadChanged.listen).mockReturnValueOnce(deferred.promise);
  vi.mocked(events.reviewThreadCatalogRecovered.listen).mockRejectedValueOnce(new Error("Listener failed"));
  vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({ status: "ok", data: [restoredRow()] });
  render(fixture());
  await screen.findByRole("button", { name: "Reopen selection discussion" });
  expect(liveDiscussion.anchorError).toBe("Listener failed");
  await act(async () => deferred.resolve(unlisten));
  expect(unlisten).toHaveBeenCalledOnce();
});

it("keeps a live change during initial load and prevents a racing refresh from resurrecting a tombstone", async () => {
  findFixtureProject();
  const initial = defer<Awaited<ReturnType<typeof commands.listReviewThreads>>>();
  const row = restoredRow();
  vi.mocked(commands.listReviewThreads).mockReturnValueOnce(initial.promise);
  render(fixture());
  await waitFor(() => expect(commands.listReviewThreads).toHaveBeenCalledOnce());
  await act(async () => emitChange({ ...row, revision: 2, payload: { ...row.payload, status: "outdated" } }));
  await act(async () => initial.resolve({ status: "ok", data: [row] }));
  expect(liveDiscussion.threads[0].status.kind).toBe("outdated");

  const refresh = defer<Awaited<ReturnType<typeof commands.listReviewThreads>>>();
  vi.mocked(commands.listReviewThreads).mockReturnValueOnce(refresh.promise);
  await act(async () => emitRecovery());
  await waitFor(() => expect(commands.listReviewThreads).toHaveBeenCalledTimes(2));
  await act(async () => emitChange(null));
  await act(async () => refresh.resolve({ status: "ok", data: [row] }));
  expect(liveDiscussion.threads).toEqual([]);
});

it("does not hydrate again in response to a catalog recovery event", async () => {
  findFixtureProject();
  const sessions = defer<void>();
  const hydrate = vi.spyOn(useChatStore.getState(), "hydrateLocalSessionIndex")
    .mockReturnValueOnce(sessions.promise);
  try {
    vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({ status: "ok", data: [restoredRow()] });
    render(fixture());
    await waitFor(() => expect(hydrate).toHaveBeenCalledOnce());
    await act(async () => emitRecovery());
    expect(commands.listReviewThreads).not.toHaveBeenCalled();
    await act(async () => sessions.resolve());
    await screen.findByRole("button", { name: "Reopen selection discussion" });
    await act(async () => emitRecovery());
    expect(hydrate).toHaveBeenCalledOnce();
    expect(commands.listReviewThreads).toHaveBeenCalledTimes(2);
  } finally {
    hydrate.mockRestore();
  }
});

it("writes the newer mapped position and ignores a late acknowledgment of the earlier one", async () => {
  findFixtureProject();
  const row = restoredRow();
  vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({ status: "ok", data: [row] });
  const first = defer<Awaited<ReturnType<typeof commands.putReviewThread>>>();
  const second = defer<Awaited<ReturnType<typeof commands.putReviewThread>>>();
  vi.mocked(commands.putReviewThread).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(fixture());
  await screen.findByRole("button", { name: "Reopen selection discussion" });

  async function map(line: number) {
    vi.mocked(commands.mapReviewThreads).mockResolvedValue({
      status: "ok", data: [{ threadId: row.threadId, status: "open", startLine: line, line }],
    });
    await act(async () => liveDiscussion.reconcile({ wholeBranch: false, files: fixtureFiles }));
  }
  await map(3);
  await map(7);
  expect(commands.putReviewThread).toHaveBeenCalledTimes(1);
  expect(liveDiscussion.threads[0].anchor.startLine).toBe(7);
  await act(async () => first.resolve({ status: "ok", data: null }));
  expect(commands.putReviewThread).toHaveBeenLastCalledWith("project-id", row.threadId, {
    kind: "position", position: { status: "open", startLine: 7, line: 7 },
  });
  await act(async () => second.resolve({ status: "ok", data: null }));
  await act(async () => emitChange({ ...row, revision: 2, payload: { ...row.payload, startLine: 3, line: 3 } }));
  expect(liveDiscussion.threads[0].anchor.startLine).toBe(7);
  await act(async () => emitChange({ ...row, revision: 3, payload: { ...row.payload, startLine: 7, line: 7 } }));
  expect(commands.putReviewThread).toHaveBeenCalledTimes(2);
  expect(commands.mapReviewThreads).toHaveBeenCalledTimes(2);
});

it("saves the delivered outdated note when the originating project resolves late", async () => {
  const lookup = defer<Awaited<ReturnType<typeof commands.getProjects>>>();
  vi.mocked(commands.getProjects).mockReturnValueOnce(lookup.promise);
  vi.mocked(commands.mapReviewThreads).mockImplementation(async (_, [request]) => ({
    status: "ok", data: [{ threadId: request.threadId, status: "outdated", startLine: null, line: null }],
  }));
  render(fixture());
  await open();
  const id = liveDiscussion.threads[0].id;
  await act(async () => liveDiscussion.reconcile({ wholeBranch: false, files: fixtureFiles }));
  await send("Ask before project lookup finishes");
  expect(commands.putReviewThread).not.toHaveBeenCalled();
  await act(async () => lookup.resolve({
    status: "ok", data: [{ path: "/project", project_id: "project-id", slug: "project" }],
  }));
  await waitFor(() => expect(commands.putReviewThread).toHaveBeenCalledExactlyOnceWith(
    "project-id", id, { kind: "outdated_note" }
  ));
});

function seedResumableDiscussion(threadId = "restored") {
  const store = useChatStore.getState();
  const id = store.openDiscussionSession({
    harness: "claude", projectPath: "/project",
    discussionBinding: { parentChatId: "parent-A", reviewThreadId: threadId, worktreePath: "/A" },
  });
  useChatStore.setState(({ sessions }) => ({
    sessions: { ...sessions, [id]: { ...sessions[id], providerResumeId: "saved-resume" } },
  }));
  return id;
}

it("reports an unreadable anchor and retains the bound conversation even when a refresh omits the row", async () => {
  findFixtureProject();
  const sessionId = seedResumableDiscussion();
  const row = restoredRow();
  vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({ status: "ok", data: [row] });
  vi.mocked(commands.readReviewAnchor).mockRejectedValueOnce(new Error("Git read failed"));
  render(fixture());
  await screen.findByRole("button", { name: "Reopen selection discussion" });
  expect(liveDiscussion.anchorError).toContain("Git read failed");
  expect(liveDiscussion.threads[0]).toMatchObject({ sessionId, status: { kind: "unreadable" } });
  vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({ status: "ok", data: [] });
  await act(async () => emitRecovery());
  expect(useChatStore.getState().sessions[sessionId].providerResumeId).toBe("saved-resume");
  expect(commands.closeLocalChatSession).not.toHaveBeenCalled();

  vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({ status: "ok", data: [row] });
  await act(async () => emitRecovery());
  expect(liveDiscussion.threads[0]).toMatchObject({ sessionId, status: { kind: "detached" } });
  fireEvent.click(screen.getByRole("button", { name: "Reopen selection discussion" }));
  await send("Continue the original discussion");
  expect(commands.createLocalChatSession).toHaveBeenCalledWith(expect.objectContaining({
    chat_session_id: sessionId, provider_resume_id: "saved-resume",
  }));
});

it("rejects a saved tool call without an ID and restores a valid tool marker that can start a session", async () => {
  const tool = restoredRow({ parentChatId: "code-fixture", homeKind: "tool_call", toolUseId: "fixture-tool" });
  for (const restart of [false, true]) {
    findFixtureProject();
    vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({ status: "ok", data: [
      { ...tool, threadId: "invalid", payload: { ...tool.payload, toolUseId: null } }, tool,
    ] });
    const view = render(codeFixture());
    const marker = await screen.findByRole("button", { name: "Reopen selection discussion" });
    expect(screen.getByTestId("fixture-line-1")).toContainElement(marker);
    expect(commands.readReviewAnchor).not.toHaveBeenCalledWith("/A", "invalid", expect.anything());
    if (!restart) {
      view.unmount();
      useChatStore.getState().reset();
      continue;
    }
    fireEvent.click(marker);
    await send("Start this saved selection");
    expect(commands.createLocalChatSession).toHaveBeenCalledWith(expect.objectContaining({
      read_only: true, working_dir: "/A",
      initial_prompt: expect.stringContaining("Question: Start this saved selection"),
    }));
  }
});

it("writes the outdated note once after successful delivery and retries it after a failed send", async () => {
  findFixtureProject();
  seedResumableDiscussion();
  vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({
    status: "ok", data: [restoredRow({ status: "outdated", startLine: null, line: null })],
  });
  vi.mocked(commands.createLocalChatSession).mockResolvedValueOnce({
    status: "error", error: { StartFailed: "Provider unavailable" },
  });
  render(fixture());
  fireEvent.click(await screen.findByRole("button", { name: "Reopen selection discussion" }));
  await send("First try");
  await screen.findByText("Provider unavailable", { exact: false });
  expect(commands.putReviewThread).not.toHaveBeenCalled();

  const id = await send("Second try");
  await waitFor(() => expect(commands.putReviewThread).toHaveBeenCalledWith(
    "project-id", "restored", { kind: "outdated_note" }
  ));
  act(() => end(id));
  await send("Third question");
  expect(commands.sendLocalChatMessage).toHaveBeenLastCalledWith(id, "Third question", expect.anything());
  expect(commands.putReviewThread).toHaveBeenCalledTimes(1);
});

it("persists a delivered note when the delivery resolves after unmount", async () => {
  findFixtureProject();
  seedResumableDiscussion();
  vi.mocked(commands.listReviewThreads).mockResolvedValueOnce({
    status: "ok", data: [restoredRow({ status: "outdated", startLine: null, line: null })],
  });
  const delivery = defer<Awaited<ReturnType<typeof commands.createLocalChatSession>>>();
  vi.mocked(commands.createLocalChatSession).mockReturnValueOnce(delivery.promise);
  const noteWrite = defer<Awaited<ReturnType<typeof commands.putReviewThread>>>();
  vi.mocked(commands.putReviewThread).mockReturnValueOnce(noteWrite.promise);
  const view = render(fixture());
  fireEvent.click(await screen.findByRole("button", { name: "Reopen selection discussion" }));
  await act(async () => liveDiscussion.send("restored", "Will finish during navigation"));
  view.unmount();
  await act(async () => delivery.resolve({ status: "ok", data: null }));
  await act(async () => noteWrite.resolve({ status: "ok", data: null }));
  expect(commands.putReviewThread).toHaveBeenCalledExactlyOnceWith("project-id", "restored", { kind: "outdated_note" });
});

it("keeps deleted tool-patch lines available for the main chat composer", async () => {
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({ status: "ok", data: null });
  const attach = vi.fn();
  render(codeFixture(attach, vi.fn(), "main-chat", "tool_call", "deletions"));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));
  expect(screen.queryByRole("button", { name: "Discuss inline" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ side: "old", code: "old" }), false, "");
});

it("rejects a direct discussion request for the deleted side of a tool patch", async () => {
  vi.mocked(commands.checkReviewAnchorWorktree).mockResolvedValue({ status: "ok", data: null });
  render(fixture("A", vi.fn(), "main-chat"));
  await waitFor(() => expect(liveDiscussion.canAsk).toBe(true));

  await act(async () => {
    expect(await liveDiscussion.discuss({
      ...anchor,
      side: "old",
      home: { kind: "tool_call", toolUseId: "fixture-tool" },
    }, "Why?")).toBe(false);
  });
  expect(commands.captureReviewAnchor).not.toHaveBeenCalled();
});
