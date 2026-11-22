import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatHeader } from "./ChatHeader";
import type {
  ChatAttention,
  ChatAttentionState,
} from "../../utils/chatAttention";

const attention = (
  state: ChatAttentionState,
  reason: string | null = null
): ChatAttention => ({ state, reason, since: null });

function renderHeader(overrides: Record<string, unknown> = {}) {
  const props = {
    label: "Test Chat",
    attention: { state: "idle", reason: null, since: null } as ChatAttention,
    isClosing: false,
    canStopGeneration: false,
    onClearMessages: vi.fn(),
    onStopGeneration: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ChatHeader {...props} />) };
}

function openPaneMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More pane actions" }));
}

function menuItem(name: string) {
  return screen.getByRole("menuitem", { name });
}

describe("ChatHeader", () => {
  it("hides project context for a single pane", () => {
    renderHeader({ projectLabel: "project" });
    expect(
      screen.queryByTestId("local-chat-project-context")
    ).not.toBeInTheDocument();
  });

  it("renders the session label", () => {
    renderHeader({ label: "My Project Chat" });
    expect(screen.getByText("My Project Chat")).toBeInTheDocument();
  });

  it("renders the project context after title controls with an accessible tooltip", () => {
    renderHeader({
      label: "My Project Chat",
      projectLabel: "a-very-long-project-name",
      showProjectContext: true,
      onTitleRegenerate: vi.fn(),
    });

    const titleButton = screen.getByRole("button", {
      name: "Rename chat: My Project Chat",
    });
    const projectContext = screen.getByRole("note", {
      name: "Project: a-very-long-project-name",
    });

    expect(
      titleButton.compareDocumentPosition(projectContext) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(projectContext).toHaveAttribute(
      "title",
      "Project: a-very-long-project-name"
    );
    expect(projectContext).toHaveClass("hc-project-context");
  });

  it("uses an accessible neutral fallback when project metadata is missing", () => {
    renderHeader({ showProjectContext: true });

    expect(
      screen.getByRole("note", { name: "Project: Unknown project" })
    ).toHaveTextContent("Unknown project");
  });

  it("enters title editing and saves a normalized title", async () => {
    const onTitleSave = vi.fn().mockResolvedValue(undefined);
    renderHeader({ label: "Old title", onTitleSave });

    fireEvent.click(
      screen.getByRole("button", { name: "Rename chat: Old title" })
    );
    const input = screen.getByRole("textbox", { name: "Chat title" });
    expect(input).toHaveValue("Old title");

    fireEvent.change(input, { target: { value: "  New   title  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onTitleSave).toHaveBeenCalledWith("New title"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Rename chat: Old title" })
      ).toHaveFocus()
    );
  });

  it("owns Esc while renaming and returns focus where renaming began", () => {
    renderHeader({ label: "Title", onTitleSave: vi.fn() });
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();

    fireEvent.click(screen.getByRole("button", { name: "Rename chat: Title" }));
    const input = screen.getByRole("textbox", { name: "Chat title" });
    // The chat panel's Esc-to-close leaves elements inside this alone.
    expect(input.closest("[data-owns-escape]")).not.toBeNull();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(composer).toHaveFocus();
    composer.remove();
  });

  it("cancels a title edit without changing the displayed title", () => {
    const onTitleSave = vi.fn();
    renderHeader({ label: "Keep this title", onTitleSave });

    fireEvent.click(
      screen.getByRole("button", { name: "Rename chat: Keep this title" })
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Chat title" }), {
      target: { value: "Discarded title" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Chat title" }), {
      key: "Escape",
    });

    expect(onTitleSave).not.toHaveBeenCalled();
    expect(screen.getByText("Keep this title")).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Chat title" })
    ).not.toBeInTheDocument();
  });

  it("rejects blank titles without losing the existing title", () => {
    const onTitleSave = vi.fn();
    renderHeader({ label: "Existing title", onTitleSave });

    fireEvent.click(
      screen.getByRole("button", { name: "Rename chat: Existing title" })
    );
    const input = screen.getByRole("textbox", { name: "Chat title" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save chat title" }));

    expect(onTitleSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Chat title cannot be empty."
    );
    expect(
      screen.getByRole("textbox", { name: "Chat title" })
    ).toBeInTheDocument();
  });

  it("shows and invokes the regenerate title control", () => {
    const onTitleRegenerate = vi.fn();
    renderHeader({ onTitleRegenerate });

    openPaneMenu();
    fireEvent.click(menuItem("Regenerate chat title"));

    expect(onTitleRegenerate).toHaveBeenCalledTimes(1);
  });

  it("disables title actions while regenerating", () => {
    renderHeader({
      onTitleSave: vi.fn(),
      onTitleRegenerate: vi.fn(),
      isTitleRegenerating: true,
    });

    expect(
      screen
        .getByRole("status", { name: "Regenerating chat title" })
        .querySelector("svg.animate-spin")
    ).toBeInTheDocument();
    openPaneMenu();
    expect(menuItem("Regenerating chat title")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Rename chat: Test Chat" })
    ).toBeDisabled();
  });

  // --- Status dots ---

  it("renders error as a flat err dot with its reason, never a glow", () => {
    renderHeader({ attention: attention("error") });
    const dot = screen.getByRole("img", { name: "Error" });
    expect(dot).toHaveAttribute("data-tone", "err");
    expect(dot.getAttribute("style")).toBeNull();
    expect(screen.getByTestId("chat-attention-reason")).toHaveTextContent(
      "Error"
    );
  });

  it("names blocked and needs-you reasons in the dot and as text", () => {
    const { rerender, props } = renderHeader({
      attention: attention("blocked", "Permission: Bash"),
    });
    expect(
      screen.getByRole("img", { name: "Blocked: Permission: Bash" })
    ).toHaveAttribute("data-tone", "accent");
    expect(screen.getByTestId("chat-attention-reason")).toHaveTextContent(
      "Permission: Bash"
    );
    rerender(
      <ChatHeader
        {...props}
        attention={attention("needs-you", "Asked you something")}
      />
    );
    expect(
      screen.getByRole("img", { name: "Needs you: Asked you something" })
    ).toHaveAttribute("data-tone", "accent");
  });

  it("shows running, your-turn and closed as dots without reason text", () => {
    for (const [state, tone] of [
      ["running", "ok"],
      ["your-turn", "mute"],
      ["closed", "hollow"],
    ] as const) {
      const { unmount } = renderHeader({ attention: attention(state) });
      expect(screen.getByTestId("chat-attention-dot")).toHaveAttribute(
        "data-tone",
        tone
      );
      expect(
        screen.queryByTestId("chat-attention-reason")
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it("draws no dot when idle", () => {
    renderHeader();
    expect(screen.queryByTestId("chat-attention-dot")).not.toBeInTheDocument();
  });

  // --- Always-visible actions ---

  it("renders the clear messages button and fires callback", () => {
    const onClearMessages = vi.fn();
    renderHeader({ onClearMessages });

    openPaneMenu();
    fireEvent.click(menuItem("Clear messages"));
    expect(onClearMessages).toHaveBeenCalledTimes(1);
  });

  it("renders the stop generation button with testid", () => {
    renderHeader();
    expect(
      screen.getByTestId("local-chat-stop-generation")
    ).toBeInTheDocument();
  });

  it("disables stop generation when canStopGeneration is false", () => {
    renderHeader({ canStopGeneration: false });
    expect(
      screen.getByRole("button", { name: "Stop generation" })
    ).toBeDisabled();
  });

  it("enables stop generation when canStopGeneration is true", () => {
    renderHeader({ canStopGeneration: true });
    expect(
      screen.getByRole("button", { name: "Stop generation" })
    ).not.toBeDisabled();
  });

  it("fires onStopGeneration when stop is clicked", () => {
    const onStopGeneration = vi.fn();
    renderHeader({ canStopGeneration: true, onStopGeneration });

    fireEvent.click(screen.getByRole("button", { name: "Stop generation" }));
    expect(onStopGeneration).toHaveBeenCalledTimes(1);
  });

  it("disables clear messages while closing", () => {
    renderHeader({ isClosing: true });
    openPaneMenu();
    expect(menuItem("Clear messages")).toBeDisabled();
  });

  // --- Conditional actions ---

  it("shows start fresh button when onStartFresh is provided", () => {
    const onStartFresh = vi.fn();
    renderHeader({ onStartFresh });

    openPaneMenu();
    fireEvent.click(menuItem("Start fresh local chat"));
    expect(onStartFresh).toHaveBeenCalledTimes(1);
  });

  it("hides start fresh button when onStartFresh is absent", () => {
    renderHeader();
    expect(
      screen.queryByRole("button", { name: "Start fresh local chat" })
    ).not.toBeInTheDocument();
  });

  it("shows chat history button when not wide", () => {
    const onToggleHistory = vi.fn();
    renderHeader({ onToggleHistory, isWide: false });

    openPaneMenu();
    fireEvent.click(menuItem("Toggle chat history"));
    expect(onToggleHistory).toHaveBeenCalledTimes(1);
  });

  it("hides chat history button when wide", () => {
    renderHeader({ onToggleHistory: vi.fn(), isWide: true });

    expect(
      screen.queryByRole("button", { name: "Toggle chat history" })
    ).not.toBeInTheDocument();
  });

  it("shows widen button with 'Widen' label when not wide", () => {
    const onToggleWide = vi.fn();
    renderHeader({ onToggleWide, isWide: false });

    const btn = screen.getByRole("button", { name: "Widen chat panel" });
    fireEvent.click(btn);
    expect(onToggleWide).toHaveBeenCalledTimes(1);
  });

  it("shows widen button with 'Collapse' label when wide", () => {
    const onToggleWide = vi.fn();
    renderHeader({ onToggleWide, isWide: true });

    expect(
      screen.getByRole("button", { name: "Collapse chat panel" })
    ).toBeInTheDocument();
  });

  it("shows split pane button when onSplitPane is provided and canSplitPane", () => {
    const onSplitPane = vi.fn();
    renderHeader({ onSplitPane, canSplitPane: true });

    openPaneMenu();
    fireEvent.click(menuItem("Split chat pane"));
    expect(onSplitPane).toHaveBeenCalledTimes(1);
  });

  it("disables split pane button when canSplitPane is false", () => {
    renderHeader({ onSplitPane: vi.fn(), canSplitPane: false });
    openPaneMenu();
    expect(menuItem("Split chat pane")).toBeDisabled();
  });

  it("shows unsplit panes button when onUnsplitPanes is provided", () => {
    const onUnsplitPanes = vi.fn();
    renderHeader({ onUnsplitPanes });

    openPaneMenu();
    fireEvent.click(menuItem("Keep only this pane"));
    expect(onUnsplitPanes).toHaveBeenCalledTimes(1);
  });

  it("shows close pane button when onClosePane is provided", () => {
    const onClosePane = vi.fn();
    renderHeader({ onClosePane });

    openPaneMenu();
    fireEvent.click(menuItem("Close this pane"));
    expect(onClosePane).toHaveBeenCalledTimes(1);
  });

  it("shows close panel button when onClosePanel is provided", () => {
    const onClosePanel = vi.fn();
    renderHeader({ onClosePanel });

    fireEvent.click(screen.getByRole("button", { name: "Close chat panel" }));
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("does not render any optional buttons when no callbacks are provided", () => {
    renderHeader();
    // Title, overflow trigger (holding clear), and stop are always-rendered.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3); // title + overflow + stop
  });

  // --- Mutation-killing tests: conditional visibility ---

  it("hides split pane button when onSplitPane is absent", () => {
    renderHeader();
    expect(
      screen.queryByRole("button", { name: "Split chat pane" })
    ).not.toBeInTheDocument();
  });

  it("hides unsplit panes button when onUnsplitPanes is absent", () => {
    renderHeader();
    expect(
      screen.queryByRole("button", { name: "Keep only this pane" })
    ).not.toBeInTheDocument();
  });

  it("hides close pane button when onClosePane is absent", () => {
    renderHeader();
    expect(
      screen.queryByRole("button", { name: "Close this pane" })
    ).not.toBeInTheDocument();
  });

  it("hides close panel button when onClosePanel is absent", () => {
    renderHeader();
    expect(
      screen.queryByRole("button", { name: "Close chat panel" })
    ).not.toBeInTheDocument();
  });

  it("renders all optional buttons when all callbacks are provided", () => {
    renderHeader({
      onStartFresh: vi.fn(),
      onToggleHistory: vi.fn(),
      onToggleWide: vi.fn(),
      onSplitPane: vi.fn(),
      onUnsplitPanes: vi.fn(),
      onClosePane: vi.fn(),
      onClosePanel: vi.fn(),
    });
    // Inline: title + widen + stop + overflow + close panel.
    expect(screen.getAllByRole("button")).toHaveLength(5);
    openPaneMenu();
    // Menu: start fresh, history, split, keep only, close pane, clear.
    expect(screen.getAllByRole("menuitem")).toHaveLength(6);
  });

  it("applies danger class to stop generation button", () => {
    renderHeader({ canStopGeneration: true });
    const stopBtn = screen.getByTestId("local-chat-stop-generation");
    expect(stopBtn.className).toContain("danger");
  });

  it("marks clear messages as a destructive menu item", () => {
    renderHeader();
    openPaneMenu();
    expect(menuItem("Clear messages").className).toContain("danger");
  });

  it("keeps changes and background inline while they are open or busy", () => {
    renderHeader({
      onToggleChanges: vi.fn(),
      changesOpen: true,
      onToggleBackground: vi.fn(),
      backgroundRunning: 2,
    });
    expect(screen.getByTestId("local-chat-view-changes")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(
      screen.getByRole("button", { name: "Background tasks, 2 running" })
    ).toBeInTheDocument();
  });

  it("moves idle changes and background toggles into the overflow menu", () => {
    const onToggleChanges = vi.fn();
    renderHeader({ onToggleChanges, onToggleBackground: vi.fn() });
    expect(screen.queryByTestId("local-chat-view-changes")).toBeNull();
    openPaneMenu();
    fireEvent.click(menuItem("Changes"));
    expect(onToggleChanges).toHaveBeenCalledTimes(1);
  });

  it("closes the overflow menu on Escape and returns focus to the trigger", () => {
    renderHeader({ onStartFresh: vi.fn() });
    openPaneMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.getByRole("button", { name: "More pane actions" })
    ).toHaveFocus();
  });
});
