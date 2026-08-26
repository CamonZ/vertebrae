import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chatStore";
import {
  applyInitialPage,
  applyOlderPage,
  failReplay,
  initialProviderReplayState,
  isValidReplayPage,
  providerReplayErrorMessage,
  type ProviderReplayState,
} from "./providerReplay";

function replayWith(
  overrides: Partial<ProviderReplayState>
): ProviderReplayState {
  return {
    ...initialProviderReplayState(1),
    loading: null,
    ...overrides,
  };
}

const message = (text: string): ChatMessage => ({
  kind: "assistant",
  text,
  timestamp: "2026-01-01T00:00:00Z",
});

describe("isValidReplayPage", () => {
  it("accepts a well-formed page", () => {
    expect(
      isValidReplayPage({
        events: ["{}"],
        cache_key: "k1",
        next_cursor: "c1",
        has_more: true,
      })
    ).toBe(true);
  });

  it("accepts an empty page without a cursor", () => {
    expect(
      isValidReplayPage({
        events: [],
        cache_key: null,
        next_cursor: null,
        has_more: false,
      })
    ).toBe(true);
  });

  it("rejects events with a missing cache key", () => {
    expect(
      isValidReplayPage({
        events: ["{}"],
        cache_key: null,
        next_cursor: null,
        has_more: false,
      })
    ).toBe(false);
  });

  it("rejects has_more without a cursor or cache key", () => {
    expect(
      isValidReplayPage({
        events: [],
        cache_key: null,
        next_cursor: null,
        has_more: true,
      })
    ).toBe(false);
    expect(
      isValidReplayPage({
        events: [],
        cache_key: "k1",
        next_cursor: null,
        has_more: true,
      })
    ).toBe(false);
  });
});

describe("applyInitialPage", () => {
  it("installs the newest page and records paging state", () => {
    const next = applyInitialPage(
      initialProviderReplayState(1),
      {
        cacheKey: "k1",
        events: ["b", "c"],
        nextCursor: "c1",
        hasMore: true,
      },
      { messages: [message("b"), message("c")], installedMessageCount: 2 }
    );
    expect(next.loaded).toBe(true);
    expect(next.lines).toEqual(["b", "c"]);
    expect(next.nextCursor).toBe("c1");
    expect(next.seenCursors).toEqual(["c1"]);
    expect(next.installedMessages).toHaveLength(2);
  });

  it("a null cache key leaves the session unloaded but not errored", () => {
    const next = applyInitialPage(
      initialProviderReplayState(1),
      { cacheKey: null, events: [], nextCursor: null, hasMore: false },
      { messages: [], installedMessageCount: 0 }
    );
    expect(next.loaded).toBe(false);
    expect(next.error).toBeNull();
  });
});

describe("applyOlderPage", () => {
  const base = replayWith({
    loaded: true,
    cacheKey: "k1",
    lines: ["c"],
    nextCursor: "c1",
    hasMore: true,
    installedMessages: [message("c")],
    seenCursors: ["c1"],
  });

  it("prepends the page and tracks the next cursor", () => {
    const outcome = applyOlderPage(
      base,
      { cacheKey: "k1", events: ["a", "b"], nextCursor: "c2", hasMore: true },
      (lines) => lines.map((line) => message(line))
    );
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.replay.lines).toEqual(["a", "b", "c"]);
    expect(outcome.replay.seenCursors).toEqual(["c1", "c2"]);
    expect(outcome.messages.map((m) => m.kind === "assistant" && m.text)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("rejects a page from a different transcript revision", () => {
    const outcome = applyOlderPage(
      base,
      { cacheKey: "k2", events: ["a"], nextCursor: null, hasMore: false },
      (lines) => lines.map((line) => message(line))
    );
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.replay.hasMore).toBe(false);
    expect(outcome.replay.nextCursor).toBeNull();
    expect(outcome.replay.error).toContain("changed");
  });

  it("rejects a repeated cursor to stop paging loops", () => {
    const outcome = applyOlderPage(
      base,
      { cacheKey: "k1", events: ["a"], nextCursor: "c1", hasMore: true },
      (lines) => lines.map((line) => message(line))
    );
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.replay.error).toContain("repeated");
  });

  it("closing the transcript clears paging without error", () => {
    const outcome = applyOlderPage(
      base,
      { cacheKey: "k1", events: ["a"], nextCursor: null, hasMore: false },
      (lines) => lines.map((line) => message(line))
    );
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.replay.hasMore).toBe(false);
    expect(outcome.replay.error).toBeNull();
  });
});

describe("failReplay", () => {
  it("records the error and clears loading", () => {
    const next = failReplay(replayWith({ loading: "older" }), "boom");
    expect(next.loading).toBeNull();
    expect(next.error).toBe("boom");
  });
});

describe("providerReplayErrorMessage", () => {
  it("uses Error messages, object messages, and a fallback", () => {
    expect(providerReplayErrorMessage(new Error(" err "))).toBe(" err ");
    expect(providerReplayErrorMessage({ message: "obj" })).toBe("obj");
    expect(providerReplayErrorMessage({})).toContain("unavailable");
  });
});
