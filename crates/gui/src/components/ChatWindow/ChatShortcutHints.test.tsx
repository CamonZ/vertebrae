import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatShortcutHints, CHAT_SHORTCUT_SECTIONS } from "./ChatShortcutHints";

describe("ChatShortcutHints", () => {
  it("renders a dialog with the correct aria-label", () => {
    render(<ChatShortcutHints onClose={vi.fn()} />);
    expect(
      screen.getByRole("dialog", { name: "Chat keyboard shortcuts" })
    ).toBeInTheDocument();
  });

  it("renders the 'Chat shortcuts' heading", () => {
    render(<ChatShortcutHints onClose={vi.fn()} />);
    expect(screen.getByText("Chat shortcuts")).toBeInTheDocument();
  });

  it("fires onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<ChatShortcutHints onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Close keyboard shortcuts" })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders all three shortcut sections", () => {
    render(<ChatShortcutHints onClose={vi.fn()} />);
    expect(screen.getByText("Panel")).toBeInTheDocument();
    expect(screen.getByText("Panes")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });

  it("renders kbd elements for shortcut keys", () => {
    const { container } = render(<ChatShortcutHints onClose={vi.fn()} />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds.length).toBeGreaterThan(0);
  });

  it("renders known shortcut labels", () => {
    render(<ChatShortcutHints onClose={vi.fn()} />);
    expect(screen.getByText("Toggle chat")).toBeInTheDocument();
    expect(screen.getByText("Split pane")).toBeInTheDocument();
    expect(screen.getByText("Send message")).toBeInTheDocument();
  });
});

describe("CHAT_SHORTCUT_SECTIONS", () => {
  it("has exactly three sections", () => {
    expect(CHAT_SHORTCUT_SECTIONS).toHaveLength(3);
  });

  it("each section has a title and at least one shortcut", () => {
    for (const section of CHAT_SHORTCUT_SECTIONS) {
      expect(section.title).toBeTruthy();
      expect(section.shortcuts.length).toBeGreaterThan(0);
      for (const shortcut of section.shortcuts) {
        expect(shortcut.keys.length).toBeGreaterThan(0);
        expect(shortcut.label).toBeTruthy();
      }
    }
  });

  it("first section is 'Panel'", () => {
    expect(CHAT_SHORTCUT_SECTIONS[0].title).toBe("Panel");
  });
});
