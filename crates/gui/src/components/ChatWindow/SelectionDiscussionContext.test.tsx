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
} from "../../bindings";
import { commands, events } from "../../bindings";
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
  unlisten: vi.fn(),
}));

vi.mock("../../bindings", () => ({
  commands: {
    getSupportedLocalChatHarnesses: vi.fn(),
    createLocalChatSession: vi.fn(async () => ({ status: "ok" })),
    closeLocalChatSession: vi.fn(async () => ({ status: "ok" })),
  },
  events: {
    localChatTextEvent: {
      listen: vi.fn(async (handler: typeof transport.text) => {
        transport.text = handler;

        return transport.unlisten;
      }),
    },
    localChatSessionEndEvent: {
      listen: vi.fn(async (handler: typeof transport.end) => {
        transport.end = handler;

        return transport.unlisten;
      }),
    },
    localChatSessionErrorEvent: {
      listen: vi.fn(async (handler: typeof transport.error) => {
        transport.error = handler;

        return transport.unlisten;
      }),
    },
  },
}));

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

  fireEvent.click(askButton);

  await waitFor(() => {
    expect(commands.createLocalChatSession).toHaveBeenCalled();
  });

  const sessionCommand = vi.mocked(commands.createLocalChatSession);
  const calls = sessionCommand.mock.calls;
  const request = calls.at(-1)![0];

  return request.backend_session_id;
}

function end(id: string, handler = transport.end) {
  handler?.({
    payload: {
      backend_session_id: id,
      harness: "claude",
      turn_id: "turn",
      is_root: true,
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

  await send("Follow up");

  const calls = vi.mocked(commands.createLocalChatSession).mock.calls;
  const followUpRequest = calls.at(-1)![0];
  const followUpPrompt = followUpRequest.initial_prompt;

  expect(followUpPrompt).toContain("Full answer");
  expect(followUpPrompt).toContain('"code":"selected"');
});

it("cancels during creation and closes a runtime that appears late", async () => {
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
  const pendingIndicator = screen.getByTestId("thinking-indicator");

  expect(pendingIndicator).toBeVisible();

  const cancelButton = screen.getByText("Cancel response");

  fireEvent.click(cancelButton);

  const cancelledIndicator = screen.queryByTestId("thinking-indicator");

  expect(cancelledIndicator).toBeNull();

  act(() =>
    transport.text?.({
      payload: {
        backend_session_id: id,
        harness: "claude",
        text: "late answer",
        is_partial: false,
        parent_tool_use_id: null,
      },
    })
  );

  expect(screen.queryByText("late answer", { exact: false })).toBeNull();

  await act(async () => complete({ status: "ok", data: null }));

  const finishedIndicator = screen.queryByTestId("thinking-indicator");

  expect(commands.closeLocalChatSession).toHaveBeenCalledWith(id);
  expect(finishedIndicator).toBeNull();
});

it("retires scope listeners and ignores success and errors from another worktree", async () => {
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
  expect(transport.unlisten).toHaveBeenCalledTimes(3);
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
  const callback = selectionCallbacks.at(-1);
  const renders = selectionCallbacks.length;

  for (const text of ["First ", "second ", "third"]) {
    act(() =>
      transport.text?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text,
          is_partial: true,
          parent_tool_use_id: null,
        },
      })
    );

    expect(selectionCallbacks.length).toBe(renders);
    expect(selectionCallbacks.at(-1)).toBe(callback);
    expect(screen.getByRole("status").textContent).toBe("");
  }

  const liveAnnouncement = screen
    .getByText("First second third", { exact: false })
    .closest("[aria-live]");

  expect(liveAnnouncement).toBeNull();

  act(() => end(id));

  expect(screen.getByRole("status")).toHaveTextContent("Reply complete.");
  expect(selectionCallbacks.length).toBe(renders);
});

