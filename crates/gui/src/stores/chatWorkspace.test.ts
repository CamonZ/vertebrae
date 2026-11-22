import { describe, expect, it } from "vitest";
import {
  activateByOffset,
  activateEntry,
  closeEntry,
  EMPTY_WORKSPACE,
  insertEntryAfterActive,
  moveEntry,
  moveEntryBefore,
  normalizeWorkspace,
  showTarget,
  type ChatPane,
  type ChatWorkspaceLayout,
} from "./chatWorkspace";

const chat = (n: number): ChatPane => ({ id: `e${n}`, sessionId: `s${n}` });

function workspace(
  count: number,
  layout: Partial<ChatWorkspaceLayout> = {}
): ChatWorkspaceLayout {
  const order = Array.from({ length: count }, (_, index) => chat(index + 1));
  return {
    ...EMPTY_WORKSPACE,
    order,
    activeId: order[0]?.id ?? null,
    ...layout,
  };
}

const ids = (layout: ChatWorkspaceLayout) =>
  layout.order.map((pane) => pane.id);

describe("activateEntry", () => {
  it("activates a tab, keeping the strip order", () => {
    const next = activateEntry(workspace(3), "e3");
    expect(next.activeId).toBe("e3");
    expect(ids(next)).toEqual(["e1", "e2", "e3"]);
  });

  it("ignores unknown and already active ids", () => {
    const layout = workspace(2);
    expect(activateEntry(layout, "missing")).toBe(layout);
    expect(activateEntry(layout, "e1")).toBe(layout);
  });
});

describe("activateByOffset", () => {
  it.each([
    ["e1", 1, "e2"],
    ["e3", 1, "e1"],
    ["e1", -1, "e3"],
  ])("from %s by %i wraps to %s", (from, offset, to) => {
    expect(
      activateByOffset(workspace(3, { activeId: from }), offset).activeId
    ).toBe(to);
  });
});

describe("insertEntryAfterActive", () => {
  it("opens the chat after the active one and activates it", () => {
    const next = insertEntryAfterActive(workspace(3), chat(9));
    expect(ids(next)).toEqual(["e1", "e9", "e2", "e3"]);
    expect(next.activeId).toBe("e9");
  });

  it("always adds a tab, however many are open", () => {
    const layout = workspace(30, { activeId: "e4" });
    const next = insertEntryAfterActive(layout, chat(99));
    expect(next.order).toHaveLength(31);
    expect(next.order[4]).toEqual({ id: "e99", sessionId: "s99" });
    expect(next.order.filter((pane) => pane.id !== "e99")).toEqual(
      layout.order
    );
    expect(next.activeId).toBe("e99");
  });
});

describe("showTarget", () => {
  it("activates the chat already showing the session", () => {
    const next = showTarget(workspace(3), { sessionId: "s3" }, "new");
    expect(next.activeId).toBe("e3");
    expect(next.order).toHaveLength(3);
  });

  it("replaces the active tab with a session that is not open", () => {
    const next = showTarget(
      workspace(2, { activeId: "e2" }),
      { sessionId: "s9" },
      "new"
    );
    expect(next.order[1]).toEqual({ id: "e2", sessionId: "s9" });
  });

  it("opens the first chat in an empty workspace", () => {
    const next = showTarget(EMPTY_WORKSPACE, { sessionId: "s1" }, "new");
    expect(next.order).toEqual([{ id: "new", sessionId: "s1" }]);
    expect(next.activeId).toBe("new");
  });
});

describe("closeEntry", () => {
  it("activates the chat to the right", () => {
    const next = closeEntry(workspace(3, { activeId: "e2" }), "e2");
    expect(ids(next)).toEqual(["e1", "e3"]);
    expect(next.activeId).toBe("e3");
  });

  it("activates the chat to the left when closing the last tab", () => {
    expect(closeEntry(workspace(3, { activeId: "e3" }), "e3").activeId).toBe(
      "e2"
    );
  });

  it("keeps the last open chat", () => {
    const layout = workspace(1);
    expect(closeEntry(layout, "e1")).toBe(layout);
  });

  it("keeps the active tab when closing another", () => {
    const next = closeEntry(workspace(3, { activeId: "e3" }), "e1");
    expect(ids(next)).toEqual(["e2", "e3"]);
    expect(next.activeId).toBe("e3");
  });
});

describe("moveEntry", () => {
  it("moves a chat in strip order without wrapping", () => {
    expect(ids(moveEntry(workspace(3), "e1", 1))).toEqual(["e2", "e1", "e3"]);
    const layout = workspace(3);
    expect(moveEntry(layout, "e1", -1)).toBe(layout);
  });

  it("drops a dragged chat in front of another, either direction", () => {
    expect(ids(moveEntryBefore(workspace(3), "e1", "e3"))).toEqual([
      "e2",
      "e1",
      "e3",
    ]);
    expect(ids(moveEntryBefore(workspace(3), "e3", "e1"))).toEqual([
      "e3",
      "e1",
      "e2",
    ]);
  });

  it("drops at the end for a null or unknown target", () => {
    expect(ids(moveEntryBefore(workspace(3), "e1", null))).toEqual([
      "e2",
      "e3",
      "e1",
    ]);
    expect(ids(moveEntryBefore(workspace(3), "e1", "gone"))).toEqual([
      "e2",
      "e3",
      "e1",
    ]);
  });

  it("leaves the layout when the chat lands where it is", () => {
    const layout = workspace(3);
    expect(moveEntryBefore(layout, "e1", "e2")).toBe(layout);
    expect(moveEntryBefore(layout, "e2", "e2")).toBe(layout);
    expect(moveEntryBefore(layout, "e3", null)).toBe(layout);
  });
});

describe("normalizeWorkspace", () => {
  it("drops rejected entries and repairs the active id", () => {
    const layout = workspace(3, { activeId: "e2" });
    const next = normalizeWorkspace(layout, (pane) => pane.id !== "e2");
    expect(ids(next)).toEqual(["e1", "e3"]);
    expect(next.activeId).toBe("e1");
  });

  it("returns the same layout when every entry is kept", () => {
    const layout = workspace(2);
    expect(normalizeWorkspace(layout, () => true)).toBe(layout);
  });
});
