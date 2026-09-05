import { describe, it, expect, vi } from "vitest";
import {
  chatMessagesToThread,
  LOCAL_CHAT_THREAD_ID,
} from "./chatMessagesToThread";
import { conversationEventsToThread } from "../thread/normalize";
import type { ChatMessage } from "../../stores/chatStore";
import type {
  AgentMessage,
  ErrorMessage,
  Message,
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

  it("merges a tool_result that arrives in a LATER turn into its call's card", () => {
    const thread = build([
      { kind: "user", text: "run it", timestamp: TS },
      {
        kind: "tool_call",
        toolName: "Bash",
        toolId: "call-slow",
        input: JSON.stringify({ command: "sleep 99" }),
        timestamp: TS,
      },
      { kind: "user", text: "still there?", timestamp: TS },
      {
        kind: "tool_result",
        toolId: "call-slow",
        result: "finally done",
        isError: false,
        timestamp: TS,
      },
    ]);
    const tool = firstTool(thread.turns[0].messages);
    expect(tool.status).toBe("done");
    expect(tool.body).toBe("finally done");
    // The later turn keeps only its user message — no orphan result row.
    const laterTurn = thread.turns[1];
    expect(laterTurn.messages.filter((m) => m.type !== "user")).toEqual([]);
  });

  it("keeps child-agent events out of the parent chat transcript", () => {
    const thread = build([
      { kind: "user", text: "spawn a helper", timestamp: TS },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "spawn-1",
        input: JSON.stringify({ description: "helper" }),
        timestamp: TS,
      },
      { kind: "user", text: "next question", timestamp: TS },
      {
        kind: "assistant",
        text: "child findings",
        timestamp: TS,
        parentToolUseId: "spawn-1",
      },
      { kind: "assistant", text: "main answer", timestamp: TS },
    ]);
    expect(thread.turns[0].messages.some((m) => m.type === "spawn")).toBe(
      false
    );
    expect(
      thread.turns[0].messages.some(
        (m) => m.type === "tool" && m.evt === "spawn-1"
      )
    ).toBe(true);
    const laterRows = thread.turns[1].messages;
    expect(laterRows.some((m) => m.type === "spawn")).toBe(false);
    expect(
      laterRows.some(
        (m) =>
          m.type === "agent" && (m as AgentMessage).prose === "child findings"
      )
    ).toBe(false);
    const mainProse = laterRows.find((m) => m.type === "agent") as AgentMessage;
    expect(mainProse.prose).toBe("main answer");
  });

  it("keeps realtime agent state metadata on the flat agent spawn row", () => {
    const thread = build([
      { kind: "user", text: "spawn a helper", timestamp: TS },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent:child-thread",
        input: JSON.stringify({
          collab_tool: "spawnAgent",
          receiver_thread_ids: ["child-thread"],
          description: "Repository: /repo\n\nTask: inspect the service crate",
        }),
        timestamp: TS,
      },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent:child-thread",
        input: JSON.stringify({
          collab_tool: "spawnAgent",
          receiver_thread_ids: ["child-thread"],
          agents_states: {
            "child-thread": { status: "running" },
          },
        }),
        timestamp: TS,
      },
      {
        kind: "assistant",
        text: "child is thinking",
        timestamp: TS,
        isPartial: true,
        parentToolUseId: "agent:child-thread",
      },
    ]);

    expect(thread.turns[0].messages.some((m) => m.type === "spawn")).toBe(
      false
    );
    const tool = firstTool(thread.turns[0].messages);
    expect(tool.evt).toBe("agent:child-thread");
    expect(tool.name).toBe("Agent");
    expect(tool.status).toBe("pending");
    expect(
      thread.turns[0].messages.filter(
        (m) => m.type === "tool" && m.evt === "agent:child-thread"
      )
    ).toHaveLength(1);
  });

  it("renders an agent final result as a later flat result tool row", () => {
    const thread = build([
      { kind: "user", text: "spawn a helper", timestamp: TS },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent:child-thread",
        input: JSON.stringify({
          collab_tool: "spawnAgent",
          receiver_thread_ids: ["child-thread"],
        }),
        timestamp: TS,
      },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "agent:child-thread",
        input: JSON.stringify({
          collab_tool: "spawnAgent",
          receiver_thread_ids: ["child-thread"],
          description: "Repository: /repo\n\nTask: inspect the service crate",
          agents_states: {
            "child-thread": { status: "completed" },
          },
        }),
        timestamp: TS,
      },
      {
        kind: "tool_result",
        toolId: "agent:child-thread",
        result: "completed",
        isError: false,
        timestamp: TS,
      },
      { kind: "user", text: "next question", timestamp: TS },
      {
        kind: "tool_call",
        toolName: "Agent Result",
        toolId: "agent:child-thread:result:child-turn",
        input: JSON.stringify({
          collab_tool: "agentResult",
          receiver_thread_ids: ["child-thread"],
        }),
        timestamp: TS,
      },
      {
        kind: "tool_result",
        toolId: "agent:child-thread:result:child-turn",
        result: "Final child report",
        isError: false,
        timestamp: TS,
      },
    ]);

    const spawnRows = thread.turns[0].messages.filter(
      (m) => m.type === "tool" && m.evt === "agent:child-thread"
    ) as ToolMessage[];
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0].status).toBe("done");
    expect(spawnRows[0].body).toBe(
      "Repository: /repo\n\nTask: inspect the service crate"
    );
    const laterRows = thread.turns[1].messages;
    const resultRow = laterRows.find(
      (m) =>
        m.type === "tool" && m.evt === "agent:child-thread:result:child-turn"
    ) as ToolMessage;
    expect(resultRow).toBeDefined();
    expect(resultRow.name).toBe("Agent Result");
    expect(resultRow.status).toBe("done");
    expect(resultRow.body).toBe("Final child report");
    expect(laterRows.some((m) => m.type === "spawn")).toBe(false);
  });

  it("maps a task_notification to an activity row, not a user message", () => {
    const thread = build([
      { kind: "user", text: "q", timestamp: TS },
      {
        kind: "task_notification",
        message: 'Agent "Explore parser" finished',
        timestamp: TS,
      },
      { kind: "assistant", text: "done", timestamp: TS, isPartial: false },
    ]);
    expect(thread.turns).toHaveLength(1);
    const rows = thread.turns[0].messages;
    const activity = rows.find((m) => m.type === "activity");
    expect(activity).toBeDefined();
    expect(activity && "text" in activity ? activity.text : "").toBe(
      'Agent "Explore parser" finished'
    );
    expect(rows.filter((m) => m.type === "user")).toHaveLength(1);
  });

  it("keeps a trailing partial assistant streaming when a task_notification follows it", () => {
    const thread = build([
      { kind: "user", text: "q", timestamp: TS },
      { kind: "assistant", text: "thinking…", timestamp: TS, isPartial: true },
      { kind: "task_notification", message: "Agent finished", timestamp: TS },
    ]);
    const agent = thread.turns[0].messages.find(
      (m) => m.type === "agent"
    ) as AgentMessage;
    expect(agent.streaming).toBe(true);
  });

  it("maps an assistant message to an agent message with a provider speaker + prose", () => {
    const thread = build(
      [
        { kind: "user", text: "q", timestamp: TS },
        {
          kind: "assistant",
          text: "the answer",
          timestamp: TS,
          isPartial: false,
        },
      ],
      { assistantLabel: "Codex" }
    );
    const agent = thread.turns[0].messages[1] as AgentMessage;
    expect(agent.type).toBe("agent");
    expect(agent.speaker).toBe("Codex");
    expect(agent.prose).toBe("the answer");
    expect(agent.streaming ?? false).toBe(false);
  });

  it("preserves item identity and renders interrupted text as plain non-streaming prose", () => {
    const thread = build([
      {
        kind: "assistant",
        itemId: "item-interrupted",
        text: "received text with *literal* markers",
        timestamp: TS,
        isPartial: false,
        lifecycle: "interrupted",
      },
      {
        kind: "assistant",
        itemId: "item-completed",
        text: "**rich completed text**",
        timestamp: TS,
        isPartial: false,
        lifecycle: "completed",
      },
    ]);
    const agents = thread.turns[0].messages.filter(
      (message): message is AgentMessage => message.type === "agent"
    );

    expect(agents[0]).toMatchObject({
      itemId: "item-interrupted",
      lifecycle: "interrupted",
      proseFormat: "plain",
      streaming: false,
      prose: "received text with *literal* markers",
    });
    expect(agents[1]).toMatchObject({
      itemId: "item-completed",
      lifecycle: "completed",
      prose: "**rich completed text**",
    });
    expect(agents[1].proseFormat).toBeUndefined();
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
      {
        kind: "tool_result",
        toolId: "t1",
        result: "file body",
        isError: false,
        timestamp: TS,
      },
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
      {
        kind: "tool_result",
        toolId: "t1",
        result: "boom",
        isError: true,
        timestamp: TS,
      },
    ]);
    const tool = firstTool(thread.turns[0].messages);
    expect(tool.status).toBe("err");
    expect(tool.error).toBe(true);
    expect(tool.body).toBe("boom");
  });

  it("renders a structured file edit once and hides its generic tool lifecycle", () => {
    const thread = build([
      { kind: "user", text: "edit it", timestamp: TS },
      {
        kind: "tool_call",
        toolName: "Edit",
        toolId: "file-1",
        input: JSON.stringify({ file_path: "/repo/src/lib.ts" }),
        timestamp: TS,
      },
      {
        kind: "tool_result",
        toolId: "file-1",
        result: "ok",
        isError: false,
        timestamp: TS,
      },
      {
        kind: "file_edit",
        toolId: "file-1",
        status: "completed",
        changes: [
          {
            path: "src/lib.ts",
            kind: "update",
            diff: "@@\n-old\n+new",
          },
        ],
        timestamp: TS,
      },
    ]);
    const tools = thread.turns[0].messages.filter((m) => m.type === "tool");
    expect(tools).toHaveLength(1);
    expect((tools[0] as ToolMessage).evt).toBe("file-1");
    expect((tools[0] as ToolMessage).cmd).toBe("apply_patch");
    expect((tools[0] as ToolMessage).body).toContain("+new");
    expect((tools[0] as ToolMessage).status).toBe("done");
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

  it("preserves the complete Bash command for pending and completed calls", () => {
    const command = `bash -lc '${"echo long-command ".repeat(12)}--final-argument'`;
    const pending = build([
      {
        kind: "tool_call",
        toolName: "Bash",
        toolId: "pending-bash",
        input: JSON.stringify({ command }),
        timestamp: TS,
      },
    ]);
    const completed = build([
      {
        kind: "tool_call",
        toolName: "Bash",
        toolId: "completed-bash",
        input: JSON.stringify({ command }),
        timestamp: TS,
      },
      {
        kind: "tool_result",
        toolId: "completed-bash",
        result: "command output",
        isError: false,
        timestamp: TS,
      },
    ]);

    const pendingTool = firstTool(pending.turns[0].messages);
    const completedTool = firstTool(completed.turns[0].messages);
    expect(pendingTool.cmd).toBe(command);
    expect(pendingTool.status).toBe("pending");
    expect(completedTool.cmd).toBe(command);
    expect(completedTool.status).toBe("done");
    expect(completedTool.body).toBe("command output");
  });

  it("keeps the same complete Bash command for replayed normalized events", () => {
    const command = `${"/usr/bin/tool --input ".repeat(10)}replayed-final-argument`;
    const replayed = conversationEventsToThread([
      {
        kind: "tool_call",
        toolId: "replayed-bash",
        toolName: "Bash",
        displayName: "Bash",
        icon: "terminal",
        summary: command.slice(0, 80) + "…",
        input: { command },
        timestamp: TS,
      },
      {
        kind: "tool_result",
        toolUseId: "replayed-bash",
        result: "replayed output",
        isError: false,
        timestamp: TS,
      },
    ]);

    const tool = firstTool(replayed.turns[0].messages);
    expect(tool.cmd).toBe(command);
    expect(tool.status).toBe("done");
    expect(tool.body).toBe("replayed output");
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
    expect(a.proseFormat).toBe("plain");

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

  it("drops spawned agent work rows from the parent chat transcript", () => {
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
      {
        kind: "assistant",
        text: "child analysis",
        timestamp: TS,
        isPartial: false,
        parentToolUseId: "toolu_AGENT",
      },
    ]);
    const msgs = thread.turns[0].messages;

    expect(msgs.some((m) => m.type === "tool" && m.evt === "toolu_AGENT")).toBe(
      true
    );
    expect(msgs.some((m) => m.type === "spawn")).toBe(false);
    expect(msgs.some((m) => m.type === "tool" && m.evt === "toolu_child")).toBe(
      false
    );
    expect(
      msgs.some((m) => m.type === "agent" && m.prose === "child analysis")
    ).toBe(false);
  });

  it("does not redirect non-spawn agent control output into the parent transcript", () => {
    const thread = build([
      { kind: "assistant", text: "spawning", timestamp: TS, isPartial: false },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "spawn-1",
        input: JSON.stringify({
          collab_tool: "spawnAgent",
          agent_nickname: "Hegel",
          receiver_thread_ids: ["thread-hegel"],
        }),
        timestamp: TS,
      },
      {
        kind: "tool_call",
        toolName: "agent",
        toolId: "wait-1",
        input: JSON.stringify({
          collab_tool: "wait_agent",
          receiver_thread_ids: ["thread-hegel"],
        }),
        timestamp: TS,
      },
      {
        kind: "tool_result",
        toolId: "wait-1",
        result: "waited",
        isError: false,
        timestamp: TS,
      },
      {
        kind: "assistant",
        text: "waited child output",
        timestamp: TS,
        isPartial: false,
        parentToolUseId: "wait-1",
      },
    ]);

    const msgs = thread.turns[0].messages;
    expect(msgs.some((m) => m.type === "tool" && m.evt === "spawn-1")).toBe(
      true
    );
    expect(msgs.some((m) => m.evt === "wait-1")).toBe(false);
    expect(
      msgs.some((m) => m.type === "agent" && m.prose === "waited child output")
    ).toBe(false);
  });

  it("keeps the spawn flat when child prose has a parent id and metadata includes a nickname", () => {
    const thread = build([
      { kind: "assistant", text: "spawning", timestamp: TS, isPartial: false },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "toolu_AGENT",
        input: JSON.stringify({
          description: "Review diff",
          agent_nickname: "Faraday",
          receiver_thread_ids: ["thread-faraday"],
        }),
        timestamp: TS,
      },
      {
        kind: "assistant",
        text: "child analysis",
        timestamp: TS,
        isPartial: false,
        parentToolUseId: "toolu_AGENT",
      },
    ]);

    const msgs = thread.turns[0].messages;
    expect(msgs.some((m) => m.type === "spawn")).toBe(false);
    expect(msgs.some((m) => m.type === "tool" && m.evt === "toolu_AGENT")).toBe(
      true
    );
    expect(
      msgs.some((m) => m.type === "agent" && m.prose === "child analysis")
    ).toBe(false);
  });

  it("keeps the spawn flat when a child agent id is present", () => {
    const thread = build([
      { kind: "assistant", text: "spawning", timestamp: TS, isPartial: false },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "toolu_AGENT",
        input: JSON.stringify({
          description:
            "Inspect /Users/camonz/Code/code_intelligence/vertebrae/crates/core",
          receiver_thread_ids: ["019f1cae-6fb7-7d83-b4c0-5f65c0bd3880"],
        }),
        timestamp: TS,
      },
      {
        kind: "assistant",
        text: "child analysis",
        timestamp: TS,
        isPartial: false,
        parentToolUseId: "toolu_AGENT",
      },
    ]);

    const msgs = thread.turns[0].messages;
    expect(msgs.some((m) => m.type === "spawn")).toBe(false);
    expect(msgs.some((m) => m.type === "tool" && m.evt === "toolu_AGENT")).toBe(
      true
    );
    expect(
      msgs.some((m) => m.type === "agent" && m.prose === "child analysis")
    ).toBe(false);
  });

  it("keeps the spawn marker before trailing main-thread prose without child transcript rows", () => {
    const thread = build([
      {
        kind: "assistant",
        text: "spawning",
        timestamp: TS,
        isPartial: false,
      },
      {
        kind: "tool_call",
        toolName: "Agent",
        toolId: "toolu_AGENT",
        input: '{"description":"Explore"}',
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
        result: "child body",
        isError: false,
        timestamp: TS,
        parentToolUseId: "toolu_AGENT",
      },
      { kind: "assistant", text: "done", timestamp: TS, isPartial: false },
    ]);
    const msgs = thread.turns[0].messages;
    const spawnIdx = msgs.findIndex(
      (m) => m.type === "tool" && m.evt === "toolu_AGENT"
    );
    const proseIdx = msgs.findIndex(
      (m) => m.type === "agent" && (m as AgentMessage).prose === "done"
    );
    expect(spawnIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeLessThan(proseIdx);

    expect(msgs.some((m) => m.type === "spawn")).toBe(false);
    expect(msgs.some((m) => m.type === "tool" && m.evt === "toolu_child")).toBe(
      false
    );
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
