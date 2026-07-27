import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  type LocalChatSessionEndEvent,
  type LocalChatTextEvent,
  type LocalChatToolCallEvent,
  type LocalChatTurnStartedEvent,
} from "../bindings";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import translationSequence from "../test/fixtures/localChatTurnTranslation.json";
import {
  routeLocalChatSessionEndEvent,
  routeLocalChatSessionErrorEvent,
  routeLocalChatTextEvent,
  routeLocalChatToolCallEvent,
  routeLocalChatToolResultEvent,
  routeLocalChatTurnStartedEvent,
  routePermissionRequestEvent,
  resetLocalChatTurnRoutingForTests,
  useLocalChatEventRouter,
} from "./useLocalChatEventRouter";

const { listen, unlisteners } = vi.hoisted(() => {
  const unlisteners: Array<ReturnType<typeof vi.fn>> = [];
  const listen = vi.fn(() => {
    const unlisten = vi.fn();
    unlisteners.push(unlisten);
    return Promise.resolve(unlisten);
  });
  return { listen, unlisteners };
});

vi.mock("../bindings", () => {
  return {
    commands: {
      getCurrentProjectPath: vi.fn().mockResolvedValue({
        status: "ok",
        data: "/test/project",
      }),
      createLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
      inferLocalChatSessionTitle: vi.fn().mockResolvedValue({
        status: "ok",
        data: {
          title: "Inferred Title",
          confidence: 0.91,
          sufficient_signal: true,
        },
      }),
      sendLocalChatMessage: vi.fn().mockResolvedValue({ status: "ok" }),
      closeLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
    },
    events: {
      localChatSessionInitEvent: { listen },
      localChatTurnStartedEvent: { listen },
      localChatSessionUsageEvent: { listen },
      localChatTextEvent: { listen },
      localChatToolCallEvent: { listen },
      localChatToolResultEvent: { listen },
      permissionRequestEvent: { listen },
      localChatSessionEndEvent: { listen },
      localChatSessionErrorEvent: { listen },
      localChatSessionWarningEvent: { listen },
    },
  };
});

const mockedCommands = vi.mocked(commands);

function makeSession(overrides: Partial<ChatSession>): ChatSession {
  return {
    id: "session",
    label: "Hidden Session",
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    lifecycle: "idle",
    lifecycleError: null,
    streamingAssistant: null,
    ...overrides,
  };
}

function resetChatStore(sessions: Record<string, ChatSession>) {
  useChatStore.setState({
    sessions,
    activeSessionId: Object.keys(sessions)[0] ?? null,
    paneLayout: { panes: [], activePaneId: null },
    panelOpen: false,
    localSessionSummaries: {},
  });
}

function startTurn(
  backendSessionId: string,
  turnId: string,
  harness: "claude" | "codex" = "claude"
) {
  const sessionId = Object.values(useChatStore.getState().sessions).find(
    (session) => session.backendSessionId === backendSessionId
  )?.id;
  if (sessionId && !useChatStore.getState().sessions[sessionId].activeTurn) {
    useChatStore.getState().beginActiveTurn(sessionId);
  }
  expect(
    routeLocalChatTurnStartedEvent({
      backend_session_id: backendSessionId,
      harness,
      turn_id: turnId,
      thread_id: `${backendSessionId}-thread`,
      is_root: true,
    })
  ).toBe(true);
}

