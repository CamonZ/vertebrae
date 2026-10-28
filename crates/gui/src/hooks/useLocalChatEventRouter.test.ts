import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commands,
  type LocalChatSessionEndEvent,
  type LocalChatTextEvent,
  type LocalChatToolCallEvent,
  type LocalChatTurnStartedEvent,
  type LocalChatCompactionEvent,
  type LocalChatSessionTitleEvent,
} from "../bindings";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import translationSequence from "../test/fixtures/localChatTurnTranslation.json";
import {
  routeLocalChatSessionUsageEvent,
  routeLocalChatSessionEndEvent,
  routeLocalChatSessionTitleEvent,
  routeLocalChatSessionErrorEvent,
  routeLocalChatSessionWarningEvent,
  routeLocalChatCompactionEvent,
  routeLocalChatTextEvent,
  routeLocalChatToolCallEvent,
  routeLocalChatToolResultEvent,
  routeLocalChatFileChangeEvent,
  routeLocalChatTurnStartedEvent,
  routePermissionRequestEvent,
  resetLocalChatTurnRoutingForTests,
  useLocalChatEventRouter,
} from "./useLocalChatEventRouter";
import { useLocalChat } from "./useLocalChat";

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
      localChatSessionTitleEvent: { listen },
      localChatTurnStartedEvent: { listen },
      localChatSessionUsageEvent: { listen },
      localChatTextEvent: { listen },
      localChatToolCallEvent: { listen },
      localChatToolResultEvent: { listen },
      permissionRequestEvent: { listen },
      localChatSessionEndEvent: { listen },
      localChatSessionErrorEvent: { listen },
      localChatSessionWarningEvent: { listen },
      localChatCompactionEvent: { listen },
      localChatAnnotationEvent: { listen },
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

  it("routes a native session title into the store", () => {
    resetChatStore({
      session: makeSession({ backendSessionId: "backend", label: "New Chat" }),
    });
    const payload: LocalChatSessionTitleEvent = {
      backend_session_id: "backend",
      harness: "claude",
      title: "Native Claude Title",
    };

    expect(routeLocalChatSessionTitleEvent(payload)).toBe(true);
    expect(useChatStore.getState().sessions.session.title).toBe(
      "Native Claude Title"
    );
  });

  it("does not replace a manual title with a native title", () => {
    resetChatStore({
      session: makeSession({
        backendSessionId: "backend",
        title: "Keep My Title",
        titleStatus: "manual",
      }),
    });

    expect(
      routeLocalChatSessionTitleEvent({
        backend_session_id: "backend",
        harness: "claude",
        title: "Provider Title",
      })
    ).toBe(true);
    expect(useChatStore.getState().sessions.session.title).toBe(
      "Keep My Title"
    );
  });

  it("subscribes only once when the router is mounted multiple times in a webview", async () => {
    const first = renderHook(() => useLocalChatEventRouter());
    const second = renderHook(() => useLocalChatEventRouter());

    await waitFor(() => {
      expect(listen).toHaveBeenCalledTimes(13);
    });
    expect(unlisteners).toHaveLength(13);

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

  it("routes compaction state to only the matching session and clears at the boundary", () => {
    resetChatStore({
      left: makeSession({
        id: "left",
        backendSessionId: "backend-left",
        lifecycle: "streaming",
      }),
      right: makeSession({
        id: "right",
        backendSessionId: "backend-right",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-left", "turn-left");

    const event = (
      state: LocalChatCompactionEvent["state"]
    ): LocalChatCompactionEvent => ({
      backend_session_id: "backend-left",
      harness: "claude",
      turn_id: "turn-left",
      thread_id: "thread-left",
      is_root: true,
      state,
      trigger: state === "completed" ? "manual" : null,
      pre_tokens: state === "completed" ? 42_000 : null,
    });

    expect(routeLocalChatCompactionEvent(event("active"))).toBe(true);
    expect(useChatStore.getState().sessions.left.compactionActive).toBe(true);
    expect(useChatStore.getState().sessions.right.compactionActive).not.toBe(
      true
    );
    expect(useChatStore.getState().sessions.left.messages).toEqual([]);

    expect(routeLocalChatCompactionEvent(event("completed"))).toBe(true);
    expect(useChatStore.getState().sessions.left.compactionActive).toBe(false);
    expect(useChatStore.getState().sessions.left.compactionSummary).toEqual({
      trigger: "manual",
      preTokens: 42_000,
    });

    expect(routeLocalChatCompactionEvent(event("active"))).toBe(true);
    expect(useChatStore.getState().sessions.left.compactionSummary).toBeNull();
    expect(routeLocalChatCompactionEvent(event("completed"))).toBe(true);

    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-left",
        harness: "claude",
        turn_id: "turn-left",
        thread_id: "thread-left",
        is_root: true,
        duration_ms: 100,
        cost_usd: 0,
        num_turns: 1,
        result: "done",
        is_error: false,
        context_tokens: 42_000,
        context_window: 200_000,
      })
    ).toBe(true);
    expect(useChatStore.getState().sessions.left.compactionSummary).toEqual({
      trigger: "manual",
      preTokens: 42_000,
    });
  });

  it("clears compaction on session error and cancellation cleanup", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
        compactionActive: true,
      }),
    });
    startTurn("backend-local", "turn-error");

    expect(
      routeLocalChatSessionErrorEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-error",
        thread_id: "thread-local",
        is_root: true,
        error: "failed",
      })
    ).toBe(true);
    expect(useChatStore.getState().sessions.local.compactionActive).toBe(false);

    useChatStore.setState({
      sessions: {
        local: makeSession({
          id: "local",
          backendSessionId: "backend-local",
          lifecycle: "streaming",
          compactionActive: true,
        }),
      },
    });
    useChatStore.getState().setSessionLifecycle("local", "closing");
    expect(useChatStore.getState().sessions.local.compactionActive).toBe(false);

    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
        compactionActive: true,
      }),
    });
    startTurn("backend-local", "turn-end");
    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-end",
        thread_id: "thread-local",
        is_root: true,
        duration_ms: 1,
        cost_usd: 0,
        num_turns: 1,
        result: "done",
        is_error: false,
        context_tokens: 0,
        context_window: 200_000,
      })
    ).toBe(true);
    expect(useChatStore.getState().sessions.local.compactionActive).toBe(false);
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

  it("does not resurrect an idle Claude session from uncorrelated root content", async () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-normal");
    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: "turn-normal",
        thread_id: "backend-local-thread",
        is_root: true,
        duration_ms: 1,
        cost_usd: 0,
        num_turns: 1,
        result: "done",
        is_error: false,
        context_tokens: 0,
        context_window: 200000,
      })
    ).toBe(true);

    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-local",
        harness: "claude",
        turn_id: null,
        thread_id: "backend-local-thread",
        is_root: true,
        text: "background task notification",
        is_partial: true,
        parent_tool_use_id: null,
      })
    ).toBe(false);
    expect(useChatStore.getState().sessions.local.lifecycle).toBe("idle");

    const hook = renderHook(() => useLocalChat("local"));
    await act(async () => {
      await hook.result.current.sendMessage("follow-up");
    });
    expect(mockedCommands.sendLocalChatMessage).toHaveBeenCalledWith(
      "backend-local",
      "follow-up"
    );
    expect(
      useChatStore.getState().sessions.local.queuedMessages
    ).toBeUndefined();
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

  it("keeps child content out of the parent without allowing child terminal settlement", () => {
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
    ).toBe(true);

    const local = useChatStore.getState().sessions.local;
    expect(local.lifecycle).toBe("streaming");
    expect(local.messages).toEqual([]);
  });

  it.each(["claude", "codex"] as const)(
    "routes unlinked %s child text, tools and edits into the child session",
    (harness) => {
      resetChatStore({
        local: makeSession({
          id: "local",
          harness,
          backendSessionId: "backend-local",
          lifecycle: "streaming",
        }),
      });
      startTurn("backend-local", "root-turn", harness);
      const child = {
        backend_session_id: "backend-local",
        harness,
        turn_id: "child-turn",
        thread_id: "child-thread",
        is_root: false,
        parent_tool_use_id: null,
      };
      expect(
        routeLocalChatTextEvent({
          ...child,
          text: "child-only",
          is_partial: false,
        })
      ).toBe(true);
      expect(
        routeLocalChatToolCallEvent({
          ...child,
          tool_id: "child-call",
          tool_name: "Bash",
          input: "{}",
        })
      ).toBe(true);
      expect(
        routeLocalChatToolResultEvent({
          ...child,
          tool_id: "child-call",
          result: "child-only",
          is_error: false,
        })
      ).toBe(true);
      expect(
        routeLocalChatFileChangeEvent({
          ...child,
          tool_id: "child-file",
          status: "completed",
          changes: [{ path: "child.rs", kind: "add", diff: "+child" }],
        })
      ).toBe(true);
      expect(useChatStore.getState().sessions.local.messages).toEqual([]);
      const selectedChild =
        useChatStore.getState().sessions[`local-chat-${harness}-child-thread`];
      expect(selectedChild.messages).toMatchObject([
        { kind: "assistant", text: "child-only" },
        { kind: "tool_call" },
        { kind: "tool_result" },
        { kind: "file_edit" },
      ]);
      expect(
        selectedChild.messages.every(
          (message) =>
            !("parentToolUseId" in message) || !message.parentToolUseId
        )
      ).toBe(true);
      expect(useChatStore.getState().sessions.local.lifecycle).toBe(
        "streaming"
      );
    }
  );

  it("keeps child errors out of the parent without settling the root", () => {
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
    expect(local.messages).toEqual([]);
    expect(
      useChatStore.getState().sessions["local-chat-codex-child-thread"].messages
    ).toContainEqual(
      expect.objectContaining({ kind: "error", message: "child failed" })
    );
  });

  it("keeps scoped child approvals in the child and unscoped Sacrum approvals with their owner", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        harness: "codex",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    const request = {
      request_id: "child-approval",
      session_id: "backend-local",
      tool_name: "Bash",
      tool_use_id: "child-tool",
      input: { command: "pwd" },
      message: "Allow?",
      is_root: false,
    };
    expect(
      routePermissionRequestEvent({ ...request, thread_id: "child-thread" })
    ).toBe(true);
    expect(useChatStore.getState().sessions.local.messages).toEqual([]);
    expect(
      useChatStore.getState().sessions["local-chat-codex-child-thread"].messages
    ).toContainEqual(
      expect.objectContaining({
        kind: "permission_request",
        requestId: "child-approval",
      })
    );
    expect(
      routePermissionRequestEvent({
        ...request,
        request_id: "sacrum-approval",
        thread_id: null,
      })
    ).toBe(true);
    expect(useChatStore.getState().sessions.local.messages).toContainEqual(
      expect.objectContaining({ requestId: "sacrum-approval" })
    );
    const questions = [
      {
        question: "Proceed?",
        header: "Confirm",
        options: [{ label: "Yes", description: "Continue" }],
        multi_select: false,
      },
    ];
    routePermissionRequestEvent({
      ...request,
      request_id: "child-question",
      turn_id: "child-turn",
      thread_id: "child-thread",
      tool_name: "AskUserQuestion",
      input: { questions },
      questions,
      input_error: null,
    });
    routeLocalChatSessionEndEvent({
      backend_session_id: "backend-local",
      harness: "codex",
      turn_id: "child-turn",
      thread_id: "child-thread",
      is_root: false,
      duration_ms: 0,
      cost_usd: 0,
      num_turns: 1,
      result: "",
      is_error: false,
      context_tokens: 0,
      context_window: 0,
    });
    expect(
      useChatStore.getState().sessions["local-chat-codex-child-thread"].messages
    ).toContainEqual(
      expect.objectContaining({
        kind: "user_question",
        requestId: "child-question",
        status: "unavailable",
      })
    );
  });

  it("clears owned Claude child activity on an interrupted root and on process closure", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        harness: "claude",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "root-turn", "claude");
    const child = {
      backend_session_id: "backend-local",
      harness: "claude" as const,
      turn_id: "child-turn",
      thread_id: "child-thread",
      is_root: false,
      parent_tool_use_id: null,
    };
    routeLocalChatToolCallEvent({
      ...child,
      tool_id: "child-call",
      tool_name: "Bash",
      input: "{}",
    });
    const id = "local-chat-claude-child-thread";
    expect(useChatStore.getState().sessions[id].providerChild?.active).toBe(
      true
    );
    routeLocalChatSessionEndEvent({
      backend_session_id: "backend-local",
      harness: "claude",
      turn_id: "root-turn",
      thread_id: "root-thread",
      is_root: true,
      completion_status: "interrupted",
      duration_ms: 0,
      cost_usd: 0,
      num_turns: 1,
      result: "",
      is_error: true,
      context_tokens: 0,
      context_window: 0,
    });
    expect(useChatStore.getState().sessions[id].providerChild?.active).toBe(
      false
    );
    useChatStore.getState().beginActiveTurn("local");
    useChatStore
      .getState()
      .setProviderChildActivity(id, true, "next-child-turn");
    expect(useChatStore.getState().sessions[id].providerChild?.active).toBe(
      true
    );
    useChatStore.getState().setSessionLifecycle("local", "closed");
    expect(useChatStore.getState().sessions[id].providerChild?.active).toBe(
      false
    );
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

    expect(routed).toEqual([true, true, true, true, true, true]);
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

  it("keeps the session and turn attached through retry warnings, then settles once on the terminal error", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-retry", "codex");

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(
        routeLocalChatSessionWarningEvent({
          backend_session_id: "backend-local",
          harness: "codex",
          turn_id: "turn-retry",
          thread_id: "backend-local-thread",
          is_root: true,
          warning: `Reconnecting... ${attempt}/5`,
        })
      ).toBe(true);
      const mid = useChatStore.getState().sessions.local;
      expect(mid.backendSessionId).toBe("backend-local");
      expect(mid.activeTurn?.turnId).toBe("turn-retry");
    }

    const terminal = {
      backend_session_id: "backend-local",
      harness: "codex" as const,
      turn_id: "turn-retry",
      thread_id: "backend-local-thread",
      is_root: true,
      error: "stream closed before response.completed",
    };
    expect(routeLocalChatSessionErrorEvent(terminal)).toBe(true);
    // The session is released by the first terminal error; a duplicate is
    // dropped rather than settling or appending a second diagnostic.
    expect(routeLocalChatSessionErrorEvent(terminal)).toBe(false);

    const local = useChatStore.getState().sessions.local;
    expect(local.activeTurn).toBeNull();
    expect(local.lifecycle).toBe("error");
    expect(
      local.messages.filter((m) => m.kind === "warning").map((m) => m.message)
    ).toEqual([1, 2, 3, 4, 5].map((n) => `Reconnecting... ${n}/5`));
    expect(local.messages.filter((m) => m.kind === "error")).toHaveLength(1);
  });

  it("continues normal streaming after a retry warning", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-ok", "codex");

    expect(
      routeLocalChatSessionWarningEvent({
        backend_session_id: "backend-local",
        harness: "codex",
        turn_id: "turn-ok",
        thread_id: "backend-local-thread",
        is_root: true,
        warning: "Reconnecting... 1/5",
      })
    ).toBe(true);
    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-local",
        harness: "codex",
        turn_id: "turn-ok",
        thread_id: "backend-local-thread",
        is_root: true,
        text: "hello",
        item_id: "item-1",
      } as LocalChatTextEvent)
    ).toBe(true);

    const local = useChatStore.getState().sessions.local;
    expect(local.backendSessionId).toBe("backend-local");
    expect(local.activeTurn?.turnId).toBe("turn-ok");
    expect(local.lifecycle).not.toBe("error");
  });

  it("ignores retry warnings from a stale turn", () => {
    resetChatStore({
      local: makeSession({
        id: "local",
        backendSessionId: "backend-local",
        lifecycle: "streaming",
      }),
    });
    startTurn("backend-local", "turn-1", "codex");
    useChatStore.getState().settleActiveTurn("local", "turn-1");
    useChatStore.getState().beginActiveTurn("local");
    startTurn("backend-local", "turn-2", "codex");

    expect(
      routeLocalChatSessionWarningEvent({
        backend_session_id: "backend-local",
        harness: "codex",
        turn_id: "turn-1",
        thread_id: "backend-local-thread",
        is_root: true,
        warning: "Reconnecting... 2/5",
      })
    ).toBe(false);
    expect(useChatStore.getState().sessions.local.messages).toEqual([]);
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

it("routes manual compaction usage without a chat turn, including delayed completion delivery", () => {
  resetLocalChatTurnRoutingForTests();
  resetChatStore({
    session: makeSession({
      harness: "codex",
      backendSessionId: "backend",
      lifecycle: "compacting",
    }),
  });
  const usage = {
    backend_session_id: "backend",
    harness: "codex" as const,
    is_root: true,
    turn_id: null,
    thread_id: "thread",
    model: "model",
    context_tokens: 123,
    context_window: 1000,
    thread_total_tokens: 456,
  };
  expect(routeLocalChatSessionUsageEvent(usage)).toBe(true);
  expect(useChatStore.getState().sessions.session.tokenUsage).toEqual({
    used: 123,
    max: 1000,
  });
  expect(
    routeLocalChatCompactionEvent({
      backend_session_id: "backend",
      harness: "codex",
      is_root: true,
      turn_id: null,
      thread_id: "thread",
      state: "completed",
      trigger: "manual",
      pre_tokens: null,
    })
  ).toBe(true);
  useChatStore.getState().setSessionLifecycle("session", "idle");
  expect(
    routeLocalChatSessionUsageEvent({ ...usage, context_tokens: 100 })
  ).toBe(true);
  expect(useChatStore.getState().sessions.session.tokenUsage?.used).toBe(100);
  expect(
    routeLocalChatTextEvent({
      backend_session_id: "backend",
      harness: "codex",
      is_root: true,
      turn_id: null,
      thread_id: "thread",
      text: "stale",
      parent_tool_use_id: null,
      is_partial: true,
    })
  ).toBe(false);
  expect(
    routeLocalChatSessionUsageEvent({ ...usage, backend_session_id: "other" })
  ).toBe(false);
});