it("shows a readable failure and logs only its category and request correlation", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

  vi.mocked(commands.createLocalChatSession).mockResolvedValueOnce({
    status: "error",
    error: { StartFailed: "credential-123 raw backend detail" },
  });

  try {
    render(fixture());
    open();
    await send();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not start the discussion. Check your provider settings and try again."
    );
    expect(screen.queryByText(/credential-123|StartFailed/)).toBeNull();
    const requestIdMatcher = expect.any(String);
    const diagnosticMatcher = expect.objectContaining({
      category: "StartFailed",
      harness: "claude",
      requestId: requestIdMatcher,
    });

    expect(warning).toHaveBeenCalledWith(
      "Selection discussion failed",
      diagnosticMatcher
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("credential-123");
  } finally {
    warning.mockRestore();
  }
});

it("generated provider journeys observe command dispatch and retire responses across identities", async () => {
  await hegel.testAsync(
    async (tc) => {
      vi.mocked(commands.createLocalChatSession).mockClear();

      const operationGenerator = gs.integers({ minValue: 0, maxValue: 131 });
      const sequenceGenerator = gs.arrays(operationGenerator, {
        minSize: 1,
        maxSize: 45,
      });
      const sequence = tc.draw(sequenceGenerator);
      const attach = vi.fn();
      let session = 0;
      let worktree = 0;
      let generation = 0;
      let selected = false;
      let active: number | null = null;
      let expectedRequests = 0;
      let expectedAttachments = 0;
      let facts: {
        id: string;
        request: string | null;
        text: string[];
        outdated: boolean;
      }[] = [];
      const requests: {
        generation: number;
        thread: number;
        id: string;
        text: typeof transport.text;
        end: typeof transport.end;
      }[] = [];
      const scope = () => `session-${session}:worktree-${worktree}`;
      const initialFixture = fixture(scope(), attach);
      const view = await act(async () => render(initialFixture));

      try {
        // Exercise cancellation, follow-up and both identity boundaries in every case.
        const prefix = [0, 1, 2, 3, 11, 21, 7, 0, 1, 2, 8, 9, 0, 1, 2];

        for (const encoded of [...prefix, ...sequence]) {
          const operation = encoded % 12;
          const choice = Math.floor(encoded / 12);

          if (operation === 0) {
            await act(async () => liveDiscussion.select(anchor));
            selected = true;
          }

          if (operation === 1) {
            act(() => liveDiscussion.ask());

            if (selected) {
              active = facts.length;
              facts.push({
                id: liveDiscussion.threads.at(-1)!.id,
                request: null,
                text: [],
                outdated: false,
              });
            }
          }

          if ((operation === 2 || operation === 11) && active !== null) {
            const fact = facts[active];
            const shouldDispatch = fact.request === null;
            const question = operation === 2 ? "question" : "follow up";

            await act(async () => liveDiscussion.send(fact.id, question));

            if (shouldDispatch) {
              expectedRequests++;
              fact.text.push(question);

              const calls = vi.mocked(commands.createLocalChatSession).mock
                .calls;
              const input = calls.at(-1)![0];

              expect(input).toMatchObject({
                read_only: true,
                working_dir: `/${scope()}`,
              });
              expect(input.initial_prompt).toContain('"code":"selected"');

              fact.request = input.backend_session_id;
              requests.push({
                generation,
                thread: active,
                id: input.backend_session_id,
                text: transport.text,
                end: transport.end,
              });
            }
          }

          if (operation === 3 && active !== null) {
            act(() => liveDiscussion.cancel(facts[active!].id));
            facts[active].request = null;
          }

          if (operation === 4 && facts.length) {
            active = choice % facts.length;
            act(() => liveDiscussion.reopen(facts[active!].id));
            selected = true;
          }

          if (operation === 5) {
            act(() => liveDiscussion.reopen(null));
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

            generation++;
            const nextFixture = fixture(scope(), attach);
            await act(async () => view.rerender(nextFixture));
            facts = [];
            active = null;
            selected = false;
          }

          if (operation === 9 && requests.length) {
            const request = requests[choice % requests.length];
            const fact =
              request.generation === generation
                ? facts[request.thread]
                : undefined;
            const accepted = fact?.request === request.id;

            act(() => {
              request.text?.({
                payload: {
                  backend_session_id: request.id,
                  harness: "claude",
                  text: "deterministic answer",
                  is_partial: false,
                  parent_tool_use_id: null,
                },
              });
              end(request.id, request.end);
            });

            if (accepted) {
              fact!.text.push("deterministic answer");
              fact!.request = null;
            }
          }

          if (operation === 10 && selected) {
            act(() => liveDiscussion.attach(anchor));
            expectedAttachments++;
          }

          expect(commands.createLocalChatSession).toHaveBeenCalledTimes(
            expectedRequests
          );
          expect(attach).toHaveBeenCalledTimes(expectedAttachments);
          expect(liveDiscussion.selection !== null).toBe(selected);
          expect(liveDiscussion.activeId).toBe(
            active === null ? null : facts[active].id
          );
          const observedThreads = liveDiscussion.threads.map((thread) => {
            const text = thread.messages.map((message) => message.text);

            return {
              code: thread.anchor.code,
              waiting: thread.requestId !== null,
              outdated: thread.outdated,
              text,
            };
          });
          const expectedThreads = facts.map((fact) => ({
            code: "selected",
            waiting: fact.request !== null,
            outdated: fact.outdated,
            text: fact.text,
          }));

          expect(observedThreads).toEqual(expectedThreads);
        }
      } finally {
        view.unmount();
      }
    },
    { seed: 0x0cd1b402, testCases: 40 }
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

  await send("Follow up after change");

  const previousAnswer = expect.stringContaining("Dedicated answer");
  const followUpRequest = expect.objectContaining({
    harness: "claude",
    provider_id: "anthropic",
    model_id: "sonnet",
    read_only: true,
    initial_prompt: previousAnswer,
  });

  expect(commands.createLocalChatSession).toHaveBeenLastCalledWith(
    followUpRequest
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

it("captures provider/model before listener setup even when settings change before native creation", async () => {
  let registered!: (unlisten: () => void) => void;
  const textListener = vi.mocked(events.localChatTextEvent.listen);

  textListener.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        registered = resolve;
      })
  );

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
  await waitFor(() => {
    const alert = screen.queryByRole("alert");

    expect(alert).toBeNull();
  });

  act(() => liveDiscussion.send(liveDiscussion.activeId!, "Pending setup"));

  expect(commands.createLocalChatSession).not.toHaveBeenCalled();

  act(() => uiState.setInlineDiscussionPreference({ mode: "follow" }));
  await act(async () => registered(transport.unlisten));

  const capturedRequest = expect.objectContaining({
    harness: "codex",
    provider_id: "custom",
    model_id: "dedicated",
    read_only: true,
  });

  expect(commands.createLocalChatSession).toHaveBeenLastCalledWith(
    capturedRequest
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
    permission_mode: null,
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
    const initialMessage = initialQuestion.closest("article");
    const initialIndicator = screen.getByTestId("thinking-indicator");

    expect(initialMessage).toHaveClass("is-user");
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
    const followUpMessage = followUpText.closest("article");
    const pendingRequest = liveDiscussion.threads[0].requestId;

    expect(retainedAnswer).toBeVisible();
    expect(followUpIndicator).toBeVisible();
    expect(followUpMessage).toHaveClass("is-user");
    expect(pendingRequest).toBe(followUp);

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
  "shows %s thinking through deferred setup with previous history=%s",
  async (style, history) => {
    useUIStore.setState({ thinkingIndicatorStyle: style });

    const component = fixture();

    render(component);
    open();

    if (history) {
      const first = await send();

      act(() => {
        transport.text?.({
          payload: {
            backend_session_id: first,
            harness: "claude",
            text: "Earlier answer",
            is_partial: false,
            parent_tool_use_id: null,
          },
        });
        end(first);
      });
    }

    await waitFor(() => {
      const alert = screen.queryByRole("alert");

      expect(alert).toBeNull();
    });

    let register!: (cleanup: () => void) => void;
    const textListener = vi.mocked(events.localChatTextEvent.listen);

    textListener.mockImplementationOnce((handler) => {
      transport.text = (event) =>
        handler({ event: "local-chat-text-event", id: 0, ...event });

      return new Promise((resolve) => {
        register = resolve;
      });
    });

    let complete!: (
      value: Awaited<ReturnType<typeof commands.createLocalChatSession>>
    ) => void;
    const createSession = vi.mocked(commands.createLocalChatSession);

    createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );

    const threadId = liveDiscussion.activeId!;

    act(() => liveDiscussion.send(threadId, "Waiting follow-up"));

    const initialIndicator = screen.getByTestId("thinking-indicator");
    const previousRequests = history ? 1 : 0;

    expect(initialIndicator).toHaveAttribute("data-style", style);
    expect(commands.createLocalChatSession).toHaveBeenCalledTimes(
      previousRequests
    );

    await act(async () => register(transport.unlisten));

    const registeredIndicator = screen.getByTestId("thinking-indicator");

    expect(registeredIndicator).toBeVisible();

    await act(async () => complete({ status: "ok", data: null }));

    const id = liveDiscussion.threads[0].requestId!;

    act(() =>
      transport.text?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text: "",
          is_partial: true,
          parent_tool_use_id: null,
        },
      })
    );

    const emptyTextIndicator = screen.getByTestId("thinking-indicator");

    expect(emptyTextIndicator).toBeVisible();

    act(() =>
      transport.text?.({
        payload: {
          backend_session_id: id,
          harness: "claude",
          text: "Now streaming",
          is_partial: true,
          parent_tool_use_id: null,
        },
      })
    );

    const streamingIndicator = screen.queryByTestId("thinking-indicator");

    expect(streamingIndicator).toBeNull();

    act(() => end(id));
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
          is_partial: true,
          parent_tool_use_id: null,
        },
      })
    );

    const retiredReply = screen.queryByText("Retired reply");

    expect(retiredReply).toBeNull();
  }
);

