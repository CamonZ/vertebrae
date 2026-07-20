import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import {
  routeLocalChatSessionEndEvent,
  routeLocalChatSessionErrorEvent,
  routeLocalChatTextEvent,
  routeLocalChatToolResultEvent,
  routePermissionRequestEvent,
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

describe("useLocalChatEventRouter route functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlisteners.length = 0;
    localStorage.clear();
    resetChatStore({});
  });

  it("subscribes only once when the router is mounted multiple times in a webview", async () => {
    const first = renderHook(() => useLocalChatEventRouter());
    const second = renderHook(() => useLocalChatEventRouter());

    await waitFor(() => {
      expect(listen).toHaveBeenCalledTimes(9);
    });
    expect(unlisteners).toHaveLength(9);

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

    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-hidden",
        harness: "claude",
        text: "Final ",
        is_partial: true,
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(
      routeLocalChatTextEvent({
        backend_session_id: "backend-hidden",
        harness: "claude",
        text: "answer",
        is_partial: true,
        parent_tool_use_id: null,
      })
    ).toBe(true);
    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-hidden",
        harness: "claude",
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

    expect(
      routeLocalChatSessionEndEvent({
        backend_session_id: "backend-codex",
        harness: "codex",
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

    routeLocalChatSessionEndEvent({
      backend_session_id: "backend-hidden",
      harness: "claude",
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
});