describe("useLocalChatEventRouter route functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlisteners.length = 0;
    resetLocalChatTurnRoutingForTests();
    localStorage.clear();
    resetChatStore({});
  });

  it("subscribes only once when the router is mounted multiple times in a webview", async () => {
    const first = renderHook(() => useLocalChatEventRouter());
    const second = renderHook(() => useLocalChatEventRouter());

    await waitFor(() => {
      expect(listen).toHaveBeenCalledTimes(10);
    });
    expect(unlisteners).toHaveLength(10);

    first.unmount();
    for (const unlisten of unlisteners) {
      expect(unlisten).not.toHaveBeenCalled();
    }

    second.unmount();
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("updates a hidden session transcript and lifecycle without a mounted pane", () => {
    resetChatStore({
      hidden: makeSession({
        id: "hidden",
        backendSessionId: "backend-hidden",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-hidden", "turn-hidden");

    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-hidden",
        harness: "claude",
        turn_id: "turn-hidden",
        thread_id: "backend-hidden-thread",
        is_root: true,
        text: "Final ",
        is_partial: true,
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-hidden",
        harness: "claude",
        turn_id: "turn-hidden",
        thread_id: "backend-hidden-thread",
        is_root: true,
        text: "answer",
        is_partial: true,
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-hidden",
        harness: "claude",
        turn_id: "turn-hidden",
        thread_id: "backend-hidden-thread",
        is_root: true,
        duration_ms: 100,
        cost_usd: 0,
        num_turns: 1,
        result: "ok",
        is_error: false,
        context_tokens: 12,
        context_window: 200000,
      })
    ).toBe(true);

    const hidden = useChatStore.getState().sessions.hidden;
    expect(hidden.lifecycle).toBe("idle");
    expect(hidden.streamingAssistant).toBeNull();
    expect(hidden.messages).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Final answer",
        isPartial: false,
      }),
    ]);
  });

  it("settles a Codex turn through the shared local-chat end event", () => {
    resetChatStore({
      codex: makeSession({
        id: "codex",
        harness: "codex",
        backendSessionId: "backend-codex",
        lifecycle: "streaming",
        streamingAssistant: {
          text: "Codex answer",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      }),
    });
    startTurn("backend-codex", "turn-codex", "codex");

    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-codex",
        harness: "codex",
        turn_id: "turn-codex",
        thread_id: "backend-codex-thread",
        is_root: true,
        duration_ms: 120,
        cost_usd: 0,
        num_turns: 1,
        result: "Codex answer",
        is_error: false,
        context_tokens: 12,
        context_window: 200,
      })
    ).toBe(true);

    const codex = useChatStore.getState().sessions.codex;
    expect(codex.lifecycle).toBe("idle");
    expect(codex.streamingAssistant).toBeNull();
    expect(codex.messages).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Codex answer",
        isPartial: false,
      }),
    ]);
  });

  it("keeps a turn active through snapshot text and later tool activity", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "root-turn");

    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "root-turn",
        thread_id: "root-thread",
        is_root: true,
        text: "I will inspect that.",
        is_partial: false,
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(
      routeLocalChatToolCallEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "root-turn",
        thread_id: "root-thread",
        is_root: true,
        tool_name: "Read",
        tool_id: "tool-1",
        input: '{"path":"src/main.ts"}',
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(
      routeLocalChatToolResultEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "root-turn",
        thread_id: "root-thread",
        is_root: true,
        tool_id: "tool-1",
        result: "file contents",
        is_error: false,
        parent_tool_use_id: null,
      })
    ).toBe(true);

    const active = useChatStore.getState().sessions.local;
    expect(active.lifecycle).toBe("streaming");
    expect(active.activeTurn).toMatchObject({
      turnId: "root-turn",
      phase: "active",
    });
    expect(active.messages.map((message) => message.kind)).toEqual([
      "assistant",
      "tool_call",
      "tool_result",
    ]);

    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "root-turn",
        thread_id: "root-thread",
        is_root: true,
        duration_ms: 10,
        cost_usd: 0,
        num_turns: 1,
        result: "done",
        is_error: false,
        context_tokens: 0,
        context_window: 200000,
      })
    ).toBe(true);
    expect(useChatStore.getState().sessions.local.activeTurn).toBeNull();
    expect(useChatStore.getState().sessions.local.lifecycle).toBe("idle");
  });

  it("flushes a queued follow-up when a hidden session receives End", async () => {
    resetChatStore({
      hidden: makeSession({
        id: "hidden",
        backendSessionId: "backend-hidden",
        lifecycle: "streaming",
        queuedMessages: ["queued follow-up"],
        messages: [
          {
            kind: "user",
            text: "queued follow-up",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    });
    startTurn("backend-hidden", "turn-queued");

    routeLocalChatSessionEndEvent({
      backend_session_id: "backend-hidden",
      harness: "claude",
      turn_id: "turn-queued",
      thread_id: "backend-hidden-thread",
      is_root: true,
      duration_ms: 100,
      cost_usd: 0,
      num_turns: 1,
      result: "ok",
      is_error: false,
      context_tokens: 12,
      context_window: 200000,
    });

    await waitFor(() => {
      expect(mockedCommands.sendLocalChatMessage).toHaveBeenCalledWith(
        "backend-hidden",
        "queued follow-up"
      );
    });
    const hidden = useChatStore.getState().sessions.hidden;
    expect(hidden.queuedMessages).toBeUndefined();
    expect(hidden.lifecycle).toBe("streaming");
    expect(
      hidden.messages.filter(
        (message) =>
          message.kind === "user" && message.text === "queued follow-up"
      )
    ).toHaveLength(1);
  });

  it("does not hand off queued work when End races a stopping turn", async () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
        queuedMessages: ["must not start"],
      }),
    });
    startTurn("backend-local", "turn-stopping");
    expect(useChatStore.getState().markActiveTurnStopping("local")).toBe(true);
    useChatStore.getState().setSessionLifecycle("local", "closing");

    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-stopping",
        thread_id: "backend-local-thread",
        is_root: true,
        duration_ms: 1,
        cost_usd: 0,
        num_turns: 1,
        result: "interrupted",
        is_error: false,
        context_tokens: 0,
        context_window: 200000,
      })
    ).toBe(true);
    await Promise.resolve();

    expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions.local).toMatchObject({
      activeTurn: null,
      lifecycle: "closing",
      queuedMessages: ["must not start"],
    });
  });

  it("routes interleaved multi-session events without transcript cross-talk", () => {
    resetChatStore({
      left: makeSession({
        id: "left",
        label: "Left",
        backendSessionId: "backend-left",
        lifecycle: "streaming",
      }),
      right: makeSession({
        id: "right",
        label: "Right",
        backendSessionId: "backend-right",
        lifecycle: "streaming",
      }),
    });

    routeLocalChatTextEvent({
      backend_session_id: "backend-left",
      harness: "claude",
      text: "left partial",
      is_partial: true,
      parent_tool_use_id: null,
    });
    routeLocalChatTextEvent({
      backend_session_id: "backend-right",
      harness: "claude",
      text: "right final",
      is_partial: false,
      parent_tool_use_id: null,
    });
    routeLocalChatToolResultEvent({
      backend_session_id: "backend-left",
      harness: "claude",
      tool_id: "tool-left",
      result: "left tool result",
      is_error: false,
      parent_tool_use_id: null,
    });
    routeLocalChatTextEvent({
      backend_session_id: "backend-left",
      harness: "claude",
      text: "left final",
      is_partial: false,
      parent_tool_use_id: null,
    });

    const { left, right } = useChatStore.getState().sessions;
    expect(left.messages).toEqual([
      expect.objectContaining({
        kind: "tool_result",
        toolId: "tool-left",
        result: "left tool result",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "left final",
      }),
    ]);
    expect(right.messages).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "right final",
      }),
    ]);
    expect(JSON.stringify(left.messages)).not.toContain("right final");
    expect(JSON.stringify(right.messages)).not.toContain("left");
  });

  it("drops local chat and permission events with no known session in this webview", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });

    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-other-webview",
        harness: "claude",
        text: "foreign text",
        is_partial: false,
        parent_tool_use_id: null,
      })
    ).toBe(false);
    expect(
      routePermissionRequestEvent({
        request_id: "request-1",
        session_id: "backend-other-webview",
        tool_name: "Bash",
        tool_use_id: "tool-use-1",
        input: { command: "echo no" },
        message: "Allow?",
      })
    ).toBe(false);

    const local = useChatStore.getState().sessions.local;
    expect(local.messages).toEqual([]);
    expect(local.lifecycle).toBe("streaming");
  });

  it("routes an AskUserQuestion permission into the owning session store", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    const questions = [
      {
        question: "Proceed?",
        header: "Confirm",
        options: [{ label: "Yes", description: "Continue" }],
        multi_select: false,
      },
    ];

    expect(
      routePermissionRequestEvent({
        request_id: "request-ask",
        session_id: "backend-local",
        tool_name: "AskUserQuestion",
        tool_use_id: "tool-ask",
        input: { questions },
        message: null,
        questions,
        input_error: null,
      })
    ).toBe(true);
    expect(useChatStore.getState().sessions.local.messages).toEqual([
      expect.objectContaining({
        kind: "user_question",
        requestId: "request-ask",
        originalQuestions: questions,
        status: "pending",
      }),
    ]);
  });

  it("routes hidden-session unexpected-death errors to error lifecycle", () => {
    resetChatStore({
      hidden: makeSession({
        id: "hidden",
        backendSessionId: "backend-hidden",
        providerResumeId: "provider-resume-1",
        lifecycle: "streaming",
      }),
    });

    expect(
      routeLocalChatSessionErrorEvent({
        backend_session_id: "backend-hidden",
        harness: "claude",
        error: "child process exited unexpectedly",
      })
    ).toBe(true);

    const hidden = useChatStore.getState().sessions.hidden;
    expect(hidden.backendSessionId).toBeNull();
    expect(hidden.providerResumeId).toBe("provider-resume-1");
    expect(hidden.lifecycle).toBe("error");
    expect(hidden.lifecycleError).toBe("child process exited unexpectedly");
    expect(hidden.messages).toEqual([
      expect.objectContaining({
        kind: "error",
        message: "child process exited unexpectedly",
      }),
    ]);
  });

  it("ignores stale root content and terminal events after turn replacement", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-1");
    useChatStore.getState().settleActiveTurn("local", "turn-1");
    useChatStore.getState().beginActiveTurn("local");
    startTurn("backend-local", "turn-2");

    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
        text: "stale answer",
        is_partial: false,
        parent_tool_use_id: null,
      })
    ).toBe(false);
    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
        duration_ms: 1,
        cost_usd: 0,
        num_turns: 1,
        result: "stale answer",
        is_error: false,
        context_tokens: 0,
        context_window: 200000,
      })
    ).toBe(false);

    const local = useChatStore.getState().sessions.local;
    expect(local.lifecycle).toBe("streaming");
    expect(local.messages).toEqual([]);
  });

  it("keeps child content without allowing child terminal settlement", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "root-turn");

    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-local",
        harness: "codex",
        turn_id: "child-turn",
        thread_id: "child-thread",
        is_root: false,
        text: "child update",
        is_partial: false,
        parent_tool_use_id: "spawn-tool",
      })
    ).toBe(true);
    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-local",
        harness: "codex",
        turn_id: "child-turn",
        thread_id: "child-thread",
        is_root: false,
        duration_ms: 1,
        cost_usd: 0,
        num_turns: 1,
        result: "child update",
        is_error: false,
        context_tokens: 0,
        context_window: 200000,
      })
    ).toBe(false);

    const local = useChatStore.getState().sessions.local;
    expect(local.lifecycle).toBe("streaming");
    expect(local.messages).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "child update",
        parentToolUseId: "spawn-tool",
      }),
    ]);
  });

  it("keeps an uncorrelated child error visible without settling the root", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "root-turn", "codex");

    expect(
      routeLocalChatSessionErrorEvent({
        backend_session_id: "backend-local",
        harness: "codex",
        turn_id: null,
        thread_id: "child-thread",
        is_root: false,
        error: "child failed",
      })
    ).toBe(true);

    const local = useChatStore.getState().sessions.local;
    expect(local.backendSessionId).toBe("backend-local");
    expect(local.lifecycle).toBe("streaming");
    expect(local.messages).toEqual([
      expect.objectContaining({ kind: "error", message: "child failed" }),
    ]);
  });

  it("routes the shared HarnessEventV1 translation fixture through root completion", () => {
    resetChatStore({
      bridge: makeSession({
        id: "bridge",
        harness: "codex",
        backendSessionId: "backend-bridge",
        lifecycle: "streaming",
      }),
    });
    useChatStore.getState().beginActiveTurn("bridge");

    const routed = translationSequence.map((event) => {
      switch (event.type) {
        case "turn_started":
          return routeLocalChatTurnStartedEvent(
            event.payload as LocalChatTurnStartedEvent
          );
        case "text":
          return routeLocalChatTextEvent(event.payload as LocalChatTextEvent);
        case "tool_call":
          return routeLocalChatToolCallEvent(
            event.payload as LocalChatToolCallEvent
          );
        case "end":
          return routeLocalChatSessionEndEvent(
            event.payload as LocalChatSessionEndEvent
          );
        default:
          throw new Error(`unexpected fixture event: ${event.type}`);
      }
    });

    expect(routed).toEqual([true, true, true, true, true]);
    const bridge = useChatStore.getState().sessions.bridge;
    expect(bridge.lifecycle).toBe("idle");
    expect(bridge.messages).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "root answer",
      }),
      expect.objectContaining({
        kind: "tool_call",
        toolId: "spawn-1",
        toolName: "Agent",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "child update",
        parentToolUseId: "spawn-1",
      }),
    ]);
  });

  it("accepts a same-turn late final snapshot but ignores duplicate End", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-1");
    const end = {
      backend_session_id: "backend-local",
      harness: "claude" as const,
      turn_id: "turn-1",
      thread_id: "backend-local-thread",
      is_root: true,
      duration_ms: 1,
      cost_usd: 0,
      num_turns: 1,
      result: "done",
      is_error: false,
      context_tokens: 0,
      context_window: 200000,
    };

    expect(routeLocalChatSessionEndEvent(end)).toBe(true);
    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
        text: "late delta",
        is_partial: true,
        parent_tool_use_id: null,
      })
    ).toBe(false);
    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
        text: "late final",
        is_partial: false,
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(routeLocalChatSessionEndEvent(end)).toBe(false);

    const local = useChatStore.getState().sessions.local;
    expect(local.lifecycle).toBe("idle");
    expect(local.messages).toEqual([
      expect.objectContaining({ kind: "assistant", text: "late final" }),
    ]);
  });

  it("rejects a stale TurnStarted after settlement without consuming a new pending turn", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-1");
    const end: LocalChatSessionEndEvent = {
      backend_session_id: "backend-local",
      harness: "claude",
      turn_id: "turn-1",
      thread_id: "backend-local-thread",
      is_root: true,
      duration_ms: 1,
      cost_usd: 0,
      num_turns: 1,
      result: "done",
      is_error: false,
      context_tokens: 0,
      context_window: 200000,
    };
    expect(routeLocalChatSessionEndEvent(end)).toBe(true);

    expect(
      routeLocalChatTurnStartedEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
      })
    ).toBe(false);
    expect(useChatStore.getState().sessions.local.activeTurn).toBeNull();

    const nextLocalId = useChatStore.getState().beginActiveTurn("local");
    expect(
      routeLocalChatTurnStartedEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
      })
    ).toBe(false);
    expect(useChatStore.getState().sessions.local.activeTurn).toEqual({
      localId: nextLocalId,
      turnId: null,
      phase: "starting",
    });
    expect(
      routeLocalChatTurnStartedEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-2",
        thread_id: "backend-local-thread",
        is_root: true,
      })
    ).toBe(true);
  });

  it("keeps sequential queued turns active when prior-turn events arrive late", async () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
        queuedMessages: ["second", "third"],
        messages: [
          { kind: "user", text: "second", timestamp: "2026-01-01T00:00:00Z" },
          { kind: "user", text: "third", timestamp: "2026-01-01T00:00:01Z" },
        ],
      }),
    });
    const end = (turnId: string): LocalChatSessionEndEvent => ({
      backend_session_id: "backend-local",
      harness: "claude",
      turn_id: turnId,
      thread_id: "backend-local-thread",
      is_root: true,
      duration_ms: 1,
      cost_usd: 0,
      num_turns: 1,
      result: `${turnId} done`,
      is_error: false,
      context_tokens: 0,
      context_window: 200000,
    });

    startTurn("backend-local", "turn-1");
    const firstLocalTurnId =
      useChatStore.getState().sessions.local.activeTurn?.localId;
    expect(routeLocalChatSessionEndEvent(end("turn-1"))).toBe(true);
    await waitFor(() => {
      expect(mockedCommands.sendLocalChatMessage).toHaveBeenNthCalledWith(
        1,
        "backend-local",
        "second"
      );
      expect(useChatStore.getState().sessions.local.lifecycle).toBe(
        "streaming"
      );
      expect(useChatStore.getState().sessions.local.activeTurn).toMatchObject({
        turnId: null,
        phase: "starting",
      });
      expect(
        useChatStore.getState().sessions.local.activeTurn?.localId
      ).not.toBe(firstLocalTurnId);
    });
    expect(routeLocalChatSessionEndEvent(end("turn-1"))).toBe(false);
    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
        text: "late turn one",
        is_partial: false,
        parent_tool_use_id: null,
      })
    ).toBe(false);
    expect(useChatStore.getState().sessions.local.lifecycle).toBe("streaming");
    startTurn("backend-local", "turn-2");

    expect(routeLocalChatSessionEndEvent(end("turn-2"))).toBe(true);
    await waitFor(() => {
      expect(mockedCommands.sendLocalChatMessage).toHaveBeenNthCalledWith(
        2,
        "backend-local",
        "third"
      );
    });
    startTurn("backend-local", "turn-3");
    expect(routeLocalChatSessionEndEvent(end("turn-1"))).toBe(false);
    expect(useChatStore.getState().sessions.local.lifecycle).toBe("streaming");
    expect(
      useChatStore.getState().sessions.local.queuedMessages
    ).toBeUndefined();

    expect(routeLocalChatSessionEndEvent(end("turn-3"))).toBe(true);
    expect(useChatStore.getState().sessions.local.lifecycle).toBe("idle");
  });

  it("ignores stale terminal errors after a replacement turn starts", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-1");
    useChatStore.getState().settleActiveTurn("local", "turn-1");
    useChatStore.getState().beginActiveTurn("local");
    startTurn("backend-local", "turn-2");

    expect(
      routeLocalChatSessionErrorEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
        error: "stale failure",
      })
    ).toBe(false);

    const local = useChatStore.getState().sessions.local;
    expect(local.backendSessionId).toBe("backend-local");
    expect(local.lifecycle).toBe("streaming");
    expect(local.activeTurn?.turnId).toBe("turn-2");
    expect(local.messages).toEqual([]);
  });

  it("settles only the matching turn on a terminal error", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-error");

    expect(
      routeLocalChatSessionErrorEvent({
        backend_session_id: "backend-local",
        harness: "codex",
        turn_id: "turn-error",
        thread_id: "backend-local-thread",
        is_root: true,
        error: "turn failed",
      })
    ).toBe(true);

    const local = useChatStore.getState().sessions.local;
    expect(local.activeTurn).toBeNull();
    expect(local.backendSessionId).toBeNull();
    expect(local.lifecycle).toBe("error");
    expect(local.lifecycleError).toBe("turn failed");
  });

  it("drops events from a closed or replaced backend session", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-new",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-new", "new-turn");

    expect(
      routeLocalChatTurnStartedEvent({
        backend_session_id: "backend-old",
        harness: "claude",
        turn_id: "old-turn",
        thread_id: "old-thread",
        is_root: true,
      })
    ).toBe(false);
    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-old",
        harness: "claude",
        turn_id: "old-turn",
        thread_id: "old-thread",
        is_root: true,
        text: "old text",
        is_partial: false,
        parent_tool_use_id: null,
      })
    ).toBe(false);
    expect(
      routeLocalChatSessionErrorEvent({
        backend_session_id: "backend-old",
        harness: "claude",
        turn_id: "old-turn",
        thread_id: "old-thread",
        is_root: true,
        error: "old failure",
      })
    ).toBe(false);

    const local = useChatStore.getState().sessions.local;
    expect(local.backendSessionId).toBe("backend-new");
    expect(local.lifecycle).toBe("streaming");
    expect(local.messages).toEqual([]);
  });

  it("keeps routing content when a new root turn replaces a stale binding", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-stale",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-stale", "turn-1");

    // The terminal event for turn-1 never arrived. A refused re-bind would
    // leave the routing map pointing at turn-1 and blank the entire turn.
    startTurn("backend-stale", "turn-2");
    expect(useChatStore.getState().sessions.local.activeTurn).toMatchObject({
      turnId: "turn-2",
      phase: "active",
    });

    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-stale",
        harness: "claude",
        turn_id: "turn-2",
        thread_id: "backend-stale-thread",
        is_root: true,
        text: "second turn answer",
        is_partial: false,
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-stale",
        harness: "claude",
        turn_id: "turn-2",
        thread_id: "backend-stale-thread",
        is_root: true,
        duration_ms: 5,
        cost_usd: 0,
        num_turns: 1,
        result: "ok",
        is_error: false,
        context_tokens: 1,
        context_window: 200000,
      })
    ).toBe(true);

    const local = useChatStore.getState().sessions.local;
    expect(local.lifecycle).toBe("idle");
    expect(local.activeTurn).toBeNull();
    expect(local.messages).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "second turn answer",
      }),
    ]);
  });

  it("still routes and settles a root turn the store never began", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-unbegun",
        lifecycle: "streaming",
      }),
    });

    // No local turn to bind, so the store declines — routing must not go dark.
    expect(
      routeLocalChatTurnStartedEvent({
        backend_session_id: "backend-unbegun",
        harness: "claude",
        turn_id: "turn-x",
        thread_id: "backend-unbegun-thread",
        is_root: true,
      })
    ).toBe(false);
    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-unbegun",
        harness: "claude",
        turn_id: "turn-x",
        thread_id: "backend-unbegun-thread",
        is_root: true,
        text: "unbegun answer",
        is_partial: false,
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-unbegun",
        harness: "claude",
        turn_id: "turn-x",
        thread_id: "backend-unbegun-thread",
        is_root: true,
        duration_ms: 5,
        cost_usd: 0,
        num_turns: 1,
        result: "ok",
        is_error: false,
        context_tokens: 1,
        context_window: 200000,
      })
    ).toBe(true);

    const local = useChatStore.getState().sessions.local;
    expect(local.lifecycle).toBe("idle");
    expect(local.messages).toEqual([
      expect.objectContaining({ kind: "assistant", text: "unbegun answer" }),
    ]);
  });
});
