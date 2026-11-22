import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatSession } from "../stores/chatStore";
import {
  chatAttentionJumpOrder,
  chatTurnSignals,
  deriveChatAttention,
  nextChatNeedingYou,
  type ChatAttention,
  type ChatAttentionRecord,
} from "./chatAttention";

const at = (minute: number) =>
  `2026-11-22T10:${String(minute).padStart(2, "0")}:00.000Z`;

const user = (text: string, minute = 0): ChatMessage => ({
  kind: "user",
  text,
  timestamp: at(minute),
});
const assistant = (text: string, minute = 1): ChatMessage => ({
  kind: "assistant",
  text,
  timestamp: at(minute),
});
const end = (minute = 2, successful = true): ChatMessage => ({
  kind: "session_end",
  successful,
  durationMs: 1200 + minute,
  costUsd: 0,
  numTurns: 1,
  timestamp: at(minute),
});
const permission = (
  toolName = "Bash",
  status?: "resolved" | "unavailable"
): ChatMessage => ({
  kind: "permission_request",
  requestId: `req-${toolName}`,
  toolName,
  message: `${toolName} needs approval`,
  ...(status ? { status } : {}),
  timestamp: at(1),
});
const question = (status: "pending" | "resolved" = "pending"): ChatMessage => ({
  kind: "user_question",
  requestId: "q1",
  toolUseId: "tool-q1",
  questions: [],
  originalQuestions: [],
  status,
  timestamp: at(1),
});

function session(
  messages: ChatMessage[],
  extra: Partial<ChatSession> = {}
): ChatSession {
  return {
    id: "s1",
    label: "Chat",
    messages,
    status: "open",
    harness: "claude",
    backendSessionId: "b1",
    providerResumeId: null,
    lifecycle: "idle",
    ...extra,
  };
}

const completedKey = (messages: ChatMessage[]) =>
  chatTurnSignals(messages).completedTurn!.key;

function record(
  messages: ChatMessage[],
  decision: ChatAttentionRecord["decisions"][string] | null,
  viewed = false
): ChatAttentionRecord {
  const key = completedKey(messages);
  return {
    decisions: decision ? { [key]: decision } : {},
    viewedTurnKey: viewed ? key : null,
  };
}

describe("chatTurnSignals", () => {
  it("reads the completed turn's last root reply and ignores child threads", () => {
    const messages: ChatMessage[] = [
      user("Add the export"),
      assistant("Want me to create it?"),
      {
        kind: "assistant",
        text: "child reply",
        timestamp: at(1),
        parentToolUseId: "spawn-1",
      },
      end(),
    ];
    const turn = chatTurnSignals(messages).completedTurn;
    expect(turn?.message).toBe("Want me to create it?");
    expect(turn?.endedAt).toBe(at(2));
  });

  it("keys a turn by content and provider counters, not arrival time", () => {
    const live = [user("Go"), assistant("Done."), end()];
    const replay = [
      user("Go", 30),
      assistant("Done.", 31),
      { ...(end() as Extract<ChatMessage, { kind: "session_end" }>), timestamp: at(59) },
    ];
    expect(completedKey(replay)).toBe(completedKey(live));
    const repeated = [...live, user("Go", 3), assistant("Done.", 4), end(5)];
    expect(completedKey(repeated)).not.toBe(completedKey(live));
  });

  it("has no completed turn after a reply, a cancel or while running", () => {
    expect(
      chatTurnSignals([user("a"), assistant("b"), end(), user("c", 3)])
        .completedTurn
    ).toBeNull();
    const cancelled = chatTurnSignals([user("a"), assistant("b"), end(2, false)]);
    expect(cancelled.completedTurn).toBeNull();
    expect(cancelled.endedUnsuccessfully).toBe(true);
    expect(chatTurnSignals([user("a"), assistant("b")]).completedTurn).toBeNull();
  });

  it("treats requests before a turn end as stale", () => {
    expect(
      chatTurnSignals([user("a"), permission(), end()]).blocked
    ).toBeNull();
  });
});

