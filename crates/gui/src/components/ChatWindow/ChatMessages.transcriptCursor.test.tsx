import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ChatMessages } from "./ChatMessages";
import type { ChatMessage } from "../../stores/chatStore";
import { focusPaneTranscript } from "./chatAreas";

Element.prototype.scrollIntoView = vi.fn();

const messages: ChatMessage[] = [
  {
    kind: "assistant",
    itemId: "assistant-item-9",
    text: "Read this carefully, then update the parser.",
    timestamp: "2024-01-01T12:00:01Z",
  },
];

function renderPane(
  onAddComment = vi.fn(),
  composerDisabled = false,
  pendingComment = false
) {
  const view = render(
    <div data-pane-id="pane-1">
      <ChatMessages
        sessionId="session-1"
        messages={messages}
        assistantLabel="Claude"
        isEmpty={false}
        isActive={false}
        isWaiting={false}
        streamingAssistant={null}
        onAddComment={onAddComment}
      />
      {pendingComment ? (
        <button type="button" className="chat-comment-chip" tabIndex={0}>
          1
        </button>
      ) : null}
      <textarea
        data-testid="local-chat-composer"
        aria-label="Message"
        disabled={composerDisabled}
      />
    </div>
  );
  const transcript = screen.getByTestId("chat-messages-scroll");
  const composer = screen.getByTestId("local-chat-composer");
  const text = view.container.querySelector(
    '[data-local-chat-assistant-item-id="assistant-item-9"] p'
  )?.firstChild as Text;
  return { transcript, composer, text, onAddComment };
}

const frame = () =>
  act(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  );

