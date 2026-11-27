import { describe, expect, it } from "vitest";
import {
  CHAT_HELP_SHORTCUT,
  CHANGES_HINT_GROUPS,
  matchesChatShortcut,
  DISCUSSION_ASK_SHORTCUT,
  DISCUSSION_COLLAPSE_SHORTCUT,
  DISCUSSION_SEND_SHORTCUT,
  presentChatShortcut,
  shortcutText,
} from "./chatShortcuts";

describe("chat-help shortcut metadata", () => {
  it("formats the configured binding with Apple modifier symbols", () => {
    expect(presentChatShortcut(CHAT_HELP_SHORTCUT, "MacIntel")).toEqual({
      keys: ["⌘", "⇧", "/"],
      ariaLabel: "Command Shift slash",
    });
  });

  it("formats the configured binding with non-Apple modifier names", () => {
    expect(presentChatShortcut(CHAT_HELP_SHORTCUT, "Linux x86_64")).toEqual({
      keys: ["Meta", "Shift", "/"],
      ariaLabel: "Meta Shift slash",
    });
  });

  it("matches every key representation accepted by the binding", () => {
    for (const key of CHAT_HELP_SHORTCUT.keys) {
      expect(
        matchesChatShortcut(
          { key, metaKey: true, shiftKey: true },
          CHAT_HELP_SHORTCUT
        )
      ).toBe(true);
    }
    expect(
      matchesChatShortcut(
        { key: "/", metaKey: false, shiftKey: true },
        CHAT_HELP_SHORTCUT
      )
    ).toBe(false);
  });

  it("returns no misleading hint when metadata is unavailable", () => {
    expect(presentChatShortcut(null, "MacIntel")).toBeNull();
  });
});

describe("CHANGES_HINT_GROUPS", () => {
  const pairs = (title: string) =>
    CHANGES_HINT_GROUPS.find((group) => group.title === title)!.hints.map(
      (hint) => [hint.keys.join(""), hint.label]
    );

  it("lists the discussion bindings on the line cursor and in a discussion", () => {
    const collapse = shortcutText(DISCUSSION_COLLAPSE_SHORTCUT);
    expect(pairs("Changes · line cursor")).toEqual(
      expect.arrayContaining([
        ["o", "Open discussion or GitHub thread at line"],
        [collapse, "Collapse or expand the discussion at line"],
      ])
    );
    expect(pairs("Changes · inline discussion")).toEqual([
      ["↵", "Open discussion (on its marker)"],
      [shortcutText(DISCUSSION_ASK_SHORTCUT), "Ask follow-up"],
      [shortcutText(DISCUSSION_SEND_SHORTCUT), "Send to main chat"],
      [collapse, "Collapse or expand earlier turns"],
      ["↵", "Show all turns (on “▸ N earlier turns”)"],
      ["Esc", "Close and return to line"],
    ]);
  });

  it("lists the expand bindings for collapsed lines", () => {
    expect(pairs("Changes · unchanged lines")).toEqual(
      expect.arrayContaining([
        ["↵", "Expand toward where you came from"],
        ["⌥↵", "Expand the other way"],
      ])
    );
  });
});
