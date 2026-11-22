import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "vertebrae-chat-attention-viewed-v1";

async function freshStore() {
  vi.resetModules();
  return import("./chatAttentionStore");
}

beforeEach(() => localStorage.clear());

describe("chatAttentionStore", () => {
  it("keeps viewed markers across restarts and drops invalid ones", async () => {
    localStorage.setItem(KEY, JSON.stringify({ a: "k1", b: 7 }));
    const { useChatAttentionStore } = await freshStore();
    expect(useChatAttentionStore.getState().viewed).toEqual({ a: "k1" });
    useChatAttentionStore.getState().markTurnViewed("c", "k2");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ a: "k1", c: "k2" });
  });

  it("ignores corrupt storage", async () => {
    localStorage.setItem(KEY, "{not json");
    const { useChatAttentionStore } = await freshStore();
    expect(useChatAttentionStore.getState().viewed).toEqual({});
  });

  it("bounds saved markers, keeping the newest", async () => {
    const { useChatAttentionStore } = await freshStore();
    const { markTurnViewed } = useChatAttentionStore.getState();
    for (let i = 0; i < 520; i += 1) markTurnViewed(`s${i}`, "k");
    markTurnViewed("s0", "k-new");
    const saved = JSON.parse(localStorage.getItem(KEY)!) as Record<string, string>;
    expect(Object.keys(saved)).toHaveLength(512);
    expect(saved.s0).toBe("k-new");
    expect(saved.s1).toBeUndefined();
  });

  it("records decisions per turn and forgets them without losing viewed", async () => {
    const { useChatAttentionStore, chatAttentionRecord } = await freshStore();
    const store = useChatAttentionStore.getState();
    store.setTurnDecision("s1", "t1", "asking");
    store.setTurnDecision("s1", "t1", "needs_you");
    store.markTurnViewed("s1", "t1");
    expect(chatAttentionRecord(useChatAttentionStore.getState(), "s1")).toEqual({
      decisions: { t1: "needs_you" },
      viewedTurnKey: "t1",
    });
    store.forgetSession("s1");
    expect(chatAttentionRecord(useChatAttentionStore.getState(), "s1")).toEqual({
      decisions: {},
      viewedTurnKey: "t1",
    });
  });
});
