import { describe, expect, it } from "vitest";
import { chatAttentionText } from "../../utils/chatAttention";
import { presentChatShortcut, WORKSPACE_SHORTCUTS } from "./chatShortcuts";
import {
  chatNumberHint,
  chatTabLabel,
  chatTabTooltip,
  inlineTabs,
  runAttention,
  type ChatTabModel,
} from "./chatTabs";

const tab = (id: string, overrides: Partial<ChatTabModel> = {}) =>
  ({
    id,
    title: `Chat ${id}`,
    attention: { state: "idle", reason: null, since: null },
    isRun: false,
    project: null,
    ...overrides,
  }) satisfies ChatTabModel;

const prefix = presentChatShortcut(WORKSPACE_SHORTCUTS.chatByNumber)!
  .keys.slice(0, -1)
  .join("");

describe("chatNumberHint", () => {
  it("numbers the first eight chats", () => {
    expect(chatNumberHint(0, 3)).toBe(`${prefix}1`);
    expect(chatNumberHint(7, 12)).toBe(`${prefix}8`);
  });

  it("gives the last chat 9 once there are more than eight", () => {
    expect(chatNumberHint(11, 12)).toBe(`${prefix}9`);
    expect(chatNumberHint(8, 12)).toBeNull();
  });
});

describe("chatTabLabel and chatTabTooltip", () => {
  const blocked = tab("a", {
    title: "Fix login",
    attention: { state: "blocked", reason: "gate", since: null },
  });

  it("names the chat with its state and reason", () => {
    expect(chatTabLabel(blocked)).toBe(
      `Fix login, ${chatAttentionText(blocked.attention)}`
    );
  });

  it("marks runs as read-only", () => {
    expect(chatTabLabel(tab("r", { title: "Run", isRun: true }))).toMatch(
      /, run, read-only$/
    );
  });

  it("joins title, state and shortcut hint, skipping a missing hint", () => {
    const state = chatAttentionText(blocked.attention);
    expect(chatTabTooltip(blocked, "⌘⌥1")).toBe(`Fix login · ${state} · ⌘⌥1`);
    expect(chatTabTooltip(blocked, null)).toBe(`Fix login · ${state}`);
  });
});

describe("runAttention", () => {
  it("maps run statuses onto chat attention states", () => {
    expect(runAttention(undefined).state).toBe("idle");
    expect(runAttention("failed").state).toBe("error");
    expect(runAttention("executing").state).toBe("running");
    expect(runAttention("completed")).toEqual({
      state: "idle",
      reason: "completed",
      since: null,
    });
  });
});

describe("inlineTabs", () => {
  const tabs = ["a", "b", "c", "d", "e"].map((id) => tab(id));
  const shown = (activeId: string | null, capacity: number) =>
    inlineTabs(tabs, activeId, capacity).map((item) => item.id);

  it("keeps every tab when they fit", () => {
    expect(shown("a", 5)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps the leading tabs that fit", () => {
    expect(shown("b", 3)).toEqual(["a", "b", "c"]);
  });

  it("keeps an overflowed active tab inline in the last slot", () => {
    expect(shown("e", 3)).toEqual(["a", "b", "e"]);
  });

  it("always shows at least one tab", () => {
    expect(shown("d", 0)).toEqual(["d"]);
  });
});