/** A keyboard selection of "carefully", as Shift+arrows would leave it. */
function selectCarefully(text: Text) {
  act(() => {
    window.getSelection()?.setBaseAndExtent(text, 10, text, 19);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
});

describe("ChatMessages transcript caret", () => {
  it("owns Esc and draws no focus ring while the caret is active", async () => {
    const { transcript, composer } = renderPane();
    act(() => transcript.focus());
    await frame();
    expect(transcript).toHaveAttribute("data-owns-escape");
    expect(transcript).toHaveAttribute("data-focus-halo", "none");

    act(() => composer.focus());
    expect(transcript).not.toHaveAttribute("data-owns-escape");
  });

  it("returns to the composer on Esc", async () => {
    const { transcript, composer } = renderPane();
    act(() => transcript.focus());
    await frame();
    fireEvent.keyDown(transcript, { key: "Escape" });
    expect(document.activeElement).toBe(composer);
  });

  it("leaves the transcript on Esc when the composer cannot take focus", async () => {
    const { transcript } = renderPane(vi.fn(), true);
    act(() => transcript.focus());
    await frame();
    fireEvent.keyDown(transcript, { key: "Escape" });
    expect(document.activeElement).not.toBe(transcript);
    expect(transcript).toHaveAttribute("data-transcript-cursor", "off");
  });

  it("is entered from the composer and left downwards with ⌘⌥↓", async () => {
    const { transcript, composer } = renderPane();
    act(() => composer.focus());
    act(() => void focusPaneTranscript(composer));
    await frame();
    expect(document.activeElement).toBe(transcript);
    expect(transcript).toHaveAttribute("data-transcript-cursor", "active");

    fireEvent.keyDown(transcript, {
      key: "ArrowDown",
      metaKey: true,
      altKey: true,
    });
    expect(document.activeElement).toBe(composer);
  });

  it("goes down to the pending comments before the composer", async () => {
    const { transcript } = renderPane(vi.fn(), false, true);
    act(() => transcript.focus());
    await frame();
    fireEvent.keyDown(transcript, {
      key: "ArrowDown",
      metaKey: true,
      altKey: true,
    });
    expect(document.activeElement).toHaveClass("chat-comment-chip");
  });

  it("starts the caret when entered after a click focused the transcript", async () => {
    const { transcript } = renderPane();
    fireEvent.pointerDown(transcript);
    act(() => transcript.focus());
    await frame();
    expect(transcript).toHaveAttribute("data-transcript-cursor", "off");

    act(() => void focusPaneTranscript(transcript));
    await frame();
    expect(transcript).toHaveAttribute("data-transcript-cursor", "active");
  });

  it("does not take over keys after a pointer press focuses the transcript", async () => {
    const { transcript } = renderPane();
    fireEvent.pointerDown(transcript);
    act(() => transcript.focus());
    await frame();
    expect(transcript).toHaveAttribute("data-transcript-cursor", "off");
    expect(transcript).not.toHaveAttribute("data-owns-escape");
  });

  it("opens the comment card from a keyboard selection and adds with Cmd+Return, back on the transcript", async () => {
    const { transcript, text, onAddComment } = renderPane();
    act(() => transcript.focus());
    await frame();
    selectCarefully(text);

    fireEvent.keyDown(transcript, { key: "Enter", metaKey: true });
    const draft = screen.getByRole("textbox", {
      name: "Comment on selected text",
    });
    expect(document.activeElement).toBe(draft);

    fireEvent.change(draft, { target: { value: "Why carefully?" } });
    fireEvent.keyDown(draft, { key: "Enter", metaKey: true });
    expect(onAddComment).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: "carefully",
        responseId: "assistant-item-9",
      }),
      "Why carefully?"
    );
    await frame();
    expect(document.activeElement).toBe(transcript);
    expect(transcript).toHaveAttribute("data-transcript-cursor", "active");
  });

  it("cancels the comment card with Esc and restores the selection and transcript focus", async () => {
    const { transcript, text, onAddComment } = renderPane();
    act(() => transcript.focus());
    await frame();
    selectCarefully(text);

    fireEvent.keyDown(transcript, { key: "Enter", metaKey: true });
    const draft = screen.getByRole("textbox", {
      name: "Comment on selected text",
    });
    fireEvent.keyDown(draft, { key: "Escape" });
    await frame();

    expect(
      screen.queryByRole("textbox", { name: "Comment on selected text" })
    ).not.toBeInTheDocument();
    expect(onAddComment).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(transcript);
    expect(window.getSelection()?.toString()).toBe("carefully");
  });

  it("cancels the comment card with Esc even when focus is elsewhere", async () => {
    const { transcript, text, onAddComment } = renderPane();
    act(() => transcript.focus());
    await frame();
    selectCarefully(text);

    fireEvent.keyDown(transcript, { key: "Enter", metaKey: true });
    const draft = screen.getByRole("textbox", {
      name: "Comment on selected text",
    });
    fireEvent.change(draft, { target: { value: "Half-written" } });
    act(() => draft.blur());
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(
      screen.queryByRole("textbox", { name: "Comment on selected text" })
    ).not.toBeInTheDocument();
    expect(onAddComment).not.toHaveBeenCalled();
  });

  it("keeps the panel's Esc handler out of it and attaches nothing", async () => {
    const { transcript, text, onAddComment } = renderPane();
    const panelEscape = vi.fn();
    window.addEventListener("keydown", panelEscape);
    act(() => transcript.focus());
    await frame();
    selectCarefully(text);
    fireEvent.keyDown(transcript, { key: "Enter", metaKey: true });
    const draft = screen.getByRole("textbox", {
      name: "Comment on selected text",
    });
    fireEvent.change(draft, { target: { value: "Keep this?" } });
    panelEscape.mockClear();
    fireEvent.keyDown(draft, { key: "Escape" });
    window.removeEventListener("keydown", panelEscape);

    // Bubbling listeners never see it: the card stops it at the document.
    expect(panelEscape).not.toHaveBeenCalled();
    expect(onAddComment).not.toHaveBeenCalled();
    expect(screen.queryByTestId("local-chat-pending-comment")).toBeNull();
  });

  it("does not raise the comment pill or card from mouse movement over a stale selection", () => {
    const { transcript, text } = renderPane();
    // A selection made earlier, outside any gesture the transcript saw.
    act(() => {
      window.getSelection()?.setBaseAndExtent(text, 10, text, 19);
    });
    fireEvent.mouseMove(transcript);
    fireEvent.pointerMove(transcript);
    document.dispatchEvent(new Event("selectionchange"));
    expect(screen.queryByTestId("local-chat-add-comment")).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: "Comment on selected text" })
    ).toBeNull();

    // A finished pointer selection does raise the pill.
    fireEvent.mouseUp(transcript);
    expect(screen.getByTestId("local-chat-add-comment")).toBeInTheDocument();
  });
});
