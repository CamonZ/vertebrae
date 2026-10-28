import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { commands, type LocalChatAnnotation } from "../bindings";
import { useToolAnnotation } from "../hooks/useToolAnnotation";
import { routeLocalChatAnnotationEvent } from "../hooks/useLocalChatEventRouter";
import {
  clearPersistedLocalChatSessions,
  persistLocalChatSession,
} from "../utils/localChatPersistence";
import { resetProjectScopedStores } from "./projectScopedStores";
import { useChatStore } from "./chatStore";
import { mergeToolAnnotations, toolAnnotationEntries } from "./toolAnnotations";

type LoadResult = Awaited<ReturnType<typeof commands.loadLocalChatAnnotations>>;

function annotation(
  sessionId: string,
  toolId: string,
  kind: string,
  payload: LocalChatAnnotation["payload"] = {}
): LocalChatAnnotation {
  return {
    session_id: sessionId,
    tool_id: toolId,
    kind,
    payload,
    recorded_at: "2026-10-28T00:00:00Z",
  };
}

function replayEvent(sequence: number, type: string, data: object): string {
  return JSON.stringify({
    version: 1,
    event_id: `event-${sequence}`,
    stream_id: "local-replay/session",
    sequence,
    correlation: { session_id: "conv-1", thread_id: "conv-1" },
    timestamp: `2026-01-01T00:00:0${sequence}Z`,
    semantics: "snapshot",
    type,
    data,
  });
}

