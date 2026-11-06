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
import { beforeEach, expect, it, vi } from "vitest";
import type {
  LocalChatTextEvent,
  LocalChatSessionEndEvent,
  LocalChatSessionErrorEvent,
} from "../../bindings";
import { commands } from "../../bindings";
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
  fireEvent.change(
    screen.getByRole("textbox", { name: "Ask about selected code" }),
    { target: { value: text } }
  );
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await waitFor(() =>
    expect(commands.createLocalChatSession).toHaveBeenCalled()
  );

  const calls = vi.mocked(commands.createLocalChatSession).mock.calls;
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
  vi.mocked(commands.createLocalChatSession).mockResolvedValue({
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

  fireEvent.click(screen.getByText("Cancel response"));
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

  expect(commands.closeLocalChatSession).toHaveBeenCalledWith(id);
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

it("opens a two-action dialog with + and renders questions and answers beneath the code", async () => {
  const onOpen = vi.fn();
  const onAttach = vi.fn();
  const view = codeFixture(onAttach, onOpen);

  render(view);
  fireEvent.click(screen.getByText("Select code"));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(commands.createLocalChatSession).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Add code comment" }));

  expect(
    screen.getByRole("dialog", { name: "Comment on selected code" })
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Discuss inline" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Send to main chat" })
  ).toBeEnabled();

  fireEvent.change(screen.getByRole("textbox", { name: "New diff comment" }), {
    target: { value: "Why selected?" },
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
        text: "Inline answer",
        is_partial: false,
        parent_tool_use_id: null,
      },
    });
    end(id);
  });

  expect(screen.queryByRole("dialog")).toBeNull();

  const thread = screen.getByTestId("selection-mini-thread");

  expect(screen.getByTestId("code-fixture")).toContainElement(thread);
  expect(thread).toHaveTextContent("Why selected?");
  expect(thread).toHaveTextContent("Inline answer");
  expect(onOpen).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Close discussion" }));

  expect(screen.queryByTestId("selection-mini-thread")).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: "Reopen selection discussion" })
  );

  expect(screen.getByTestId("selection-mini-thread")).toHaveTextContent(
    "Inline answer"
  );
});

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
      const view = render(initialFixture);

      try {
        // Exercise cancellation, follow-up and both identity boundaries in every case.
        const prefix = [0, 1, 2, 3, 11, 21, 7, 0, 1, 2, 8, 9, 0, 1, 2];

        for (const encoded of [...prefix, ...sequence]) {
          const operation = encoded % 12;
          const choice = Math.floor(encoded / 12);

          if (operation === 0) {
            act(() => liveDiscussion.select(anchor));
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
            view.rerender(nextFixture);
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

it("restores each discussion's range when switching between two comments", () => {
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
