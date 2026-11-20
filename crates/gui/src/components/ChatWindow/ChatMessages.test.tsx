import type { ComponentProps } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { ChatEmptyState, ChatMessages } from "./ChatMessages";
import { useChatStore, type ChatMessage } from "../../stores/chatStore";
import { useEntityPanelStore } from "../../stores/entityPanelStore";
import { useUIStore } from "../../stores/uiStore";
import { CHAT_HELP_SHORTCUT, presentChatShortcut } from "./chatShortcuts";
import { FUTURISTIC_COMPACTING_PHRASES } from "./thinkingPhrases";

const { markdownRenderSpy } = vi.hoisted(() => ({
  markdownRenderSpy: vi.fn(),
}));

vi.mock("react-markdown", async () => {
  const actual =
    await vi.importActual<typeof import("react-markdown")>("react-markdown");
  const Markdown = actual.default;
  return {
    ...actual,
    default: (props: ComponentProps<typeof Markdown>) => {
      markdownRenderSpy(props.children);
      return <Markdown {...props} />;
    },
  };
});

Element.prototype.scrollIntoView = vi.fn();

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "test-session",
    messages: [] as ChatMessage[],
    assistantLabel: "Claude",
    isEmpty: true,
    isActive: false,
    isWaiting: false,
    activityLabel: null,
    streamingAssistant: null,
    ...overrides,
  };
}

