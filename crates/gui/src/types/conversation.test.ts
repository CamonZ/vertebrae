import { describe, it, expect } from "vitest";
import {
  parseClaudeMessage,
  parseSessionLogs,
  getToolIcon,
  type ClaudeRawMessage,
} from "./conversation";
import type { SessionLog } from "../bindings";

describe("parseClaudeMessage", () => {
  const timestamp = "2024-01-01T10:00:00Z";

  describe("system messages", () => {
    it("parses system init message into session start event", () => {
      const raw: ClaudeRawMessage = {
        type: "system",
        subtype: "init",
        model: "claude-3-opus",
        session_id: "abc123",
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: "session_start",
        timestamp,
        model: "claude-3-opus",
        sessionId: "abc123",
      });
    });

    it("ignores system messages without init subtype", () => {
      const raw: ClaudeRawMessage = {
        type: "system",
        subtype: "task_notification",
      };

      const events = parseClaudeMessage(raw, timestamp);
      expect(events).toHaveLength(0);
    });
  });

  describe("assistant messages", () => {
    it("parses text content into thinking event", () => {
      const raw: ClaudeRawMessage = {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Let me analyze this..." }],
        },
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: "thinking",
        timestamp,
        text: "Let me analyze this...",
      });
    });

    it("parses tool_use into tool call event", () => {
      const raw: ClaudeRawMessage = {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-123",
              name: "Bash",
              input: { command: "ls -la" },
            },
          ],
        },
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "tool_call",
        timestamp,
        toolId: "tool-123",
        toolName: "Bash",
        displayName: "Bash",
        summary: "ls -la",
      });
    });

    it("parses multiple content items", () => {
      const raw: ClaudeRawMessage = {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First, let me check..." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Read",
              input: { file_path: "/path/to/file.ts" },
            },
          ],
        },
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(2);
      expect(events[0].kind).toBe("thinking");
      expect(events[1].kind).toBe("tool_call");
    });
  });

  describe("user messages", () => {
    it("parses tool_result into tool result event", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-123",
              content: "File contents here...",
              is_error: false,
            },
          ],
        },
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "tool_result",
        timestamp,
        toolUseId: "tool-123",
        isError: false,
      });
    });

    it("handles error tool results", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-123",
              content: "Error: file not found",
              is_error: true,
            },
          ],
        },
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(1);
      expect((events[0] as { isError: boolean }).isError).toBe(true);
    });

    it("handles array content in tool result", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-123",
              content: [{ type: "text", text: "result" }],
            },
          ],
        },
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("tool_result");
    });
  });

  describe("result messages", () => {
    it("parses success result into session end event", () => {
      const raw: ClaudeRawMessage = {
        type: "result",
        subtype: "success",
        duration_ms: 5000,
        num_turns: 10,
        total_cost_usd: 0.05,
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: "session_end",
        timestamp,
        durationMs: 5000,
        numTurns: 10,
        costUsd: 0.05,
      });
    });

    it("ignores non-success result messages", () => {
      const raw: ClaudeRawMessage = {
        type: "result",
        subtype: "error",
      };

      const events = parseClaudeMessage(raw, timestamp);
      expect(events).toHaveLength(0);
    });
  });
});

describe("parseSessionLogs", () => {
  const createLog = (content: string, createdAt: string): SessionLog => ({
    id: "log-1",
    step_execution_id: "exec-1",
    content,
    created_at: createdAt,
  });

  it("parses multiple logs into events", () => {
    const logs: SessionLog[] = [
      createLog(
        JSON.stringify({
          type: "system",
          subtype: "init",
          model: "claude-3",
          session_id: "sess1",
        }),
        "2024-01-01T10:00:00Z"
      ),
      createLog(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello" }] },
        }),
        "2024-01-01T10:00:01Z"
      ),
    ];

    const events = parseSessionLogs(logs);

    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("session_start");
    expect(events[1].kind).toBe("thinking");
  });

  it("skips non-JSON logs", () => {
    const logs: SessionLog[] = [
      createLog("not json", "2024-01-01T10:00:00Z"),
      createLog(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Valid" }] },
        }),
        "2024-01-01T10:00:01Z"
      ),
    ];

    const events = parseSessionLogs(logs);

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("thinking");
  });

  it("returns empty array for empty input", () => {
    const events = parseSessionLogs([]);
    expect(events).toHaveLength(0);
  });
});

describe("getToolIcon", () => {
  it("returns terminal for Bash", () => {
    expect(getToolIcon("Bash")).toBe("terminal");
  });

  it("returns file-text for Read", () => {
    expect(getToolIcon("Read")).toBe("file-text");
  });

  it("returns search for Grep", () => {
    expect(getToolIcon("Grep")).toBe("search");
  });

  it("returns search for warpgrep tools", () => {
    expect(getToolIcon("mcp__morph_mcp__warpgrep_codebase_search")).toBe(
      "search"
    );
  });

  it("returns edit for edit tools", () => {
    expect(getToolIcon("mcp__morph_mcp__edit_file")).toBe("edit");
  });

  it("returns wrench for unknown tools", () => {
    expect(getToolIcon("UnknownTool")).toBe("wrench");
  });
});
