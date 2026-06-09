import { describe, it, expect, vi } from "vitest";
import {
  chatMessagesToThread,
  LOCAL_CHAT_THREAD_ID,
} from "./chatMessagesToThread";
import type { ChatMessage } from "../../stores/chatStore";
import type {
  AgentMessage,
  ErrorMessage,
  ToolMessage,
  UserMessage,
} from "../thread/types";

const TS = "2024-01-01T12:00:00Z";

function build(
  messages: ChatMessage[],
  opts?: {
    collapsed?: Set<string>;
    onToggleTool?: (toolId: string) => void;
  }
) {
  return chatMessagesToThread(messages, {
    collapsed: opts?.collapsed ?? new Set<string>(),
    onToggleTool: opts?.onToggleTool,
  });
}

describe("chatMessagesToThread", () => {
  it("uses the stable local-chat thread id", () => {
    const thread = build([]);
    expect(thread.id).toBe(LOCAL_CHAT_THREAD_ID);
    expect(thread.turns).toEqual([]);
  });

  it("opens a turn for a user message with role human / label You", () => {
    const thread = build([{ kind: "user", text: "hi there", timestamp: TS }]);
    expect(thread.turns).toHaveLength(1);
    const msg = thread.turns[0].messages[0] as UserMessage;
    expect(msg.type).toBe("user");
    expect(msg.role).toBe("human");
    expect(msg.label).toBe("You");
    expect(msg.text).toBe("hi there");
  });

  it("maps an assistant message to an agent message with Claude speaker + prose", () => {
    const thread = build([
      { kind: "user", text: "q", timestamp: TS },
      { kind: "assistant", text: "the answer", timestamp: TS, isPartial: false },
    ]);
    const agent = thread.turns[0].messages[1] as AgentMessage;
    expect(agent.type).toBe("agent");
    expect(agent.speaker).toBe("Claude");
    expect(agent.prose).toBe("the answer");
    expect(agent.streaming).toBe(false);
  });

  it("merges tool_call + tool_result into ONE ToolMessage with ok status + body", () => {
    const thread = build([
      { kind: "assistant", text: "running", timestamp: TS, isPartial: false },
      {
        kind: "tool_call",
        toolName: "Read",
        toolId: "t1",
        input: '{"file_path":"/x.ts"}',
        timestamp: TS,
      },
      { kind: "tool_result", toolId: "t1", result: "file body", isError: false, timestamp: TS },
    ]);
    const agent = thread.turns[0].messages[0] as AgentMessage;
    expect(agent.tools).toHaveLength(1);
    const tool = agent.tools![0];
    expect(tool.evt).toBe("t1");
    expect(tool.status).toBe("ok");
    expect(tool.error).toBeUndefined();
    expect(tool.body).toBe("file body");
    expect(tool.name).toBe("Read");
    expect(tool.kind).toBe("fn");
  });

  it("marks an errored tool_result as err", () => {
    const thread = build([
      { kind: "assistant", text: "", timestamp: TS, isPartial: false },
      {
        kind: "tool_call",
        toolName: "Read",
        toolId: "t1",
        input: "{}",
        timestamp: TS,
      },
      { kind: "tool_result", toolId: "t1", result: "boom", isError: true, timestamp: TS },
    ]);
    const agent = thread.turns[0].messages[0] as AgentMessage;
    const tool = agent.tools![0];
    expect(tool.status).toBe("err");
    expect(tool.error).toBe(true);
    expect(tool.body).toBe("boom");
  });

  it("opens a headless agent when a tool_call arrives before any assistant", () => {
    const thread = build([
      {
        kind: "tool_call",
        toolName: "Read",
        toolId: "t1",
        input: "{}",
        timestamp: TS,
      },
    ]);
    expect(thread.turns).toHaveLength(1);
    const agent = thread.turns[0].messages[0] as AgentMessage;
    expect(agent.type).toBe("agent");
    expect(agent.speaker).toBe("Claude");
    expect(agent.tools).toHaveLength(1);
    expect(agent.tools![0].evt).toBe("t1");
  });

  it("drops session_start and session_end (no rows)", () => {
    const thread = build([
      { kind: "session_start", model: "claude-sonnet-4.5", timestamp: TS },
      { kind: "user", text: "hi", timestamp: TS },
      {
        kind: "session_end",
        durationMs: 1,
        costUsd: 0,
        numTurns: 1,
        timestamp: TS,
      },
    ]);
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].messages).toHaveLength(1);
    expect(thread.turns[0].messages[0].type).toBe("user");
  });

  it("renders Bash as a shell tool carrying the command", () => {
    const thread = build([
      { kind: "assistant", text: "", timestamp: TS, isPartial: false },
      {
        kind: "tool_call",
        toolName: "Bash",
        toolId: "t1",
        input: '{"command":"ls -la"}',
        timestamp: TS,
      },
    ]);
    const agent = thread.turns[0].messages[0] as AgentMessage;
    const tool = agent.tools![0] as ToolMessage;
    expect(tool.kind).toBe("shell");
    expect(tool.cmd).toBe("ls -la");
    expect(tool.name).toBeUndefined();
  });

  it("falls back to raw input when a Bash input is not parseable JSON", () => {
    const thread = build([
      {
        kind: "tool_call",
        toolName: "Bash",
        toolId: "t1",
        input: "echo hi",
        timestamp: TS,
      },
    ]);
    const agent = thread.turns[0].messages[0] as AgentMessage;
    expect((agent.tools![0] as ToolMessage).cmd).toBe("echo hi");
  });

  it("sets streaming true for a partial assistant and false when finalized", () => {
    const partial = build([
      { kind: "assistant", text: "typing", timestamp: TS, isPartial: true },
    ]);
    expect(
      (partial.turns[0].messages[0] as AgentMessage).streaming
    ).toBe(true);

    const done = build([
      { kind: "assistant", text: "done", timestamp: TS, isPartial: false },
    ]);
    expect((done.turns[0].messages[0] as AgentMessage).streaming).toBe(false);
  });

  it("reflects the collapsed Set on the tool and wires onToggle to the toolId", () => {
    const onToggleTool = vi.fn();
    const thread = build(
      [
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "t1",
          input: "{}",
          timestamp: TS,
        },
      ],
      { collapsed: new Set(["t1"]), onToggleTool }
    );
    const tool = (thread.turns[0].messages[0] as AgentMessage).tools![0];
    expect(tool.collapsed).toBe(true);
    tool.onToggle?.();
    expect(onToggleTool).toHaveBeenCalledWith("t1");
  });

  it("leaves a tool uncollapsed when it is not in the collapsed Set", () => {
    const thread = build([
      {
        kind: "tool_call",
        toolName: "Read",
        toolId: "t1",
        input: "{}",
        timestamp: TS,
      },
    ]);
    expect(
      (thread.turns[0].messages[0] as AgentMessage).tools![0].collapsed
    ).toBe(false);
  });

  it("maps an error event to a terminal ErrorMessage", () => {
    const thread = build([
      { kind: "error", message: "Connection failed", timestamp: TS },
    ]);
    expect(thread.turns).toHaveLength(1);
    const err = thread.turns[0].messages[0] as ErrorMessage;
    expect(err.type).toBe("error");
    expect(err.title).toBe("Connection failed");
  });

  it("skips permission_request (handled as a sibling by ChatWindow)", () => {
    const thread = build([
      {
        kind: "permission_request",
        requestId: "r1",
        toolName: "Bash",
        message: "approve?",
        input: "{}",
        timestamp: TS,
      },
    ]);
    expect(thread.turns).toHaveLength(0);
  });

  it("starts a fresh turn at each user message and attaches following assistants", () => {
    const thread = build([
      { kind: "user", text: "first", timestamp: TS },
      { kind: "assistant", text: "reply 1", timestamp: TS, isPartial: false },
      { kind: "user", text: "second", timestamp: TS },
      { kind: "assistant", text: "reply 2", timestamp: TS, isPartial: false },
    ]);
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns[0].messages.map((m) => m.type)).toEqual([
      "user",
      "agent",
    ]);
    expect(thread.turns[1].messages.map((m) => m.type)).toEqual([
      "user",
      "agent",
    ]);
  });
});