describe("ChatMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEntityPanelStore.getState().reset();
    useUIStore.setState({ thinkingIndicatorStyle: "classic" });
  });

  // --- Empty state ---

  it("shows the empty state message when isEmpty and not active", () => {
    render(<ChatMessages {...defaultProps()} />);
    expect(
      screen.getByText("Create, edit, and delete tasks, steps, and workflows")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Or run a task through a workflow")
    ).toBeInTheDocument();

    const shortcut = presentChatShortcut(
      CHAT_HELP_SHORTCUT,
      navigator.platform
    );
    const hint = screen.getByTestId("chat-help-shortcut-hint");
    expect(hint).toHaveAccessibleName(
      `Press ${shortcut?.ariaLabel} to show keyboard shortcuts`
    );
    expect(
      [...hint.querySelectorAll("kbd")].map((key) => key.textContent)
    ).toEqual(shortcut?.keys);

    const icon = screen.getByTestId("chat-empty-state-icon");
    expect(icon).toHaveAttribute("data-chat-icon-tone", "grayscale");
    expect(icon.querySelector("svg")).toHaveClass(
      "text-[var(--color-fg-mute)]"
    );
    expect(icon.querySelector("svg")).not.toHaveClass(
      "text-[var(--color-accent)]"
    );
  });

  it("falls back to generic help copy when shortcut metadata is unavailable", () => {
    render(<ChatEmptyState chatHelpShortcut={null} />);

    expect(screen.getByTestId("chat-help-shortcut-fallback")).toHaveTextContent(
      "Use the chat panel's keyboard shortcuts for help"
    );
    expect(
      screen.queryByTestId("chat-help-shortcut-hint")
    ).not.toBeInTheDocument();
  });

  it("hides the empty state when not empty", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    expect(
      screen.queryByText("Create, edit, and delete tasks, steps, and workflows")
    ).not.toBeInTheDocument();
  });

  it("hides the empty state when active even with no messages", () => {
    render(
      <ChatMessages {...defaultProps({ isEmpty: true, isActive: true })} />
    );
    expect(
      screen.queryByText("Create, edit, and delete tasks, steps, and workflows")
    ).not.toBeInTheDocument();
  });

  // --- Message rendering ---

  it.each(["ticket", "task", "epic"])(
    "enables copy-ID controls on rendered %s chat references without opening their panels",
    async (type) => {
      const user = userEvent.setup();
      const writeText = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue();
      const id = "860cde1b-9093-42ff-a19d-7453f3b7891b";
      const messages: ChatMessage[] = [
        {
          kind: "assistant",
          text: `[Review this ${type}](vtb://${type}/${id})`,
          timestamp: "2024-01-01T12:00:00Z",
        },
      ];
      render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
      const link = screen.getByRole("link", { name: `Open ${type} ${id}` });
      expect(link).toHaveTextContent(`Review this ${type}`);
      expect(screen.getByTestId("vtb-entity-level-mark")).toHaveAttribute(
        "data-level",
        type
      );
      await user.click(
        screen.getByRole("button", { name: `Copy full ${type} ID` })
      );
      expect(writeText).toHaveBeenCalledExactlyOnceWith(id);
      expect(useEntityPanelStore.getState().selection).toBeNull();
      await user.click(link);
      expect(useEntityPanelStore.getState().selection).toEqual({
        type: "task",
        taskId: id,
      });
    }
  );

  it("renders user messages", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello world", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("wraps local chat threads in the bare event-log surface", () => {
    const messages: ChatMessage[] = [
      {
        kind: "user",
        text: "Please use `vtb ready`",
        timestamp: "2024-01-01T12:00:00Z",
      },
      {
        kind: "assistant",
        text: "I will check it.",
        timestamp: "2024-01-01T12:00:01Z",
      },
      {
        kind: "tool_call",
        toolName: "Bash",
        toolId: "tool-1",
        input: '{"command":"vtb ready"}',
        timestamp: "2024-01-01T12:00:02Z",
      },
    ];
    const { container } = render(
      <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
    );

    const eventLog = container.querySelector(".evlog.evlog--bare");
    expect(eventLog).toBeInTheDocument();
    const userRow = eventLog?.querySelector(".evrow--user");
    expect(userRow).toBeInTheDocument();
    expect(
      eventLog?.querySelector(
        ".evlog--bare .evrow--user:not(.is-prompt):not(.is-system)"
      )
    ).toBe(userRow);
    expect(userRow?.querySelector(".evbody")).toBeInTheDocument();
    expect(userRow).toHaveTextContent("You");
    expect(eventLog?.querySelector(".evrow--agent")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /1 call for/ })
    ).toBeInTheDocument();
  });

  it("renders assistant messages", () => {
    const messages: ChatMessage[] = [
      {
        kind: "assistant",
        text: "Hi there",
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    expect(screen.getByText("Hi there")).toBeInTheDocument();
  });

  it("offers a comment editor for selected completed assistant prose", () => {
    const onAddComment = vi.fn();
    const messages: ChatMessage[] = [
      {
        kind: "assistant",
        itemId: "assistant-item-42",
        text: "Read this carefully, then update the parser.",
        timestamp: "2024-01-01T12:00:01Z",
      },
    ];
    const { container } = render(
      <ChatMessages
        {...defaultProps({ messages, isEmpty: false, onAddComment })}
      />
    );

    const response = container.querySelector(
      '[data-local-chat-assistant-item-id="assistant-item-42"]'
    ) as HTMLElement;
    expect(response).toHaveAttribute(
      "data-local-chat-assistant-response-id",
      "assistant-item-42"
    );
    const textNode = response.querySelector("p")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 10);
    range.setEnd(textNode, 19);
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => ({ bottom: 24, left: 32 }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.mouseUp(screen.getByTestId("chat-messages-scroll"));
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Comment on selected text" }),
      {
        target: { value: "Please explain this wording." },
      }
    );
    fireEvent.click(screen.getByTestId("local-chat-save-comment"));

    expect(onAddComment).toHaveBeenCalledWith(
      {
        responseId: "assistant-item-42",
        itemId: "assistant-item-42",
        quote: "carefully",
        contextBefore: "Read this ",
        contextAfter: ", then update the parser.",
      },
      "Please explain this wording."
    );
    selection?.removeAllRanges();
  });

  /*
   * Ticket 0de6bdc7: the card is placed from its measured height, so a
   * draft that grows the textarea and a shrinking window both re-place it
   * inside the window. jsdom has no layout, so the selection, the card and
   * its textarea get geometry: the card is 150px of chrome plus the
   * textarea, whose content is 64px plus 20px per extra line.
   */
  it("keeps the comment card inside the window as its draft grows and the window shrinks", async () => {
    const lineRect = new DOMRect(100, 540, 120, 20);
    const rangeProto = Range.prototype as Partial<Range>;
    const { getClientRects, getBoundingClientRect } = rangeProto;
    rangeProto.getClientRects = () => [lineRect] as unknown as DOMRectList;
    rangeProto.getBoundingClientRect = () => lineRect;
    const observers: ResizeObserverCallback[] = [];
    const OriginalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const setViewport = (width: number, height: number) => {
      Object.defineProperty(window, "innerWidth", {
        value: width,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: height,
        configurable: true,
      });
    };
    const originalViewport = [window.innerWidth, window.innerHeight] as const;
    setViewport(1000, 600);

    const isCard = (el: Element) => el.classList.contains("chat-comment-card");
    const textareaContent = (el: Element) =>
      64 + 20 * ((el as HTMLTextAreaElement).value.split("\n").length - 1);
    const naturalCardHeight = (card: Element) => {
      const textarea = card.querySelector("textarea")!;
      return 150 + (parseFloat(textarea.style.height) || 64);
    };
    const shownHeight = (el: Element) => {
      if (el instanceof HTMLTextAreaElement)
        return parseFloat(el.style.height) || 64;
      if (!isCard(el)) return 0;
      const max = parseFloat((el as HTMLElement).style.maxHeight);
      return Math.min(naturalCardHeight(el), max || Infinity);
    };
    const spies = [
      vi
        .spyOn(HTMLElement.prototype, "offsetHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return shownHeight(this);
        }),
      vi
        .spyOn(Element.prototype, "clientHeight", "get")
        .mockImplementation(function (this: Element) {
          return shownHeight(this);
        }),
      vi
        .spyOn(Element.prototype, "scrollHeight", "get")
        .mockImplementation(function (this: Element) {
          if (this instanceof HTMLTextAreaElement) return textareaContent(this);
          return isCard(this) ? naturalCardHeight(this) : 0;
        }),
      vi
        .spyOn(HTMLElement.prototype, "offsetWidth", "get")
        .mockImplementation(function (this: HTMLElement) {
          return isCard(this) ? 384 : 0;
        }),
    ];

    try {
      const messages: ChatMessage[] = [
        {
          kind: "assistant",
          itemId: "assistant-item-9",
          text: "The last line of a long transcript.",
          timestamp: "2024-01-01T12:00:01Z",
        },
      ];
      const { container } = render(
        <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
      );
      const textNode = container.querySelector(
        '[data-local-chat-assistant-item-id="assistant-item-9"] p'
      )?.firstChild as Text;
      const range = document.createRange();
      range.setStart(textNode, 4);
      range.setEnd(textNode, 8);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      fireEvent(document, new Event("selectionchange"));
      fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

      const draft = screen.getByRole("textbox", {
        name: "Comment on selected text",
      });
      expect(draft).toHaveFocus();
      const card = draft.closest(".chat-comment-card") as HTMLElement;
      const expectInsideWindow = () => {
        const top = parseFloat(card.style.top);
        expect(top).toBeGreaterThanOrEqual(8);
        expect(top + card.offsetHeight).toBeLessThanOrEqual(
          window.innerHeight - 8
        );
      };

      // 214px does not fit in the 26px below the selection: it opens above.
      expect(card).toHaveAttribute("data-placement", "above");
      expect(card.style.top).toBe(`${534 - 214}px`);
      expectInsideWindow();

      // Five more lines grow the card to 314px; it moves up to stay clear.
      fireEvent.change(draft, { target: { value: "a\nb\nc\nd\ne\nf" } });
      expect(draft.style.height).toBe("164px");
      act(() =>
        observers.forEach((notify) => notify([], {} as ResizeObserver))
      );
      expect(card.style.top).toBe(`${534 - 314}px`);
      expectInsideWindow();

      // A window shorter than the card caps it at the inset window.
      setViewport(1000, 250);
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
      expect(card.style.maxHeight).toBe("234px");
      expect(card.style.top).toBe("8px");
      expectInsideWindow();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      rangeProto.getClientRects = getClientRects;
      rangeProto.getBoundingClientRect = getBoundingClientRect;
      globalThis.ResizeObserver = OriginalResizeObserver;
      setViewport(...originalViewport);
      window.getSelection()?.removeAllRanges();
    }
  });

  it("offers the comment pill only once a pointer selection is finished, and adds with Cmd+Return", async () => {
    const onAddComment = vi.fn();
    const messages: ChatMessage[] = [
      {
        kind: "assistant",
        itemId: "assistant-item-7",
        text: "Read this carefully, then update the parser.",
        timestamp: "2024-01-01T12:00:01Z",
      },
    ];
    const { container } = render(
      <ChatMessages
        {...defaultProps({ messages, isEmpty: false, onAddComment })}
      />
    );
    const textNode = container.querySelector(
      '[data-local-chat-assistant-item-id="assistant-item-7"] p'
    )?.firstChild as Text;
    const transcript = screen.getByTestId("chat-messages-scroll");

    fireEvent.pointerDown(textNode.parentElement!, { button: 0 });
    const range = document.createRange();
    range.setStart(textNode, 10);
    range.setEnd(textNode, 19);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    expect(
      screen.queryByRole("button", { name: "Add comment" })
    ).not.toBeInTheDocument();

    fireEvent.pointerUp(transcript, { button: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Add comment" }));
    const draft = screen.getByRole("textbox", {
      name: "Comment on selected text",
    });
    fireEvent.change(draft, { target: { value: "Why carefully?" } });
    fireEvent.keyDown(draft, { key: "Enter", metaKey: true });

    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({ quote: "carefully" }),
      "Why carefully?"
    );
    expect(
      screen.queryByRole("textbox", { name: "Comment on selected text" })
    ).not.toBeInTheDocument();
    selection?.removeAllRanges();
  });

  /*
   * The comment pill never appears under a pointer that is still selecting
   * (ticket 3845ab6b). Model: a press inside the transcript hides it until
   * release; outside a press, it shows exactly when the selection is
   * non-empty assistant text. Keyboard selection needs no pointer.
   */
  it("shows the comment pill exactly when an unpressed selection is assistant text", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      hegel.test(
        (tc) => {
          const messages: ChatMessage[] = [
            {
              kind: "user",
              text: "A user phrase.",
              timestamp: "2024-01-01T12:00:00Z",
            },
            {
              kind: "assistant",
              itemId: "a1",
              text: "Read this carefully, then update the parser.",
              timestamp: "2024-01-01T12:00:01Z",
            },
          ];
          const view = render(
            <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
          );
          const assistant = view.container.querySelector(
            '[data-local-chat-assistant-item-id="a1"] p'
          )!.firstChild as Text;
          const user = view.container.querySelector(".evrow--user p")!
            .firstChild as Text;
          const transcript = screen.getByTestId("chat-messages-scroll");
          const selection = window.getSelection()!;
          let pressed = false;
          let selected: "none" | "assistant" | "user" = "none";
          let shown = false;
          try {
            const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 20 }));
            for (let step = 0; step < steps; step++) {
              const action = tc.draw(
                gs.sampledFrom(["down", "up", "select", "clear"])
              );
              if (action === "down") {
                const inside = tc.draw(gs.booleans());
                const button = tc.draw(gs.sampledFrom([0, 2]));
                fireEvent.pointerDown(
                  inside ? assistant.parentElement! : document.body,
                  { button }
                );
                if (inside && button === 0) {
                  pressed = true;
                  shown = false;
                }
              }
              if (action === "up") {
                fireEvent.pointerUp(transcript, { button: 0 });
                act(() => {
                  vi.runOnlyPendingTimers();
                });
                if (pressed) shown = selected === "assistant";
                pressed = false;
              }
              if (action === "select") {
                selected = tc.draw(gs.sampledFrom(["assistant", "user"]));
                const node = selected === "assistant" ? assistant : user;
                const start = tc.draw(
                  gs.integers({ minValue: 0, maxValue: node.length - 2 })
                );
                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, node.length);
                selection.removeAllRanges();
                selection.addRange(range);
                // Whitespace-only selections are not comments.
                if (!range.toString().trim()) selected = "none";
                fireEvent(document, new Event("selectionchange"));
                if (!pressed) shown = selected === "assistant";
              }
              if (action === "clear") {
                selection.removeAllRanges();
                selected = "none";
                fireEvent(document, new Event("selectionchange"));
                if (!pressed) shown = false;
              }
              expect(
                screen.queryByRole("button", { name: "Add comment" }) !== null
              ).toBe(shown);
            }
          } finally {
            selection.removeAllRanges();
            view.unmount();
          }
        },
        { testCases: 80 }
      );
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("does not offer comments for a selected user message", () => {
    const messages: ChatMessage[] = [
      {
        kind: "user",
        text: "A user phrase.",
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];
    const { container } = render(
      <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
    );
    const textNode = container.querySelector(".evrow--user p")
      ?.firstChild as Text;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent(document, new Event("selectionchange"));
    expect(
      screen.queryByRole("button", { name: "Add comment" })
    ).not.toBeInTheDocument();
    selection?.removeAllRanges();
  });

  it("opens a task panel from an entity link in an assistant chat row", async () => {
    const user = userEvent.setup();
    const taskId = "03111754-4769-47c1-a64c-078d73554af8";
    const messages: ChatMessage[] = [
      {
        kind: "assistant",
        text: `See [the task](vtb://task/${taskId})`,
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];

    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);

    await user.click(screen.getByTestId("vtb-entity-link"));

    expect(useEntityPanelStore.getState().selection).toEqual({
      type: "task",
      taskId,
    });
  });

  it("renders the flat agent spawn marker without child-agent transcript prose", () => {
    const messages: ChatMessage[] = [
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent-1",
        input: JSON.stringify({ description: "Inspect repo" }),
        timestamp: "2024-01-01T12:00:00Z",
      },
      {
        kind: "assistant",
        text: "child-only prose",
        timestamp: "2024-01-01T12:00:01Z",
        parentToolUseId: "agent-1",
      },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    // The original spawn arguments remain accessible while child-thread prose
    // stays out of the parent transcript.
    fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
    fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
    expect(screen.getByLabelText("Raw arguments")).toHaveTextContent(
      "Inspect repo"
    );
    expect(screen.queryByText("child-only prose")).not.toBeInTheDocument();
  });

  it("renders permission request messages", () => {
    const messages: ChatMessage[] = [
      {
        kind: "permission_request",
        requestId: "req-1",
        toolName: "Bash",
        message: "Run command",
        input: undefined,
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];
    render(<ChatMessages {...defaultProps({ messages, isEmpty: false })} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Run command")).toBeInTheDocument();
    expect(screen.getByText("Permission required")).toBeInTheDocument();
  });

  it("preserves tool expansion when conversation segmentation remounts the row", () => {
    const tail = "PRESERVED-AFTER-REMOUNT";
    const largeResult = `${"large output line\n".repeat(800)}${tail}`;
    const toolMessages: ChatMessage[] = [
      {
        kind: "tool_call",
        toolName: "Read",
        toolId: "tool-stable",
        input: "{}",
        timestamp: "2024-01-01T12:00:01Z",
      },
      {
        kind: "tool_result",
        toolId: "tool-stable",
        result: largeResult,
        isError: false,
        timestamp: "2024-01-01T12:00:02Z",
      },
    ];
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({ messages: toolMessages, isEmpty: false })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
    fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
    expect(screen.getByText((text) => text.endsWith(tail))).toBeInTheDocument();

    rerender(
      <ChatMessages
        {...defaultProps({
          messages: [
            {
              kind: "user",
              text: "Before remount",
              timestamp: "2024-01-01T12:00:00Z",
            },
            {
              kind: "permission_request",
              requestId: "req-remount",
              toolName: "Bash",
              message: "Allow command?",
              input: undefined,
              timestamp: "2024-01-01T12:00:00Z",
            },
            ...toolMessages,
          ],
          isEmpty: false,
        })}
      />
    );

    expect(screen.getByText((text) => text.endsWith(tail))).toBeInTheDocument();
    expect(
      screen.queryByTestId("bounded-content-preview")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Raw arguments/ })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("renders a structured user question exactly once", () => {
    const questions = [
      {
        question: "Choose a target",
        header: "Target",
        options: [{ label: "Web", description: "Browser app" }],
        multi_select: false,
      },
    ];
    const messages: ChatMessage[] = [
      {
        kind: "user_question",
        requestId: "req-1",
        toolUseId: "tool-1",
        questions,
        originalQuestions: questions,
        status: "pending",
        timestamp: "2026-07-14T00:00:00Z",
      },
    ];
    render(
      <ChatMessages
        {...defaultProps({ messages, isEmpty: false, isActive: true })}
      />
    );
    expect(screen.getAllByText("Choose a target")).toHaveLength(1);
    expect(screen.getAllByText("Web")).toHaveLength(1);
  });

  // --- Thinking indicator ---

  it("shows ThinkingIndicator when isWaiting is true", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(
      <ChatMessages
        {...defaultProps({ messages, isEmpty: false, isWaiting: true })}
      />
    );
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("does not show ThinkingIndicator when isWaiting is false", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(
      <ChatMessages
        {...defaultProps({ messages, isEmpty: false, isWaiting: false })}
      />
    );
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("renders the configured futuristic indicator only during the waiting turn", () => {
    useUIStore.setState({ thinkingIndicatorStyle: "futuristic" });
    const { rerender } = render(
      <ChatMessages {...defaultProps({ isEmpty: false, isWaiting: true })} />
    );

    expect(screen.getByTestId("thinking-matrix")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(
      <ChatMessages {...defaultProps({ isEmpty: false, isWaiting: false })} />
    );
    expect(screen.queryByTestId("thinking-matrix")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a stopping label for a stopping active turn", () => {
    render(
      <ChatMessages
        {...defaultProps({
          isEmpty: false,
          isWaiting: true,
          activityLabel: "Stopping...",
        })}
      />
    );
    expect(screen.getByText("Stopping...")).toBeInTheDocument();
  });

  it("renders an accessible indeterminate compaction label in the activity area", () => {
    render(
      <ChatMessages
        {...defaultProps({
          isEmpty: false,
          isWaiting: true,
          activityLabel: "Compacting conversation…",
        })}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Compacting conversation…"
    );
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("uses a stable themed compaction phrase for the futuristic indicator", () => {
    useUIStore.setState({ thinkingIndicatorStyle: "futuristic" });
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const props = defaultProps({
      isEmpty: false,
      isWaiting: true,
      activityLabel: "Compacting conversation…",
    });
    const { rerender } = render(<ChatMessages {...props} />);
    const status = screen.getByRole("status");
    const phrase = status.textContent;

    expect(FUTURISTIC_COMPACTING_PHRASES).toContain(phrase);
    expect(phrase).not.toBe("Compacting conversation…");

    random.mockReturnValue(0.99);
    rerender(<ChatMessages {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent(phrase ?? "");
    random.mockRestore();
  });

  it("shows completion metadata without adding a transcript message", () => {
    render(
      <ChatMessages
        {...defaultProps({
          isEmpty: true,
          compactionSummary: { trigger: "auto", preTokens: 4096 },
        })}
      />
    );
    expect(screen.getByTestId("chat-compaction-summary")).toHaveTextContent(
      "Conversation compacted (auto) · 4,096 tokens before compaction"
    );
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  // --- Scroll-to-spawn event ---

  it("handles scroll-to-spawn events without crashing for non-existent spawn", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    render(
      <ChatMessages
        {...defaultProps({
          sessionId: "test-session",
          messages,
          isEmpty: false,
        })}
      />
    );

    // Since messageRefs is internal, we just verify the listener doesn't
    // crash when dispatching an event for a non-existent spawn.
    expect(() => {
      window.dispatchEvent(
        new CustomEvent("local-chat-scroll-to-spawn", {
          detail: { sessionId: "test-session", spawnId: "non-existent" },
        })
      );
    }).not.toThrow();
  });

  it("ignores scroll-to-spawn events for other sessions", () => {
    render(
      <ChatMessages
        {...defaultProps({
          sessionId: "test-session",
          isEmpty: false,
        })}
      />
    );

    // Clear calls from the initial mount auto-scroll effect
    vi.mocked(Element.prototype.scrollIntoView).mockClear();

    // Dispatch for a different session; should not trigger additional scrolls.
    window.dispatchEvent(
      new CustomEvent("local-chat-scroll-to-spawn", {
        detail: { sessionId: "other-session", spawnId: "some-spawn" },
      })
    );

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps historical rows mounted while repeated streaming deltas replace only the tail", () => {
    const messages: ChatMessage[] = [
      {
        kind: "assistant",
        text: "Finalized history",
        timestamp: "2024-01-01T12:00:00Z",
      },
    ];
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: {
            text: "First draft",
            timestamp: "2024-01-01T12:00:01Z",
          },
        })}
      />
    );
    const historicalRow = screen
      .getByText("Finalized history")
      .closest(".evrow--agent");

    expect(historicalRow).toBeInTheDocument();
    expect(screen.getByTestId("chat-streaming-tail")).toHaveTextContent(
      "First draft"
    );
    markdownRenderSpy.mockClear();

    rerender(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: {
            text: "Second draft",
            timestamp: "2024-01-01T12:00:01Z",
          },
        })}
      />
    );

    expect(screen.getByText("Finalized history").closest(".evrow--agent")).toBe(
      historicalRow
    );
    expect(screen.getAllByText("Finalized history")).toHaveLength(1);
    expect(
      markdownRenderSpy.mock.calls.filter(
        ([text]) => text === "Finalized history"
      )
    ).toHaveLength(0);
    expect(screen.queryByText("First draft")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-streaming-tail")).toHaveTextContent(
      "Second draft"
    );
  });

  it("replaces the streaming tail with exactly one finalized assistant row", () => {
    const history: ChatMessage[] = [
      { kind: "user", text: "Question", timestamp: "2024-01-01T12:00:00Z" },
    ];
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({
          messages: history,
          isEmpty: false,
          streamingAssistant: {
            text: "Complete answer",
            timestamp: "2024-01-01T12:00:01Z",
          },
        })}
      />
    );

    expect(screen.getByTestId("chat-streaming-tail")).toHaveTextContent(
      "Complete answer"
    );

    rerender(
      <ChatMessages
        {...defaultProps({
          messages: [
            ...history,
            {
              kind: "assistant",
              text: "Complete answer",
              timestamp: "2024-01-01T12:00:01Z",
              isPartial: false,
            },
          ],
          isEmpty: false,
          streamingAssistant: null,
        })}
      />
    );

    expect(screen.queryByTestId("chat-streaming-tail")).not.toBeInTheDocument();
    expect(screen.getAllByText("Complete answer")).toHaveLength(1);
    expect(document.querySelector(".ev-cursor")).not.toBeInTheDocument();
  });

  it("scrolls the message container instead of scrolling ancestors for streaming updates", () => {
    vi.useFakeTimers();

    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    const { rerender } = render(
      <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
    );
    const container = screen.getByTestId("chat-messages-scroll");
    const heightReads = vi.fn(() => 400);

    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: heightReads },
    });
    container.scrollTop = 300;
    fireEvent.scroll(container);
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    heightReads.mockClear();

    rerender(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: { text: "streaming", timestamp: "now" },
        })}
      />
    );

    act(() => vi.advanceTimersByTime(32));

    expect(container.scrollTop).toBe(1_000_000_000);
    expect(heightReads).not.toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 500,
    });
    rerender(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: { text: "streaming more", timestamp: "now" },
        })}
      />
    );

    act(() => vi.advanceTimersByTime(32));

    expect(container.scrollTop).toBe(1_000_000_000);
    expect(heightReads).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("does not steal the user's position when they scroll away from the bottom", () => {
    vi.useFakeTimers();

    const messages: ChatMessage[] = [
      { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
    ];
    const { rerender } = render(
      <ChatMessages {...defaultProps({ messages, isEmpty: false })} />
    );
    const container = screen.getByTestId("chat-messages-scroll");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    act(() => vi.advanceTimersByTime(32));

    fireEvent.wheel(container, { deltaY: -100 });
    container.scrollTop = 200;
    fireEvent.scroll(container);

    rerender(
      <ChatMessages
        {...defaultProps({
          messages,
          isEmpty: false,
          streamingAssistant: { text: "more", timestamp: "now" },
        })}
      />
    );

    act(() => vi.advanceTimersByTime(32));

    expect(container.scrollTop).toBe(200);

    vi.useRealTimers();
  });

  it("shows explicit initial and older-history loading states", () => {
    const onLoadOlderMessages = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({
          isLoadingInitialHistory: true,
          onLoadOlderMessages,
        })}
      />
    );
    expect(screen.getByText("Loading conversation history…")).toHaveAttribute(
      "role",
      "status"
    );
    expect(
      screen.queryByText("Create, edit, and delete tasks, steps, and workflows")
    ).not.toBeInTheDocument();

    rerender(
      <ChatMessages
        {...defaultProps({
          hasOlderMessages: true,
          isLoadingOlderMessages: true,
          onLoadOlderMessages,
        })}
      />
    );
    expect(screen.getByText("Loading older messages…")).toHaveAttribute(
      "role",
      "status"
    );
    expect(
      screen.queryByRole("button", { name: "Load older messages" })
    ).not.toBeInTheDocument();
  });

  it.each([
    { replayError: "History failed" },
    { isLoadingOlderMessages: true },
    { isLoadingInitialHistory: true },
    { isVisible: false },
    { hasOlderMessages: false },
  ])("does not automatically load unavailable history: %j", (overrides) => {
    const onLoadOlderMessages = vi.fn().mockResolvedValue(false);
    render(
      <ChatMessages
        {...defaultProps({
          hasOlderMessages: true,
          onLoadOlderMessages,
          ...overrides,
        })}
      />
    );
    fireEvent.wheel(screen.getByTestId("chat-messages-scroll"), {
      deltaY: -100,
    });
    expect(onLoadOlderMessages).not.toHaveBeenCalled();
  });

  it("loads once near the boundary on upward wheel input even without overflow", async () => {
    let resolveLoad: ((applied: boolean) => void) | undefined;
    const onLoadOlderMessages = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = resolve;
        })
    );
    render(
      <ChatMessages
        {...defaultProps({ hasOlderMessages: true, onLoadOlderMessages })}
      />
    );
    const container = screen.getByTestId("chat-messages-scroll");
    fireEvent.wheel(container, { deltaY: 100 });
    expect(onLoadOlderMessages).not.toHaveBeenCalled();
    container.scrollTop = 250;
    fireEvent.wheel(container, { deltaY: -100 });
    expect(onLoadOlderMessages).not.toHaveBeenCalled();
    container.scrollTop = 200;
    fireEvent.wheel(container, { deltaY: -100 });
    fireEvent.wheel(container, { deltaY: -100 });
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
    await act(async () => resolveLoad?.(false));
    fireEvent.wheel(container, { deltaY: -100 });
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(2);
    await act(async () => resolveLoad?.(false));
  });

  it("preserves the visible scroll anchor when older messages are prepended", async () => {
    let resolveLoad: ((applied: boolean) => void) | undefined;
    const onLoadOlderMessages = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const newest: ChatMessage[] = [
      { kind: "assistant", text: "Newest", timestamp: "2024-01-01T00:00:02Z" },
    ];
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({
          messages: newest,
          isEmpty: false,
          hasOlderMessages: true,
          onLoadOlderMessages,
        })}
      />
    );
    const container = screen.getByTestId("chat-messages-scroll");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    });
    container.scrollTop = 300;
    fireEvent.scroll(container);
    container.scrollTop = 150;
    fireEvent.scroll(container);
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 650,
    });
    rerender(
      <ChatMessages
        {...defaultProps({
          messages: [
            { kind: "user", text: "Older", timestamp: "2024-01-01T00:00:01Z" },
            ...newest,
          ],
          isEmpty: false,
          onLoadOlderMessages,
        })}
      />
    );

    expect(container.scrollTop).toBe(400);
    await act(async () => resolveLoad?.(true));
  });

  it("keeps the prepend anchor through an intervening live message", async () => {
    let resolveLoad: ((applied: boolean) => void) | undefined;
    const onLoadOlderMessages = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const newest: ChatMessage = {
      kind: "assistant",
      text: "Newest",
      timestamp: "2024-01-01T00:00:02Z",
    };
    const live: ChatMessage = {
      kind: "assistant",
      text: "Arrived live",
      timestamp: "2024-01-01T00:00:03Z",
    };
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({
          messages: [newest],
          isEmpty: false,
          hasOlderMessages: true,
          onLoadOlderMessages,
        })}
      />
    );
    const container = screen.getByTestId("chat-messages-scroll");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    });
    container.scrollTop = 300;
    fireEvent.scroll(container);
    container.scrollTop = 150;
    fireEvent.scroll(container);

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 450,
    });
    rerender(
      <ChatMessages
        {...defaultProps({
          messages: [newest, live],
          isEmpty: false,
          hasOlderMessages: true,
          isLoadingOlderMessages: true,
          onLoadOlderMessages,
        })}
      />
    );
    expect(container.scrollTop).toBe(150);

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 650,
    });
    rerender(
      <ChatMessages
        {...defaultProps({
          messages: [
            {
              kind: "user",
              text: "Older",
              timestamp: "2024-01-01T00:00:01Z",
            },
            newest,
            live,
          ],
          isEmpty: false,
          onLoadOlderMessages,
        })}
      />
    );

    expect(container.scrollTop).toBe(350);
    await act(async () => resolveLoad?.(true));
  });

  it("anchors a prepend to manual scrolling while the page is loading", async () => {
    let resolveLoad: ((applied: boolean) => void) | undefined;
    const onLoadOlderMessages = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const newest: ChatMessage[] = [
      { kind: "assistant", text: "Newest", timestamp: "2024-01-01T00:00:02Z" },
    ];
    const { rerender } = render(
      <ChatMessages
        {...defaultProps({
          messages: newest,
          isEmpty: false,
          hasOlderMessages: true,
          onLoadOlderMessages,
        })}
      />
    );
    const container = screen.getByTestId("chat-messages-scroll");
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    });
    container.scrollTop = 300;
    fireEvent.scroll(container);
    container.scrollTop = 150;
    fireEvent.scroll(container);

    rerender(
      <ChatMessages
        {...defaultProps({
          messages: newest,
          isEmpty: false,
          hasOlderMessages: true,
          isLoadingOlderMessages: true,
          onLoadOlderMessages,
        })}
      />
    );
    container.scrollTop = 220;
    fireEvent.scroll(container);

    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 600,
    });
    rerender(
      <ChatMessages
        {...defaultProps({
          messages: [
            { kind: "user", text: "Older", timestamp: "2024-01-01T00:00:01Z" },
            ...newest,
          ],
          isEmpty: false,
          onLoadOlderMessages,
        })}
      />
    );

    expect(container.scrollTop).toBe(420);
    await act(async () => resolveLoad?.(true));
  });
});

it("retries failed history preparation for the displayed session", () => {
  const retry = vi
    .spyOn(useChatStore.getState(), "refreshProviderThreadSession")
    .mockImplementation(() => {});

  try {
    render(
      <ChatMessages
        {...defaultProps({ replayError: "History preparation failed" })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(retry).toHaveBeenCalledExactlyOnceWith("test-session");
  } finally {
    retry.mockRestore();
  }
});
