import { CHANGES_HINT_GROUPS } from "./chatShortcuts";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatShortcutHints, CHAT_SHORTCUT_SECTIONS } from "./ChatShortcutHints";
import { TRANSCRIPT_HINTS } from "./chatShortcuts";

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

  it("renders the shortcut sections", () => {
    render(<ChatShortcutHints onClose={vi.fn()} />);
    expect(screen.getByText("Panel")).toBeInTheDocument();
    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("Previous file")).toBeInTheDocument();
    expect(screen.getByText("Chats")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });

  it("lists every transcript caret binding", () => {
    render(<ChatShortcutHints onClose={vi.fn()} />);
    const section = screen.getByText("Transcript").closest("section");
    expect(section).not.toBeNull();
    for (const { label } of TRANSCRIPT_HINTS) {
      expect(section).toHaveTextContent(label);
    }
  });

  it("renders kbd elements for shortcut keys", () => {
    const { container } = render(<ChatShortcutHints onClose={vi.fn()} />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds.length).toBeGreaterThan(0);
  });

  it("lists every inline discussion binding once, in its section or an earlier one", () => {
    render(<ChatShortcutHints onClose={vi.fn()} />);
    expect(screen.getByText("Open discussion or GitHub thread at line")).toBeInTheDocument();
    const section = screen
      .getByRole("heading", { name: "Changes · inline discussion" })
      .closest("section")!;
    const labels = [...section.querySelectorAll("dd")].map(
      (dd) => dd.textContent
    );
    // A binding an earlier Changes section already lists (the same keys and
    // label, as ⌘⇧↵ Send to main chat) is listed there, once.
    const index = CHANGES_HINT_GROUPS.findIndex(
      ({ title }) => title === "Changes · inline discussion"
    );
    const earlier = new Set(
      CHANGES_HINT_GROUPS.slice(0, index).flatMap(({ hints }) =>
        hints.map(({ keys, label }) => `${keys.join(" ")}:${label}`)
      )
    );
    expect(labels).toEqual(
      CHANGES_HINT_GROUPS[index].hints
        .filter(({ keys, label }) => !earlier.has(`${keys.join(" ")}:${label}`))
        .map(({ label }) => label)
    );
    expect(labels).not.toContain("Send to main chat");
    expect(screen.getByText("Send to main chat")).toBeInTheDocument();
  });

  it("renders known shortcut labels", () => {
    render(<ChatShortcutHints onClose={vi.fn()} />);
    expect(screen.getByText("Toggle chat")).toBeInTheDocument();
    expect(
      screen.getByText("Expand or collapse chat workspace")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Split/)).not.toBeInTheDocument();
    expect(screen.getByText("Next chat needing you")).toBeInTheDocument();
    expect(
      screen.getByText("Send or queue during an active turn")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Steer the active turn from the composer")
    ).toBeInTheDocument();
  });
});

describe("CHAT_SHORTCUT_SECTIONS", () => {
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