it.each(["cancel", "unmount", "listener rejection"])(
  "retires the initial thinking indicator during listener setup: %s",
  async (terminal) => {
    let resolve!: (cleanup: () => void) => void;
    let reject!: (error: Error) => void;
    const textListener = vi.mocked(events.localChatTextEvent.listen);

    textListener.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        })
    );

    const component = fixture();
    const view = render(component);

    open();

    await waitFor(() => {
      const alert = screen.queryByRole("alert");

      expect(alert).toBeNull();
    });

    const threadId = liveDiscussion.activeId!;

    act(() => liveDiscussion.send(threadId, "Initial pending question"));

    const initialIndicator = screen.getByTestId("thinking-indicator");

    expect(initialIndicator).toBeVisible();
    expect(commands.createLocalChatSession).not.toHaveBeenCalled();

    if (terminal === "cancel") {
      const cancelButton = screen.getByRole("button", {
        name: "Cancel response",
      });

      fireEvent.click(cancelButton);
    }

    if (terminal === "unmount") {
      const nextComponent = fixture("B");

      view.rerender(nextComponent);
      open();
    }

    await act(async () => {
      if (terminal === "listener rejection") {
        const listenerError = new Error("listener unavailable");

        reject(listenerError);
      } else {
        resolve(transport.unlisten);
      }
    });

    const finishedIndicator = screen.queryByTestId("thinking-indicator");
    const expectedUnlisteners = terminal === "listener rejection" ? 2 : 3;

    expect(finishedIndicator).toBeNull();
    expect(commands.createLocalChatSession).not.toHaveBeenCalled();
    expect(transport.unlisten).toHaveBeenCalledTimes(expectedUnlisteners);
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
