import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatHeader } from "./ChatHeader";

function renderHeader(overrides: Record<string, unknown> = {}) {
  const props = {
    label: "Test Chat",
    lifecycle: "idle" as const,
    isActive: false,
    isClosing: false,
    canStopGeneration: false,
    onClearMessages: vi.fn(),
    onStopGeneration: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ChatHeader {...props} />) };
}

describe("ChatHeader", () => {
  it("renders the session label", () => {
    renderHeader({ label: "My Project Chat" });
    expect(screen.getByText("My Project Chat")).toBeInTheDocument();
  });

  // --- Status dots ---

  it("renders the error dot when lifecycle is error", () => {
    renderHeader({ lifecycle: "error" });
    expect(screen.getByTestId("chat-error-dot")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-active-dot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-closed-dot")).not.toBeInTheDocument();
  });

  it("renders the active dot when isActive is true", () => {
    renderHeader({ isActive: true });
    expect(screen.getByTestId("chat-active-dot")).toBeInTheDocument();
  });

  it("renders the closed dot when lifecycle is closed", () => {
    renderHeader({ lifecycle: "closed" });
    expect(screen.getByTestId("chat-closed-dot")).toBeInTheDocument();
  });

  it("renders a neutral ember when idle and not active", () => {
    const { container } = renderHeader({ lifecycle: "idle", isActive: false });
    expect(container.querySelector(".em")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-error-dot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-active-dot")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-closed-dot")).not.toBeInTheDocument();
  });

  // --- Always-visible actions ---

  it("renders the clear messages button and fires callback", () => {
    const onClearMessages = vi.fn();
    renderHeader({ onClearMessages });

    const btn = screen.getByRole("button", { name: "Clear messages" });
    fireEvent.click(btn);
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
    expect(
      screen.getByRole("button", { name: "Clear messages" })
    ).toBeDisabled();
  });

  // --- Conditional actions ---

  it("shows start fresh button when onStartFresh is provided", () => {
    const onStartFresh = vi.fn();
    renderHeader({ onStartFresh });

    fireEvent.click(
      screen.getByRole("button", { name: "Start fresh local chat" })
    );
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

    fireEvent.click(screen.getByRole("button", { name: "Toggle chat history" }));
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

    const btn = screen.getByRole("button", { name: "Split chat pane" });
    fireEvent.click(btn);
    expect(onSplitPane).toHaveBeenCalledTimes(1);
  });

  it("disables split pane button when canSplitPane is false", () => {
    renderHeader({ onSplitPane: vi.fn(), canSplitPane: false });
    expect(
      screen.getByRole("button", { name: "Split chat pane" })
    ).toBeDisabled();
  });

  it("shows unsplit panes button when onUnsplitPanes is provided", () => {
    const onUnsplitPanes = vi.fn();
    renderHeader({ onUnsplitPanes });

    fireEvent.click(
      screen.getByRole("button", { name: "Keep only this pane" })
    );
    expect(onUnsplitPanes).toHaveBeenCalledTimes(1);
  });

  it("shows close pane button when onClosePane is provided", () => {
    const onClosePane = vi.fn();
    renderHeader({ onClosePane });

    fireEvent.click(screen.getByRole("button", { name: "Close this pane" }));
    expect(onClosePane).toHaveBeenCalledTimes(1);
  });

  it("shows close panel button when onClosePanel is provided", () => {
    const onClosePanel = vi.fn();
    renderHeader({ onClosePanel });

    fireEvent.click(
      screen.getByRole("button", { name: "Close chat panel" })
    );
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("does not render any optional buttons when no callbacks are provided", () => {
    renderHeader();
    // Only clear + stop are always-rendered.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2); // clear + stop
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
    const buttons = screen.getAllByRole("button");
    // 7 optional + 2 always (clear + stop) = 9
    expect(buttons).toHaveLength(9);
  });

  it("applies danger class to stop generation button", () => {
    renderHeader({ canStopGeneration: true });
    const stopBtn = screen.getByTestId("local-chat-stop-generation");
    expect(stopBtn.className).toContain("danger");
  });

  it("does not apply danger class to clear button", () => {
    renderHeader();
    const clearBtn = screen.getByRole("button", { name: "Clear messages" });
    expect(clearBtn.className).not.toContain("danger");
  });
});