describe("deriveChatAttention", () => {
  const derive = (
    messages: ChatMessage[],
    rec?: ChatAttentionRecord,
    extra: Partial<ChatSession> = {}
  ) => deriveChatAttention(session(messages, extra), rec);

  it("names blocked reasons for permissions, plans and questions", () => {
    expect(derive([user("a"), permission("Bash")], undefined, { lifecycle: "streaming" }))
      .toMatchObject({ state: "blocked", reason: "Permission: Bash" });
    expect(derive([user("a"), permission("ExitPlanMode")])).toMatchObject({
      state: "blocked",
      reason: "Plan",
    });
    expect(derive([user("a"), question()])).toMatchObject({
      state: "blocked",
      reason: "Question",
    });
  });

  it("clears blocked once the permission or question is answered", () => {
    expect(derive([user("a"), permission("Bash", "resolved")]).state).toBe("idle");
    expect(
      derive([user("a"), question("resolved")], undefined, {
        lifecycle: "streaming",
      }).state
    ).toBe("running");
  });

  it("blocks on a waiting gate only while the agent is not working", () => {
    const gate = {
      gate: { runId: "r", stepId: "s", executionId: "e" } as never,
      gateStatus: {
        phase: "drafting" as const,
        attempt: 1,
        waitingExecutionId: "e",
        waitingSince: at(5),
        draftUpdatedAt: null,
      },
    };
    expect(derive([user("a")], undefined, gate)).toMatchObject({
      state: "blocked",
      reason: "Gate",
      since: at(5),
    });
    expect(
      derive([user("a")], undefined, { ...gate, lifecycle: "streaming" }).state
    ).toBe("running");
  });

  it("maps turn-end decisions to needs-you and your-turn until viewed", () => {
    const messages = [user("Add it"), assistant("Want me to create it?"), end()];
    expect(derive(messages, record(messages, "needs_you"))).toEqual({
      state: "needs-you",
      reason: "Asked you something",
      since: at(2),
    });
    expect(derive(messages, record(messages, "your_turn")).state).toBe("your-turn");
    // While the model is asked, the quiet your-turn shows.
    expect(derive(messages, record(messages, "asking")).state).toBe("your-turn");
    // Replayed history without a stored answer stays quiet.
    expect(derive(messages, record(messages, "undecided")).state).toBe("idle");
    expect(derive(messages, record(messages, null)).state).toBe("idle");
    expect(derive(messages, record(messages, "needs_you", true)).state).toBe("idle");
  });

  it("clears needs-you and your-turn when the user replies", () => {
    const messages = [user("Add it"), assistant("Want me to create it?"), end()];
    const rec = record(messages, "needs_you");
    expect(
      derive([...messages, user("Yes", 3)], rec, { lifecycle: "sending" }).state
    ).toBe("running");
    expect(derive([...messages, user("Yes", 3)], rec).state).toBe("idle");
  });

  it("orders overlapping signals blocked, error, needs-you, your-turn, running", () => {
    const done = [user("a"), assistant("Proceed?"), end()];
    const needsYou = record(done, "needs_you");
    expect(
      derive([...done, permission("Bash")], needsYou, { lifecycle: "error" }).state
    ).toBe("blocked");
    expect(derive(done, needsYou, { lifecycle: "error" }).state).toBe("error");
    expect(derive(done, needsYou, { status: "closed" }).state).toBe("needs-you");
    expect(derive([user("a")], undefined, { status: "closed" }).state).toBe("closed");
    expect(derive([user("a")], undefined, { lifecycle: "streaming" }).state).toBe(
      "running"
    );
  });
});

describe("jump order", () => {
  const chat = (
    id: string,
    state: ChatAttention["state"],
    since: string | null
  ) => ({ id, attention: { state, reason: null, since } });

  it("counts blocked, error and needs-you; blocked first, then oldest", () => {
    const chats = [
      chat("needs-old", "needs-you", at(1)),
      chat("turn", "your-turn", at(0)),
      chat("error-new", "error", at(9)),
      chat("blocked-new", "blocked", at(8)),
      chat("running", "running", null),
      chat("blocked-old", "blocked", at(2)),
    ];
    expect(chatAttentionJumpOrder(chats).map((c) => c.id)).toEqual([
      "blocked-old",
      "blocked-new",
      "needs-old",
      "error-new",
    ]);
    expect(nextChatNeedingYou(chats, "blocked-new")?.id).toBe("needs-old");
    expect(nextChatNeedingYou(chats, "error-new")?.id).toBe("blocked-old");
    expect(nextChatNeedingYou([chat("x", "idle", null)], null)).toBeNull();
  });
});
