import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import {
  useChatStore,
  type ChatMessage,
  type ChatSession,
} from "../stores/chatStore";
import { useChatAttentionStore } from "../stores/chatAttentionStore";
import { useChatAttention } from "./useChatAttention";
import { planTurnAttention, useChatAttentionDriver } from "./useChatAttentionDriver";

vi.mock("../bindings", () => ({
  commands: { classifyChatTurnAttention: vi.fn() },
}));

const classify = vi.mocked(commands.classifyChatTurnAttention);

const ts = "2026-11-22T10:00:00.000Z";
const user = (text: string): ChatMessage => ({ kind: "user", text, timestamp: ts });
const assistant = (text: string): ChatMessage => ({
  kind: "assistant",
  text,
  timestamp: ts,
});
const end = (successful = true): ChatMessage => ({
  kind: "session_end",
  successful,
  durationMs: 900,
  costUsd: 0,
  numTurns: 1,
  timestamp: ts,
});
const permission: ChatMessage = {
  kind: "permission_request",
  requestId: "req-1",
  toolName: "Bash",
  message: "Run tests",
  timestamp: ts,
};

function base(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    label: "Chat",
    messages: [user("Add the export")],
    status: "open",
    harness: "claude",
    backendSessionId: "b1",
    providerResumeId: null,
    lifecycle: "idle",
    projectPath: "/project",
    ...extra,
  };
}

function put(extra: Partial<ChatSession>) {
  act(() => {
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        s1: { ...(state.sessions.s1 ?? base()), ...extra },
      },
    }));
  });
}

function mount(initial: Partial<ChatSession> = {}) {
  put({ ...base(), ...initial });
  return renderHook(() => {
    useChatAttentionDriver("s1");
    return useChatAttention("s1");
  });
}

/** Run a live turn: working, then the given transcript settles idle. */
function liveTurn(messages: ChatMessage[], extra: Partial<ChatSession> = {}) {
  put({ lifecycle: "streaming" });
  put({ messages, lifecycle: "idle", ...extra });
}

beforeEach(() => {
  classify.mockReset();
  classify.mockResolvedValue({ status: "ok", data: "needs_you" });
  useChatAttentionStore.setState({ decisions: {}, viewed: {} });
});

afterEach(() => {
  useChatStore.setState({ sessions: {} });
});

describe("useChatAttentionDriver", () => {
  it("asks once for a live completed turn and shows the answer", async () => {
    const { result, rerender } = mount();
    liveTurn([user("Add it"), assistant("Want me to create it?"), end()]);
    await waitFor(() => expect(result.current.state).toBe("needs-you"));
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({
        project_path: "/project",
        session_id: "s1",
        message: "Want me to create it?",
        allow_inference: true,
      })
    );
    rerender();
    put({ updatedAt: "later" });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("asks nothing while a permission is pending", async () => {
    const { result } = mount();
    liveTurn([user("Run"), permission]);
    await waitFor(() => expect(result.current.state).toBe("blocked"));
    expect(classify).not.toHaveBeenCalled();
  });

  it("asks nothing for a cancelled or failed turn", () => {
    mount();
    liveTurn([user("Run"), assistant("Starting"), end(false)]);
    expect(classify).not.toHaveBeenCalled();
  });

  it("asks nothing when a queued message already answers the turn", () => {
    mount();
    liveTurn([user("Run"), assistant("Done?"), end()], {
      queuedMessages: ["next"],
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("only looks up stored answers for replayed history", async () => {
    classify.mockResolvedValue({ status: "ok", data: "undecided" });
    const { result } = mount({
      messages: [user("Add it"), assistant("Want me to create it?"), end()],
    });
    await waitFor(() => expect(classify).toHaveBeenCalledTimes(1));
    expect(classify.mock.calls[0][0].allow_inference).toBe(false);
    await waitFor(() =>
      expect(
        Object.values(useChatAttentionStore.getState().decisions.s1 ?? {})
      ).toEqual(["undecided"])
    );
    expect(result.current.state).toBe("idle");
  });

  it("falls back to your-turn when the check fails", async () => {
    classify.mockRejectedValue(new Error("offline"));
    const { result } = mount();
    liveTurn([user("Add it"), assistant("Done."), end()]);
    await waitFor(() => expect(result.current.state).toBe("your-turn"));
  });
});

describe("planTurnAttention", () => {
  const done = [user("a"), assistant("b"), end()];

  it("skips discussions and provider child threads", () => {
    expect(
      planTurnAttention(base({ messages: done, discussion: {} as never }), {}, null, true)
        .kind
    ).toBe("skip");
    expect(
      planTurnAttention(
        base({ messages: done, providerChild: {} as never }),
        {},
        null,
        true
      ).kind
    ).toBe("skip");
  });

  it("skips replayed turns the user already viewed", () => {
    const plan = planTurnAttention(base({ messages: done }), {}, null, false);
    expect(plan.kind).toBe("lookup");
    if (plan.kind === "skip") throw new Error("expected a turn");
    expect(
      planTurnAttention(base({ messages: done }), {}, plan.turn.key, false).kind
    ).toBe("skip");
  });
});
