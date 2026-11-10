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
import { commands } from "../../bindings";
import { useChatStore } from "../../stores/chatStore";
import { flushPendingLocalChatText } from "../../utils/localChatTextBatch";
import {
  resetLocalChatTurnRoutingForTests,
  useLocalChatEventRouter,
} from "../../hooks/useLocalChatEventRouter";
import {
  SelectionDiscussionProvider,
  InlineSelectionDiscussion,
} from "./SelectionDiscussionContext";
import { captureCodeSelection } from "./selectionDiscussions";
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

function Controls() {
  const context = useContext(SelectionDiscussionContext)!;

  liveDiscussion = context;

  return (
    <>
      <button onClick={() => context.select(anchor)}>Select fixture</button>
      <button onClick={context.ask}>Open mini</button>
      <button onClick={() => context.attach(anchor)}>Attach fixture</button>
      {context.threads.map((thread) => (
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

function fixture(scope = "A", onAttach = vi.fn()) {
  return (
    <SelectionDiscussionProvider
      key={scope}
      worktreePath={`/${scope}`}
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

function open() {
  fireEvent.click(screen.getByText("Select fixture"));
  fireEvent.click(screen.getByText("Open mini"));
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
  render(<Router />);

  useUIStore.setState({
    inlineDiscussionPreference: { mode: "follow" },
    thinkingIndicatorStyle: "classic",
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
  open();
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
  open();

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
  open();

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

it("switching worktree discards the discussion session and ignores its late events", async () => {
  const view = render(fixture());

  open();

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
  expect(discussionSessions()).toEqual([]);
});

const selectionCallbacks: ReturnType<
  typeof useDiffComments
>["onSelectionChange"][] = [];

const codeSelections: unknown[] = [];

function CodeFixture() {
  const review = useDiffComments(
    { kind: "tool_call", toolUseId: "fixture-tool" },
    fixtureFiles
  );

  selectionCallbacks.push(review.onSelectionChange);
  codeSelections.push(review.selectedLinesFor("a"));

  const range = { start: 1, end: 1, side: "additions" as const };

  return (
    <div data-testid="code-fixture">
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
        <div key={`${annotation.side}:${annotation.lineNumber}`}>
          {review.renderAnnotation(annotation)}
        </div>
      ))}
    </div>
  );
}

const fixtureFiles = [anchor.file];

function codeFixture(onAttach = vi.fn(), onOpen = vi.fn()) {
  return (
    <SelectionDiscussionProvider
      worktreePath="/A"
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
        <CodeFixture />
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

    render(component);

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
  open();
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
            await act(async () => liveDiscussion.ask());

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
            facts.forEach((fact) => {
              fact.outdated = true;
            });
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
                outdated: thread.outdated,
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
          // Discussions never reach the chat history or persistence.
          expect(useChatStore.getState().localSessionSummaries).toEqual({});
        }
      } finally {
        view.unmount();
      }
    },
    { seed: 0x8640ee9e, testCases: 40 }
  );
});

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

  expect(codeSelections.at(-1)).toBeNull();

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
    fireEvent.click(screen.getByRole("button", { name: "Discuss inline" }));
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

it("captures dedicated choice per request and applies a settings change only to the follow-up", async () => {
  const uiState = useUIStore.getState();
  const dedicatedPreference = {
    mode: "dedicated" as const,
    providerId: "custom",
    modelId: "dedicated",
  };
  const view = fixture();

  uiState.setInlineDiscussionPreference(dedicatedPreference);
  render(view);
  open();

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

  const followUp = await send("Follow up after change");

  // A different harness cannot continue the conversation: the old process
  // closes and a fresh one starts from the anchor, never a replayed answer.
  const followUpRequest = expect.objectContaining({
    harness: "claude",
    provider_id: "anthropic",
    model_id: "sonnet",
    read_only: true,
    provider_resume_id: null,
  });
  const prompt = vi
    .mocked(commands.createLocalChatSession)
    .mock.calls.at(-1)![0].initial_prompt;

  expect(followUp).not.toBe(id);
  expect(commands.closeLocalChatSession).toHaveBeenCalledWith(id);
  expect(commands.createLocalChatSession).toHaveBeenLastCalledWith(
    followUpRequest
  );
  expect(prompt).toContain('"code":"selected"');
  expect(prompt).not.toContain("Dedicated answer");
  expect(commands.sendLocalChatMessage).not.toHaveBeenCalled();
});

it("applies a changed model to a follow-up in the same session as turn settings", async () => {
  const uiState = useUIStore.getState();

  render(fixture());
  open();

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
    open();
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

  open();
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
  open();
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

  open();
  view.rerender(nextComponent);
  open();
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
  open();
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

    render(component);
    open();

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
  ["classic", false],
  ["classic", true],
  ["futuristic", false],
  ["futuristic", true],
] as const)(
  "shows %s thinking for the whole turn with previous history=%s",
  async (style, history) => {
    useUIStore.setState({ thinkingIndicatorStyle: style });

    render(fixture());
    open();

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

    open();

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
      open();
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

    render(component);

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

  open();

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
