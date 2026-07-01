import { describe, it, expect, vi } from "vitest";
import {
  buildSpawnOutline,
  isAgentSpawnTool,
  parseToolInput,
  stringValue,
  formatSessionTime,
  formatSessionModel,
  scrollToSpawn,
  LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT,
} from "./sessionListUtils";
import type { ChatMessage } from "../../stores/chatStore";
import type { LocalChatSessionSummary } from "../../utils/localChatPersistence";

function makeToolCallMessage(
  overrides: Partial<
    Extract<ChatMessage, { kind: "tool_call" }>
  > = {}
): Extract<ChatMessage, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    toolName: "agent",
    toolId: "tool-1",
    input: '{"description": "Run tests"}',
    timestamp: "2024-01-01T12:00:00Z",
    ...overrides,
  };
}

function makeSummary(
  overrides: Partial<LocalChatSessionSummary> = {}
): LocalChatSessionSummary {
  return {
    id: "s1",
    label: "Chat",
    harness: "claude",
    preview: "Hello",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    projectPath: null,
    providerResumeId: null,
    messageCount: 1,
    lifecycle: "idle",
    ...overrides,
  };
}

describe("formatSessionTime", () => {
  it("formats a valid date string as 'Mon D'", () => {
    expect(formatSessionTime("2024-06-15T10:00:00Z")).toMatch(
      /^[A-Z][a-z]{2} \d+$/
    );
  });

  it("returns empty string for an invalid date", () => {
    expect(formatSessionTime("not-a-date")).toBe("");
  });

  it("returns empty string for an empty string", () => {
    expect(formatSessionTime("")).toBe("");
  });
});

describe("formatSessionModel", () => {
  it("returns the model name with 'claude-' prefix stripped", () => {
    expect(formatSessionModel(makeSummary({ model: "claude-sonnet-4" }))).toBe(
      "sonnet-4"
    );
  });

  it("falls back to selectedModelId when model is empty", () => {
    expect(
      formatSessionModel(
        makeSummary({ model: undefined, selectedModelId: "gpt-4o" })
      )
    ).toBe("gpt-4o");
  });

  it("returns 'Chat' when neither model nor selectedModelId is set", () => {
    expect(formatSessionModel(makeSummary())).toBe("Chat");
  });

  it("returns 'Chat' when model is whitespace", () => {
    expect(formatSessionModel(makeSummary({ model: "  " }))).toBe("Chat");
  });

  it("trims whitespace from model", () => {
    expect(formatSessionModel(makeSummary({ model: "  sonnet  " }))).toBe(
      "sonnet"
    );
  });
});

describe("isAgentSpawnTool", () => {
  it("returns true for 'agent'", () => {
    expect(isAgentSpawnTool("agent")).toBe(true);
  });

  it("returns true for 'task'", () => {
    expect(isAgentSpawnTool("task")).toBe(true);
  });

  it("returns true for 'Agent' (case-insensitive)", () => {
    expect(isAgentSpawnTool("Agent")).toBe(true);
  });

  it("returns true for 'TASK' (case-insensitive)", () => {
    expect(isAgentSpawnTool("TASK")).toBe(true);
  });

  it("returns false for unrelated tool names", () => {
    expect(isAgentSpawnTool("write")).toBe(false);
    expect(isAgentSpawnTool("read")).toBe(false);
    expect(isAgentSpawnTool("bash")).toBe(false);
  });
});

