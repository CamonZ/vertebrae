import { describe, expect, it } from "vitest";
import {
  CHAT_HELP_SHORTCUT,
  matchesChatShortcut,
  presentChatShortcut,
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
