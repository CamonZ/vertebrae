import { describe, expect, it } from "vitest";
import {
  cycleSection,
  NO_CHANGES_MEMORY,
  openingSection,
  useChatSideColumnStore,
} from "./chatSideColumnStore";

const store = () => useChatSideColumnStore.getState();
const view = (sessionId: string) => store().bySession[sessionId];
const changesViewMemory = (sessionId: string, path: string) =>
  view(sessionId)?.changes[path] ?? null;

describe("chat side column store", () => {
  it("keeps each chat's open state and section apart", () => {
    store().show("a", "discussions");
    store().show("b", "background");
    store().close("b");

    expect(view("a")).toMatchObject({ open: true, section: "discussions" });
    expect(view("b")).toMatchObject({ open: false, section: "background" });
  });

  it("leaves the state object alone for no-op updates", () => {
    store().show("a", "changes");
    const before = store().bySession;

    store().show("a", "changes");
    store().close("missing");
    store().saveChanges("a", "/w", { activePath: null });
    store().saveChanges("a", "/w", () => ({ target: NO_CHANGES_MEMORY.target }));

    expect(store().bySession).toBe(before);
  });

  it("remembers Changes per checkout and forgets a chat entirely", () => {
    store().saveChanges("a", "/w", { activePath: "src/a.ts" });
    store().saveChanges("a", "/other", {
      cursor: { path: "b.ts", range: { start: 3, end: 4, side: "additions" } },
    });
    store().saveChanges("b", "/w", { activePath: "kept.ts" });

    expect(changesViewMemory("a", "/w")).toMatchObject({
      activePath: "src/a.ts",
      base: null,
      target: { kind: "working_tree" },
      cursor: null,
    });
    expect(changesViewMemory("a", "/other")?.cursor?.range.start).toBe(3);

    store().forget("a");

    expect(view("a")).toBeUndefined();
    expect(changesViewMemory("a", "/w")).toBeNull();
    expect(changesViewMemory("b", "/w")?.activePath).toBe("kept.ts");
  });

  it("cycles sections, wrapping both ways", () => {
    expect(cycleSection("changes", 1)).toBe("discussions");
    expect(cycleSection("background", 1)).toBe("changes");
    expect(cycleSection("changes", -1)).toBe("background");
    expect(cycleSection(null, 1)).toBe("changes");
    expect(cycleSection(null, -1)).toBe("background");
  });

  it("skips unavailable sections when cycling", () => {
    const noChanges = (section: string) => section !== "changes";
    expect(cycleSection("background", 1, noChanges)).toBe("discussions");
    expect(cycleSection("discussions", -1, noChanges)).toBe("background");
    expect(cycleSection(null, 1, noChanges)).toBe("discussions");
    expect(cycleSection("discussions", 1, () => false)).toBeNull();
  });

  it("opens on the last section, else the first with content", () => {
    const counts = { changes: 0, discussions: 2, background: 1 };

    expect(openingSection("background", counts)).toBe("background");
    expect(openingSection(null, counts)).toBe("discussions");
    expect(
      openingSection("changes", counts, (section) => section !== "changes")
    ).toBe("discussions");
    expect(
      openingSection(null, { changes: 0, discussions: 0, background: 0 })
    ).toBe("changes");
  });
});