describe("parseToolInput", () => {
  it("parses valid JSON object input", () => {
    expect(parseToolInput('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("returns empty object for invalid JSON", () => {
    expect(parseToolInput("not-json")).toEqual({});
  });

  it("returns empty object for JSON arrays", () => {
    expect(parseToolInput("[1, 2, 3]")).toEqual({});
  });

  it("returns empty object for JSON primitives", () => {
    expect(parseToolInput("42")).toEqual({});
    expect(parseToolInput("null")).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parseToolInput("")).toEqual({});
  });
});

describe("stringValue", () => {
  it("returns trimmed string for string values", () => {
    expect(stringValue("  hello  ")).toBe("hello");
  });

  it("returns empty string for non-string values", () => {
    expect(stringValue(42)).toBe("");
    expect(stringValue(null)).toBe("");
    expect(stringValue(undefined)).toBe("");
    expect(stringValue({})).toBe("");
    expect(stringValue(true)).toBe("");
  });
});

describe("buildSpawnOutline", () => {
  it("extracts spawn tool calls (agent/task) without parentToolUseId", () => {
    const messages: ChatMessage[] = [
      makeToolCallMessage({
        toolId: "spawn-1",
        toolName: "agent",
        input:
          '{"description": "Run worker", "subagent_type": "worker"}',
      }),
      makeToolCallMessage({
        toolId: "spawn-2",
        toolName: "task",
        input: '{"description": "Run tests"}',
      }),
    ];
    const result = buildSpawnOutline(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "spawn-1",
      spawnId: "spawn-1",
      label: "Run worker",
      detail: "worker",
    });
    expect(result[1]).toEqual({
      id: "spawn-2",
      spawnId: "spawn-2",
      label: "Run tests",
      detail: "task",
    });
  });

  it("renders one child row per named Codex receiver agent", () => {
    const messages: ChatMessage[] = [
      makeToolCallMessage({
        toolId: "spawn-1",
        toolName: "Agent",
        input: JSON.stringify({
          description: "Inspect the feature",
          subagent_type: "gpt-5-codex",
          receiver_agents: [
            {
              thread_id: "019f0000-0000-0000-0000-000000pasteur",
              agent_nickname: "Pasteur",
              agent_role: "reviewer",
            },
            {
              thread_id: "019f0000-0000-0000-0000-000000meitner",
              agent_nickname: "Meitner",
              agent_role: "tester",
            },
          ],
        }),
      }),
    ];

    expect(buildSpawnOutline(messages)).toEqual([
      {
        id: "spawn-1:019f0000-0000-0000-0000-000000pasteur",
        spawnId: "spawn-1",
        label: "Pasteur",
        detail: "reviewer",
      },
      {
        id: "spawn-1:019f0000-0000-0000-0000-000000meitner",
        spawnId: "spawn-1",
        label: "Meitner",
        detail: "tester",
      },
    ]);
  });

  it("uses Codex agent status metadata when receiver agents are not present", () => {
    const messages: ChatMessage[] = [
      makeToolCallMessage({
        toolId: "wait-1",
        toolName: "agent",
        input: JSON.stringify({
          receiver_thread_ids: ["thread-a", "thread-b"],
          agent_statuses: [
            {
              thread_id: "thread-a",
              agent_nickname: "Pasteur",
              status: "completed",
            },
            {
              thread_id: "thread-b",
              agent_nickname: "Meitner",
              status: "running",
            },
          ],
        }),
      }),
    ];

    expect(buildSpawnOutline(messages)).toEqual([
      {
        id: "wait-1:thread-a",
        spawnId: "wait-1",
        label: "Pasteur",
        detail: "completed",
      },
      {
        id: "wait-1:thread-b",
        spawnId: "wait-1",
        label: "Meitner",
        detail: "running",
      },
    ]);
  });

  it("filters out non-spawn tool calls", () => {
    const messages: ChatMessage[] = [
      makeToolCallMessage({ toolId: "t1", toolName: "write" }),
      makeToolCallMessage({ toolId: "t2", toolName: "read" }),
    ];
    expect(buildSpawnOutline(messages)).toHaveLength(0);
  });

  it("filters out calls with parentToolUseId (sub-agent calls)", () => {
    const messages: ChatMessage[] = [
      makeToolCallMessage({
        toolId: "t1",
        toolName: "agent",
        parentToolUseId: "parent-1",
      }),
    ];
    expect(buildSpawnOutline(messages)).toHaveLength(0);
  });

  it("uses 'Agent' as label when description is missing", () => {
    const messages: ChatMessage[] = [
      makeToolCallMessage({
        toolId: "t1",
        toolName: "agent",
        input: '{"subagent_type": "worker"}',
      }),
    ];
    const result = buildSpawnOutline(messages);
    expect(result[0].label).toBe("Agent");
    expect(result[0].detail).toBe("worker");
  });

  it("uses toolName as detail when subagent_type is missing", () => {
    const messages: ChatMessage[] = [
      makeToolCallMessage({
        toolId: "t1",
        toolName: "task",
        input: '{"description": "Do thing"}',
      }),
    ];
    const result = buildSpawnOutline(messages);
    expect(result[0].detail).toBe("task");
  });

  it("returns empty for non-tool-call messages", () => {
    const messages: ChatMessage[] = [
      { kind: "user", text: "hello", timestamp: "2024-01-01T00:00:00Z" },
      {
        kind: "assistant",
        text: "hi",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];
    expect(buildSpawnOutline(messages)).toHaveLength(0);
  });
});

describe("scrollToSpawn", () => {
  it("dispatches a custom event with the session and spawn IDs", () => {
    const handler = vi.fn();
    window.addEventListener(LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT, handler);

    scrollToSpawn("session-1", "spawn-1");

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ sessionId: "session-1", spawnId: "spawn-1" });

    window.removeEventListener(LOCAL_CHAT_SCROLL_TO_SPAWN_EVENT, handler);
  });
});