function deferredLoad() {
  let resolve!: (result: LoadResult) => void;
  const promise = new Promise<LoadResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Persist a session with a provider transcript so opening it replays. */
function persistSession(id: string) {
  persistLocalChatSession({
    id,
    label: "Persisted",
    messages: [],
    hasUserMessage: true,
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: "conv-1",
    projectPath: "/repo",
  });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("tool annotation helpers", () => {
  it("resolve a repeated tool id and kind to the last entry", () => {
    const first = annotation("chat-1", "tool-1", "worktree_delta", { v: 1 });
    const other = annotation("chat-1", "tool-1", "future_kind", { v: 2 });
    const latest = annotation("chat-1", "tool-1", "worktree_delta", { v: 3 });

    const merged = mergeToolAnnotations("chat-1", undefined, [
      first,
      other,
      latest,
    ]);

    expect(merged).toEqual({
      "tool-1": { worktree_delta: latest, future_kind: other },
    });
    expect(toolAnnotationEntries(merged)).toEqual([latest, other]);
  });

  it("ignore entries recorded for another session", () => {
    const foreign = annotation("chat-2", "tool-1", "worktree_delta");

    expect(mergeToolAnnotations("chat-1", undefined, [foreign])).toEqual({});
  });
});

describe("chat store tool annotations", () => {
  beforeEach(() => {
    localStorage.clear();
    clearPersistedLocalChatSessions();
    useChatStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads on open and joins annotations to replayed tool calls by tool id", async () => {
    persistSession("chat-1");
    const delta = annotation("chat-1", "toolu_1", "worktree_delta", {
      patch: "diff",
    });
    const load = vi
      .spyOn(commands, "loadLocalChatAnnotations")
      .mockResolvedValue({ status: "ok", data: [delta] });
    vi.spyOn(commands, "loadLocalChatSessionReplay").mockResolvedValue({
      status: "ok",
      data: {
        events: [
          replayEvent(1, "tool_call", {
            tool_call_id: "toolu_1",
            name: "Bash",
            input: { command: "pwd" },
          }),
        ],
        cache_key: "revision-1",
        next_cursor: null,
        has_more: false,
      },
    });

    await useChatStore.getState().selectPersistedSession("chat-1");
    await vi.waitFor(() =>
      expect(useChatStore.getState().sessions["chat-1"].messages).toHaveLength(
        1
      )
    );

    expect(load).toHaveBeenCalledWith("chat-1");
    const session = useChatStore.getState().sessions["chat-1"];
    const toolCall = session.messages[0];
    expect(toolCall.kind).toBe("tool_call");
    const toolId = toolCall.kind === "tool_call" ? toolCall.toolId : "";
    const { result } = renderHook(() =>
      useToolAnnotation("chat-1", toolId, "worktree_delta")
    );
    expect(result.current).toEqual(delta);
  });

  it("loads annotations even when provider replay fails", async () => {
    persistSession("chat-1");
    const delta = annotation("chat-1", "toolu_1", "worktree_delta");
    vi.spyOn(commands, "loadLocalChatAnnotations").mockResolvedValue({
      status: "ok",
      data: [delta],
    });
    vi.spyOn(commands, "loadLocalChatSessionReplay").mockResolvedValue({
      status: "error",
      error: { message: "transcript missing" },
    });

    await useChatStore.getState().selectPersistedSession("chat-1");

    await vi.waitFor(() =>
      expect(
        useChatStore.getState().sessions["chat-1"].toolAnnotations
      ).toEqual({ toolu_1: { worktree_delta: delta } })
    );
  });

  it("treats a failed load as no annotations and warns", async () => {
    persistSession("chat-1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(commands, "loadLocalChatAnnotations").mockResolvedValue({
      status: "error",
      error: { message: "disk unavailable" },
    });
    vi.spyOn(commands, "loadLocalChatSessionReplay").mockResolvedValue({
      status: "ok",
      data: { events: [], cache_key: null, next_cursor: null, has_more: false },
    });

    await useChatStore.getState().selectPersistedSession("chat-1");
    await flush();

    expect(
      useChatStore.getState().sessions["chat-1"].toolAnnotations
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Failed to load local chat annotations", {
      message: "disk unavailable",
    });
  });

  it("keeps live annotations that arrive while the load is in flight", async () => {
    persistSession("chat-1");
    vi.spyOn(commands, "loadLocalChatSessionReplay").mockResolvedValue({
      status: "ok",
      data: { events: [], cache_key: null, next_cursor: null, has_more: false },
    });
    const pending = deferredLoad();
    const load = vi
      .spyOn(commands, "loadLocalChatAnnotations")
      .mockReturnValue(pending.promise);
    await useChatStore.getState().selectPersistedSession("chat-1");
    await useChatStore.getState().selectPersistedSession("chat-1");
    expect(load).toHaveBeenCalledTimes(1);
    const stale = annotation("chat-1", "tool-1", "worktree_delta", {
      v: "file",
    });
    const live = annotation("chat-1", "tool-1", "worktree_delta", {
      v: "live",
    });
    const other = annotation("chat-1", "tool-2", "worktree_delta");

    expect(
      routeLocalChatAnnotationEvent({ session_id: "chat-1", annotation: live })
    ).toBe(true);
    pending.resolve({ status: "ok", data: [stale, other] });
    await flush();

    expect(useChatStore.getState().sessions["chat-1"].toolAnnotations).toEqual({
      "tool-1": { worktree_delta: live },
      "tool-2": { worktree_delta: other },
    });
  });

  it("drops a load result that arrives after its session was deleted or replaced", async () => {
    persistSession("chat-1");
    vi.spyOn(commands, "loadLocalChatSessionReplay").mockResolvedValue({
      status: "ok",
      data: { events: [], cache_key: null, next_cursor: null, has_more: false },
    });
    const deleted = deferredLoad();
    const replaced = deferredLoad();
    const current = deferredLoad();
    vi.spyOn(commands, "loadLocalChatAnnotations")
      .mockReturnValueOnce(deleted.promise)
      .mockReturnValueOnce(replaced.promise)
      .mockReturnValueOnce(current.promise);
    const deleteAnnotations = vi
      .spyOn(commands, "deleteLocalChatAnnotations")
      .mockResolvedValue({ status: "ok", data: null });

    await useChatStore.getState().selectPersistedSession("chat-1");
    useChatStore.getState().deleteLocalSession("chat-1");
    deleted.resolve({
      status: "ok",
      data: [annotation("chat-1", "tool-deleted", "worktree_delta")],
    });
    await flush();
    expect(useChatStore.getState().sessions["chat-1"]).toBeUndefined();
    expect(deleteAnnotations).toHaveBeenCalledWith("chat-1");

    persistSession("chat-1");
    await useChatStore.getState().selectPersistedSession("chat-1");
    useChatStore.getState().reset();
    persistSession("chat-1");
    await useChatStore.getState().selectPersistedSession("chat-1");
    replaced.resolve({
      status: "ok",
      data: [annotation("chat-1", "tool-replaced", "worktree_delta")],
    });
    await flush();
    expect(
      useChatStore.getState().sessions["chat-1"].toolAnnotations
    ).toBeUndefined();

    const fresh = annotation("chat-1", "tool-current", "worktree_delta");
    current.resolve({ status: "ok", data: [fresh] });
    await flush();
    expect(useChatStore.getState().sessions["chat-1"].toolAnnotations).toEqual({
      "tool-current": { worktree_delta: fresh },
    });
  });

  it("routes live annotations only into their own open session", () => {
    const first = useChatStore.getState().openSession("First");
    const second = useChatStore.getState().startFreshSession("Second");
    const entry = annotation(first, "tool-1", "worktree_delta");

    expect(
      routeLocalChatAnnotationEvent({ session_id: first, annotation: entry })
    ).toBe(true);
    expect(
      routeLocalChatAnnotationEvent({
        session_id: second,
        annotation: entry,
      })
    ).toBe(false);
    expect(
      routeLocalChatAnnotationEvent({
        session_id: "not-open",
        annotation: annotation("not-open", "tool-1", "worktree_delta"),
      })
    ).toBe(false);

    const sessions = useChatStore.getState().sessions;
    expect(sessions[first].toolAnnotations).toEqual({
      "tool-1": { worktree_delta: entry },
    });
    expect(sessions[second].toolAnnotations).toBeUndefined();
  });

  it("updates the selector live and clears annotations on project reset", () => {
    const id = useChatStore.getState().openSession("Live");
    const { result } = renderHook(() =>
      useToolAnnotation(id, "tool-1", "worktree_delta")
    );
    expect(result.current).toBeNull();
    const entry = annotation(id, "tool-1", "worktree_delta");

    act(() => {
      routeLocalChatAnnotationEvent({ session_id: id, annotation: entry });
    });
    expect(result.current).toEqual(entry);

    act(() => {
      resetProjectScopedStores();
    });
    expect(result.current).toBeNull();
    expect(useChatStore.getState().sessions).toEqual({});
  });
});
