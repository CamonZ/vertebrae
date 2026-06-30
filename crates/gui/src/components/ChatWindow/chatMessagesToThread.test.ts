import { describe, it, expect, vi } from "vitest";
import {
  chatMessagesToThread,
  LOCAL_CHAT_THREAD_ID,
} from "./chatMessagesToThread";
import type { ChatMessage } from "../../stores/chatStore";
import type {
  AgentMessage,
  ErrorMessage,
  Message,
  SpawnMessage,
  ToolMessage,
  UserMessage,
} from "../thread/types";

const TS = "2024-01-01T12:00:00Z";

function build(
  messages: ChatMessage[],
  opts?: {
    collapsed?: Set<string>;
    onToggleTool?: (toolId: string) => void;
    assistantLabel?: string;
  }
) {
  return chatMessagesToThread(messages, {
    collapsed: opts?.collapsed ?? new Set<string>(),
    onToggleTool: opts?.onToggleTool,
    assistantLabel: opts?.assistantLabel,
  });
}

/** First tool row in a turn (tools render as standalone rows in the series). */
function firstTool(messages: Message[]): ToolMessage {
  const t = messages.find((m) => m.type === "tool");
  if (!t) throw new Error("no tool message in turn");
  return t as ToolMessage;
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

  it("maps an assistant message to an agent message with a provider speaker + prose", () => {
    const thread = build([
      { kind: "user", text: "q", timestamp: TS },
      { kind: "assistant", text: "the answer", timestamp: TS, isPartial: false },
    ], { assistantLabel: "Codex" });
    const agent = thread.turns[0].messages[1] as AgentMessage;
    expect(agent.type).toBe("agent");
    expect(agent.speaker).toBe("Codex");
    expect(agent.prose).toBe("the answer");
    expect(agent.streaming ?? false).toBe(false);
  });

  it("merges tool_call + tool_result into ONE standalone ToolMessage with body", () => {
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
    const tool = firstTool(thread.turns[0].messages);
    expect(tool.evt).toBe("t1");
    expect(tool.status).toBe("done");
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
    const tool = firstTool(thread.turns[0].messages);
    expect(tool.status).toBe("err");
    expect(tool.error).toBe(true);
    expect(tool.body).toBe("boom");
  });

  it("renders a tool_call with no preceding assistant as a standalone tool row", () => {
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
    const msgs = thread.turns[0].messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("tool");
    expect(msgs[0].evt).toBe("t1");
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
    const tool = firstTool(thread.turns[0].messages);
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
    expect(firstTool(thread.turns[0].messages).cmd).toBe("echo hi");
  });

  it("sets streaming true for a partial assistant and falsy when finalized", () => {
    const partial = build([
      { kind: "assistant", text: "typing", timestamp: TS, isPartial: true },
    ]);
    const a = partial.turns[0].messages.find(
      (m) => m.type === "agent"
    ) as AgentMessage;
    expect(a.streaming).toBe(true);

    const done = build([
      { kind: "assistant", text: "done", timestamp: TS, isPartial: false },
    ]);
    const b = done.turns[0].messages.find(
      (m) => m.type === "agent"
    ) as AgentMessage;
    expect(b.streaming ?? false).toBe(false);
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
    const tool = firstTool(thread.turns[0].messages);
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
    expect(firstTool(thread.turns[0].messages).collapsed).toBe(false);
  });

  it("nests a sub-agent's tool calls under a SpawnMessage child thread", () => {
    const thread = build([
      { kind: "assistant", text: "spawning", timestamp: TS, isPartial: false },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "toolu_AGENT",
        input: '{"description":"Explore","subagent_type":"Explore"}',
        timestamp: TS,
      },
      {
        kind: "tool_call",
        toolName: "Read",
        toolId: "toolu_child",
        input: "{}",
        timestamp: TS,
        parentToolUseId: "toolu_AGENT",
      },
      {
        kind: "tool_result",
        toolId: "toolu_child",
        result: "file body",
        isError: false,
        timestamp: TS,
        parentToolUseId: "toolu_AGENT",
      },
    ]);
    const msgs = thread.turns[0].messages;

    // The Agent spawn becomes a SpawnMessage carrying a child thread.
    const spawn = msgs.find((m) => m.type === "spawn") as SpawnMessage;
    expect(spawn).toBeDefined();
    expect(spawn.evt).toBe("toolu_AGENT");

    // The sub-agent's tool nests INSIDE the child thread...
    const childTools = spawn.thread.turns
      .flatMap((t) => t.messages)
      .filter((m) => m.type === "tool") as ToolMessage[];
    expect(childTools.map((t) => t.evt)).toContain("toolu_child");
    expect(childTools.find((t) => t.evt === "toolu_child")?.body).toBe(
      "file body"
    );

    // ...and does NOT leak into the main turn series.
    expect(
      msgs.some((m) => m.type === "tool" && m.evt === "toolu_child")
    ).toBe(false);
  });

  it("re-injects childrenByParent children in place (not orphaned at the bottom)", () => {
    // The spawning Agent tool_call stays in the main stream; its sub-agent
    // children are supplied via childrenByParent (extracted by ChatWindow so a
    // permission boundary can't split them). The spawn must nest IN PLACE —
    // labelled by the parent (in-place path), not "subagent" (orphaned path).
    const children = new Map<string, ChatMessage[]>([
      [
        "toolu_AGENT",
        [
          {
            kind: "tool_call",
            toolName: "Read",
            toolId: "toolu_child",
            input: "{}",
            timestamp: TS,
            parentToolUseId: "toolu_AGENT",
          },
          {
            kind: "tool_result",
            toolId: "toolu_child",
            result: "child body",
            isError: false,
            timestamp: TS,
            parentToolUseId: "toolu_AGENT",
          },
        ],
      ],
    ]);
    const thread = chatMessagesToThread(
      [
        { kind: "assistant", text: "spawning", timestamp: TS, isPartial: false },
        {
          kind: "tool_call",
          toolName: "Agent",
          toolId: "toolu_AGENT",
          input: '{"description":"Explore"}',
          timestamp: TS,
        },
        // The final prose arrives AFTER the sub-agent ran; the spawn must still
        // sort before it (at the Agent tool_call position).
        { kind: "assistant", text: "done", timestamp: TS, isPartial: false },
      ],
      { collapsed: new Set<string>(), childrenByParent: children }
    );
    const msgs = thread.turns[0].messages;
    const spawnIdx = msgs.findIndex((m) => m.type === "spawn");
    const proseIdx = msgs.findIndex(
      (m) => m.type === "agent" && (m as AgentMessage).prose === "done"
    );
    expect(spawnIdx).toBeGreaterThanOrEqual(0);
    const spawn = msgs[spawnIdx] as SpawnMessage;
    // In-place path: keyed by + labelled from the parent, not the fallback.
    expect(spawn.evt).toBe("toolu_AGENT");
    expect(spawn.thread.label).toBe("Agent");
    expect(spawn.thread.label).not.toBe("subagent");
    // Chronological: spawn sorts BEFORE the trailing prose, not after it.
    expect(spawnIdx).toBeLessThan(proseIdx);
    const childTools = spawn.thread.turns
      .flatMap((t) => t.messages)
      .filter((m) => m.type === "tool") as ToolMessage[];
    expect(childTools.map((t) => t.evt)).toContain("toolu_child");
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
