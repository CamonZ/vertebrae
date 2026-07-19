import { describe, it, expect } from "vitest";
import {
  parseClaudeMessage,
  parseCodexMessage,
  parseCodexRolloutMessage,
  parseSessionLogs,
  getToolIcon,
  type ClaudeRawMessage,
  type CodexRolloutRawMessage,
  type CodexParseState,
  type CodexRawMessage,
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

    it("ignores unknown system subtypes", () => {
      const raw: ClaudeRawMessage = {
        type: "system",
        subtype: "hook_started",
      };

      const events = parseClaudeMessage(raw, timestamp);
      expect(events).toHaveLength(0);
    });
  });

  describe("assistant messages", () => {
    it("parses text content into assistant_message event", () => {
      const raw: ClaudeRawMessage = {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Let me analyze this..." }],
        },
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: "assistant_message",
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

    it("normalizes Claude Edit and Write tool lifecycles into file_edit events", () => {
      const logs: SessionLog[] = [
        {
          id: "claude-edit",
          step_execution_id: "claude-exec",
          content: JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "edit-1",
                  name: "Edit",
                  input: {
                    file_path: "src/lib.ts",
                    old_string: "old",
                    new_string: "new",
                  },
                },
                {
                  type: "tool_use",
                  id: "write-1",
                  name: "Write",
                  input: { file_path: "src/new.ts", content: "export {}" },
                },
              ],
            },
          }),
          created_at: timestamp,
        },
        {
          id: "claude-results",
          step_execution_id: "claude-exec",
          content: JSON.stringify({
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: "edit-1", content: "ok" },
                { type: "tool_result", tool_use_id: "write-1", content: "ok" },
              ],
            },
          }),
          created_at: timestamp,
        },
      ];

      const edits = parseSessionLogs(logs).filter(
        (event) => event.kind === "file_edit"
      );
      expect(edits).toHaveLength(2);
      expect(edits).toMatchObject([
        {
          toolId: "edit-1",
          status: "completed",
          changes: [
            {
              path: "src/lib.ts",
              kind: "update",
              diff: expect.stringContaining("+new"),
            },
          ],
        },
        {
          toolId: "write-1",
          status: "completed",
          changes: [{ path: "src/new.ts", kind: "add" }],
        },
      ]);
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
      expect(events[0].kind).toBe("assistant_message");
      expect(events[1].kind).toBe("tool_call");
    });
  });

  describe("user messages", () => {
    it("can include user text for full transcript replay", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        message: {
          role: "user",
          content: "hello",
        },
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([]);
      expect(
        parseClaudeMessage(raw, timestamp, { includeUserMessages: true })
      ).toEqual([{ kind: "user_message", timestamp, text: "hello" }]);
    });

    it("skips injected AGENTS.md instruction prompts during transcript replay", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        message: {
          role: "user",
          content: "# AGENTS.md instructions for /repo\nDo things",
        },
      };

      expect(
        parseClaudeMessage(raw, timestamp, { includeUserMessages: true })
      ).toEqual([]);
    });

    it("skips harness-injected isMeta user lines during transcript replay", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: "Base directory for this skill: /repo/.claude/skills/x",
        },
      };

      expect(
        parseClaudeMessage(raw, timestamp, { includeUserMessages: true })
      ).toEqual([]);
    });

    it("maps task-notification user lines to task_notification, not user_message", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>abc123</task-id>\n" +
            "<status>completed</status>\n" +
            '<summary>Agent "Explore parser" finished</summary>\n' +
            "<result>Long subagent report body</result>\n</task-notification>",
        },
      };

      expect(
        parseClaudeMessage(raw, timestamp, { includeUserMessages: true })
      ).toEqual([
        {
          kind: "task_notification",
          timestamp,
          message: 'Agent "Explore parser" finished',
        },
      ]);
    });

    it("falls back to <status> when a task notification has no summary", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        message: {
          role: "user",
          content:
            "<task-notification><task-id>abc</task-id><status>completed</status></task-notification>",
        },
      };

      expect(
        parseClaudeMessage(raw, timestamp, { includeUserMessages: true })
      ).toEqual([
        { kind: "task_notification", timestamp, message: "completed" },
      ]);
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

  describe("subagent linkage (parent_tool_use_id)", () => {
    it("threads top-level parent_tool_use_id onto every emitted event", () => {
      const raw: ClaudeRawMessage = {
        type: "assistant",
        parent_tool_use_id: "spawn-tool-1",
        message: {
          content: [
            { type: "text", text: "subagent thinking" },
            {
              type: "tool_use",
              id: "child-tool-9",
              name: "Read",
              input: { file_path: "/a.ts" },
            },
          ],
        },
      };

      const events = parseClaudeMessage(raw, timestamp);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        kind: "assistant_message",
        parentToolUseId: "spawn-tool-1",
      });
      expect(events[1]).toMatchObject({
        kind: "tool_call",
        toolId: "child-tool-9",
        parentToolUseId: "spawn-tool-1",
      });
    });

    it("threads parent_tool_use_id onto a subagent's tool_result event", () => {
      const raw: ClaudeRawMessage = {
        type: "user",
        parent_tool_use_id: "spawn-tool-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "child-tool-9",
              content: "ok",
              is_error: false,
            },
          ],
        },
      };

      const [ev] = parseClaudeMessage(raw, timestamp);
      expect(ev).toMatchObject({
        kind: "tool_result",
        parentToolUseId: "spawn-tool-1",
      });
    });

    it("leaves parentToolUseId undefined when parent_tool_use_id is absent or null", () => {
      const absent: ClaudeRawMessage = {
        type: "assistant",
        message: { content: [{ type: "text", text: "main agent" }] },
      };
      const nulled: ClaudeRawMessage = {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "main agent" }] },
      };

      for (const raw of [absent, nulled]) {
        const [ev] = parseClaudeMessage(raw, timestamp);
        expect(ev.parentToolUseId).toBeUndefined();
        expect(ev).not.toHaveProperty("parentToolUseId");
      }
    });
  });

  describe("Claude Code 2.1 live stream events", () => {
    it("parses thinking_tokens into a heartbeat event", () => {
      const raw: ClaudeRawMessage = {
        type: "system",
        subtype: "thinking_tokens",
        session_id: "sess-1",
        estimated_tokens: 2333,
        estimated_tokens_delta: 23,
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([
        {
          kind: "thinking_heartbeat",
          timestamp,
          sessionId: "sess-1",
          estimatedTokens: 2333,
          estimatedTokensDelta: 23,
        },
      ]);
    });

    it("parses task_progress into a subagent activity event keyed by tool_use_id", () => {
      const raw: ClaudeRawMessage = {
        type: "system",
        subtype: "task_progress",
        task_id: "task-a",
        tool_use_id: "toolu_spawn",
        description: "Reading crates/gui/src/types/conversation.ts",
        subagent_type: "general-purpose",
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([
        {
          kind: "task_progress",
          timestamp,
          toolUseId: "toolu_spawn",
          taskId: "task-a",
          description: "Reading crates/gui/src/types/conversation.ts",
          subagentType: "general-purpose",
          parentToolUseId: "toolu_spawn",
        },
      ]);
    });

    it("skips malformed task_progress without tool_use_id", () => {
      const raw: ClaudeRawMessage = {
        type: "system",
        subtype: "task_progress",
        description: "Reading a file",
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([]);
    });

    it("parses task_started into a subagent start event", () => {
      const raw: ClaudeRawMessage = {
        type: "system",
        subtype: "task_started",
        task_id: "task-a",
        tool_use_id: "toolu_spawn",
        description: "Reviewing GUI stream parsing",
        subagent_type: "general-purpose",
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([
        {
          kind: "task_started",
          timestamp,
          toolUseId: "toolu_spawn",
          taskId: "task-a",
          description: "Reviewing GUI stream parsing",
          subagentType: "general-purpose",
          parentToolUseId: "toolu_spawn",
        },
      ]);
    });

    it("parses system task_notification into a notification event", () => {
      const raw: ClaudeRawMessage = {
        type: "system",
        subtype: "task_notification",
        message: "Subagent completed review",
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([
        {
          kind: "task_notification",
          timestamp,
          message: "Subagent completed review",
        },
      ]);
    });

    it("parses top-level task_notification into a notification event", () => {
      const raw: ClaudeRawMessage = {
        type: "task_notification",
        message: "Subagent completed review",
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([
        {
          kind: "task_notification",
          timestamp,
          message: "Subagent completed review",
        },
      ]);
    });

    it("suppresses an allowed rate_limit_event", () => {
      const raw: ClaudeRawMessage = {
        type: "rate_limit_event",
        session_id: "sess-1",
        rate_limit_info: {
          status: "allowed",
          resetsAt: 1781128800,
          rateLimitType: "five_hour",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled",
          isUsingOverage: false,
        },
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([]);
    });

    it("parses a rejected rate_limit_event into a banner event", () => {
      const raw: ClaudeRawMessage = {
        type: "rate_limit_event",
        session_id: "sess-1",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
        },
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([
        {
          kind: "rate_limit",
          timestamp,
          sessionId: "sess-1",
          status: "rejected",
          resetsAt: undefined,
          rateLimitType: "five_hour",
          overageStatus: undefined,
          overageDisabledReason: undefined,
          isUsingOverage: undefined,
        },
      ]);
    });

    it("suppresses a malformed rate_limit_event without throwing", () => {
      const raw: ClaudeRawMessage = {
        type: "rate_limit_event",
        session_id: "sess-1",
      };

      expect(parseClaudeMessage(raw, timestamp)).toEqual([]);
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
    expect(events[1].kind).toBe("assistant_message");
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
    expect(events[0].kind).toBe("assistant_message");
  });

  it("returns empty array for empty input", () => {
    const events = parseSessionLogs([]);
    expect(events).toHaveLength(0);
  });

  it("collapses repeated Claude live snapshots by logical identity", () => {
    const logs: SessionLog[] = [
      createLog(
        JSON.stringify({
          type: "system",
          subtype: "thinking_tokens",
          session_id: "sess-1",
          estimated_tokens: 10,
          estimated_tokens_delta: 10,
        }),
        "2024-01-01T10:00:00Z"
      ),
      createLog(
        JSON.stringify({
          type: "system",
          subtype: "thinking_tokens",
          session_id: "sess-1",
          estimated_tokens: 42,
          estimated_tokens_delta: 5,
        }),
        "2024-01-01T10:00:01Z"
      ),
      createLog(
        JSON.stringify({
          type: "system",
          subtype: "task_progress",
          tool_use_id: "toolu_spawn",
          description: "Reading a.ts",
        }),
        "2024-01-01T10:00:02Z"
      ),
      createLog(
        JSON.stringify({
          type: "system",
          subtype: "task_progress",
          tool_use_id: "toolu_spawn",
          description: "Reading b.ts",
        }),
        "2024-01-01T10:00:03Z"
      ),
    ];

    const events = parseSessionLogs(logs);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "thinking_heartbeat",
      estimatedTokens: 42,
    });
    expect(events[1]).toMatchObject({
      kind: "task_progress",
      toolUseId: "toolu_spawn",
      description: "Reading b.ts",
    });
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

// ============================================================================
// Codex JSONL parser tests
// ============================================================================

describe("parseCodexMessage", () => {
  const timestamp = "2024-01-02T08:00:00Z";

  const newState = (): CodexParseState => ({
    turnCount: 0,
    todoListByItemId: new Map(),
    fileEditByItemId: new Map(),
  });

  it("maps thread.started to a session_start event with the thread_id and a 'codex' model", () => {
    // Per upstream schema, ThreadStartedEvent carries only `thread_id`; there
    // is no model field on the event itself, so the parser hard-codes "codex".
    const raw: CodexRawMessage = {
      type: "thread.started",
      thread_id: "thr-42",
    };
    const events = parseCodexMessage(raw, timestamp, newState());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "session_start",
      timestamp,
      model: "codex",
      sessionId: "thr-42",
    });
  });

  it("emits an empty sessionId when thread.started omits thread_id", () => {
    const events = parseCodexMessage(
      { type: "thread.started" },
      timestamp,
      newState()
    );
    expect(events[0]).toMatchObject({
      kind: "session_start",
      model: "codex",
      sessionId: "",
    });
  });

  it("turn.started increments the turn count without emitting events", () => {
    const state = newState();
    expect(
      parseCodexMessage({ type: "turn.started" }, timestamp, state)
    ).toEqual([]);
    expect(
      parseCodexMessage({ type: "turn.started" }, timestamp, state)
    ).toEqual([]);
    expect(state.turnCount).toBe(2);
  });

  it("turn.completed emits no events", () => {
    const state = newState();
    const events = parseCodexMessage(
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 50,
        },
      },
      timestamp,
      state
    );
    expect(events).toEqual([]);
  });

  it("maps reasoning item.completed to a thinking event with the item text", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: { id: "i1", type: "reasoning", text: "Considering the problem" },
      },
      timestamp,
      newState()
    );
    expect(events).toEqual([
      { kind: "thinking", timestamp, text: "Considering the problem" },
    ]);
  });

  it("maps agent_message item.completed to a dedicated assistant_message event (not thinking)", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: { id: "m1", type: "agent_message", text: "Done!" },
      },
      timestamp,
      newState()
    );
    expect(events).toEqual([
      { kind: "assistant_message", timestamp, text: "Done!" },
    ]);
  });

  it("drops reasoning/agent_message items with empty text", () => {
    expect(
      parseCodexMessage(
        {
          type: "item.completed",
          item: { id: "i", type: "reasoning", text: "" },
        },
        timestamp,
        newState()
      )
    ).toEqual([]);
    expect(
      parseCodexMessage(
        {
          type: "item.completed",
          item: { id: "m", type: "agent_message", text: "" },
        },
        timestamp,
        newState()
      )
    ).toEqual([]);
  });

  it("maps mcp_tool_call item.completed to tool_call(mcp__server__tool, arguments) + tool_result", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: {
          id: "mcp1",
          type: "mcp_tool_call",
          server: "morph_mcp",
          tool: "edit_file",
          arguments: { path: "/tmp/foo.txt", content: "hello" },
          result: { ok: true, bytes: 5 },
        },
      },
      timestamp,
      newState()
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      toolId: "mcp1",
      toolName: "mcp__morph_mcp__edit_file",
      displayName: "edit file",
      input: { path: "/tmp/foo.txt", content: "hello" },
    });
    expect(events[1]).toMatchObject({
      kind: "tool_result",
      toolUseId: "mcp1",
      isError: false,
      result: '{"ok":true,"bytes":5}',
    });
  });

  it("flags mcp_tool_call with an error string as is_error and surfaces the message", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: {
          id: "mcp2",
          type: "mcp_tool_call",
          server: "morph_mcp",
          tool: "edit_file",
          arguments: { path: "/etc/passwd" },
          error: "permission denied",
        },
      },
      timestamp,
      newState()
    );
    expect(events[1]).toEqual({
      kind: "tool_result",
      timestamp,
      toolUseId: "mcp2",
      isError: true,
      result: "permission denied",
    });
  });

  it("maps web_search item.completed to a WebSearch tool_call with {query, action} + tool_result", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: {
          id: "ws1",
          type: "web_search",
          query: "rust async traits",
          action: "search",
          result: ["doc1", "doc2"],
        },
      },
      timestamp,
      newState()
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      toolId: "ws1",
      toolName: "WebSearch",
      displayName: "WebSearch",
      summary: "rust async traits",
      input: { query: "rust async traits", action: "search" },
    });
    expect(events[1]).toMatchObject({
      kind: "tool_result",
      toolUseId: "ws1",
      isError: false,
      result: '["doc1","doc2"]',
    });
  });

  it("maps file_change item.completed to a file_edit event carrying the changes and status", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: {
          id: "fc1",
          type: "file_change",
          status: "completed",
          changes: [
            {
              path: "src/foo.rs",
              kind: "update",
              diff: "@@ -1 +1 @@\n-old\n+new",
            },
            { path: "src/bar.rs", kind: "add", diff: "+++ b/src/bar.rs" },
          ],
        },
      },
      timestamp,
      newState()
    );
    expect(events).toEqual([
      {
        kind: "file_edit",
        timestamp,
        toolId: "fc1",
        status: "completed",
        changes: [
          {
            path: "src/foo.rs",
            kind: "update",
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
          { path: "src/bar.rs", kind: "add", diff: "+++ b/src/bar.rs" },
        ],
      },
    ]);
  });

  it("replaces a started file_change item with its completed snapshot", () => {
    const logs: SessionLog[] = [
      {
        id: "codex-file-start",
        step_execution_id: "codex-file-exec",
        content: JSON.stringify({
          type: "item.started",
          item: {
            id: "fc-live",
            type: "fileChange",
            status: "inProgress",
            changes: [{ path: "src/live.ts", kind: "update", diff: "@@" }],
          },
        }),
        created_at: timestamp,
      },
      {
        id: "codex-file-complete",
        step_execution_id: "codex-file-exec",
        content: JSON.stringify({
          type: "item.completed",
          item: {
            id: "fc-live",
            type: "fileChange",
            status: "completed",
            changes: [
              { path: "src/live.ts", kind: "update", diff: "@@\n-old\n+new" },
            ],
          },
        }),
        created_at: timestamp,
      },
    ];
    expect(parseSessionLogs(logs)).toMatchObject([
      {
        kind: "file_edit",
        toolId: "fc-live",
        status: "completed",
        changes: [{ path: "src/live.ts", diff: "@@\n-old\n+new" }],
      },
    ]);
  });

  it("drops file_change items with no changes silently", () => {
    expect(
      parseCodexMessage(
        {
          type: "item.completed",
          item: {
            id: "fc-empty",
            type: "file_change",
            status: "completed",
            changes: [],
          },
        },
        timestamp,
        newState()
      )
    ).toEqual([]);
  });

  it("emits a fresh todo_list event for each item.started / item.updated (parseSessionLogs dedupes by id)", () => {
    const state = newState();
    const startEvents = parseCodexMessage(
      {
        type: "item.started",
        item: {
          id: "plan-1",
          type: "todo_list",
          items: [
            { text: "step a", completed: false },
            { text: "step b", completed: false },
          ],
        },
      },
      timestamp,
      state
    );
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({
      kind: "todo_list",
      itemId: "plan-1",
      items: [
        { text: "step a", completed: false },
        { text: "step b", completed: false },
      ],
    });

    const updateEvents = parseCodexMessage(
      {
        type: "item.updated",
        item: {
          id: "plan-1",
          type: "todo_list",
          items: [
            { text: "step a", completed: true },
            { text: "step b", completed: false },
            { text: "step c", completed: false },
          ],
        },
      },
      "2024-01-02T08:00:01Z",
      state
    );
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0]).toMatchObject({
      kind: "todo_list",
      itemId: "plan-1",
      timestamp: "2024-01-02T08:00:01Z",
      items: [
        { text: "step a", completed: true },
        { text: "step b", completed: false },
        { text: "step c", completed: false },
      ],
    });
    expect(updateEvents[0]).not.toBe(startEvents[0]);
    expect(startEvents[0]).toMatchObject({
      timestamp,
      items: [
        { text: "step a", completed: false },
        { text: "step b", completed: false },
      ],
    });
  });

  it("emits a tool_call for collab_tool_call so the spawn shows as the parent tool", () => {
    // Best-effort spawn handling: the parent tool surfaces, but child linkage
    // (parentToolUseId on the subagent's events) is intentionally NOT set —
    // the upstream child-linkage shape is unverified. See parseCodexMessage.
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: {
          id: "ct1",
          type: "collab_tool_call",
        },
      },
      timestamp,
      newState()
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      toolId: "ct1",
      toolName: "subagent",
    });
    // No child linkage is fabricated.
    expect(events[0]).not.toHaveProperty("parentToolUseId");
  });

  it("maps command_execution item.completed to a tool_call followed by tool_result", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: {
          id: "c1",
          type: "command_execution",
          command: "ls -la",
          exit_code: 0,
          aggregated_output: "total 8\nfoo bar",
        },
      },
      timestamp,
      newState()
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      kind: "tool_call",
      timestamp,
      toolId: "c1",
      toolName: "Bash",
      displayName: "Bash",
      icon: getToolIcon("Bash"),
      summary: "ls -la",
      input: { command: "ls -la" },
    });
    expect(events[1]).toEqual({
      kind: "tool_result",
      timestamp,
      toolUseId: "c1",
      isError: false,
      // full output with newlines preserved — rendered in a scrollable card.
      result: "total 8\nfoo bar",
    });
  });

  it("flags command_execution as is_error when exit_code is non-zero", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: {
          id: "c2",
          type: "command_execution",
          command: "false",
          exit_code: 1,
          aggregated_output: "boom",
        },
      },
      timestamp,
      newState()
    );
    expect(events[1]).toMatchObject({ kind: "tool_result", isError: true });
  });

  it("ignores item.started entirely (events come from item.completed)", () => {
    expect(
      parseCodexMessage(
        {
          type: "item.started",
          item: { id: "i1", type: "reasoning", text: "..." },
        },
        timestamp,
        newState()
      )
    ).toEqual([]);
  });

  it("ignores item.updated streaming markers (final state arrives on item.completed)", () => {
    expect(
      parseCodexMessage(
        {
          type: "item.updated",
          item: { id: "m1", type: "agent_message", text: "partial..." },
        },
        timestamp,
        newState()
      )
    ).toEqual([]);
  });

  it("ignores unknown item types so future Codex item kinds don't break the timeline", () => {
    expect(
      parseCodexMessage(
        {
          type: "item.completed",
          item: { id: "x", type: "future_kind_we_dont_know", text: "?" },
        },
        timestamp,
        newState()
      )
    ).toEqual([]);
  });

  it("turn.failed surfaces the error message as a thinking event prefixed with [error]", () => {
    const events = parseCodexMessage(
      { type: "turn.failed", error: { message: "rate limit exceeded" } },
      timestamp,
      newState()
    );
    expect(events).toEqual([
      { kind: "thinking", timestamp, text: "[error] rate limit exceeded" },
    ]);
  });

  it("turn.failed without a message still produces a thinking event with a sane fallback", () => {
    const events = parseCodexMessage(
      { type: "turn.failed" },
      timestamp,
      newState()
    );
    expect(events[0]).toMatchObject({
      kind: "thinking",
      text: "[error] turn failed",
    });
  });

  it("top-level `error` event surfaces the message as [error] thinking and emits a session_end", () => {
    // ThreadErrorEvent shape: `{"type":"error","message":"..."}`. This is the
    // upstream replacement for the (non-existent) `thread.failed` event.
    const state = newState();
    parseCodexMessage({ type: "turn.started" }, timestamp, state);
    const events = parseCodexMessage(
      { type: "error", message: "sandbox denied" },
      timestamp,
      state
    );
    expect(events).toEqual([
      { kind: "thinking", timestamp, text: "[error] sandbox denied" },
      {
        kind: "session_end",
        timestamp,
        durationMs: 0,
        numTurns: 1,
        costUsd: 0,
      },
    ]);
  });

  it("top-level `error` without a message uses a sane fallback", () => {
    const events = parseCodexMessage({ type: "error" }, timestamp, newState());
    expect(events[0]).toMatchObject({
      kind: "thinking",
      text: "[error] codex error",
    });
    expect(events[1]).toMatchObject({ kind: "session_end" });
  });
});

describe("parseCodexRolloutMessage", () => {
  const timestamp = "2024-01-02T08:00:00Z";

  it("can include user response_item messages for full transcript replay", () => {
    const raw: CodexRolloutRawMessage = {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello codex" }],
      },
    };

    expect(parseCodexRolloutMessage(raw, timestamp)).toEqual([]);
    expect(
      parseCodexRolloutMessage(raw, timestamp, { includeUserMessages: true })
    ).toEqual([{ kind: "user_message", timestamp, text: "hello codex" }]);
  });

  describe("subagent_notification user messages", () => {
    const notificationRaw = (body: string): CodexRolloutRawMessage => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `<subagent_notification>\n${body}\n</subagent_notification>`,
          },
        ],
      },
    });

    it("maps a non-completion scalar status to a task_notification, never raw XML", () => {
      const raw = notificationRaw(
        '{"agent_path":"agent-1","status":"shutdown"}'
      );
      expect(
        parseCodexRolloutMessage(raw, timestamp, { includeUserMessages: true })
      ).toEqual([
        { kind: "task_notification", timestamp, message: "Subagent shutdown" },
      ]);
    });

    it("maps a non-completion object status to a task_notification with detail", () => {
      const raw = notificationRaw(
        '{"agent_path":"agent-1","status":{"failed":"crashed hard"}}'
      );
      expect(
        parseCodexRolloutMessage(raw, timestamp, { includeUserMessages: true })
      ).toEqual([
        {
          kind: "task_notification",
          timestamp,
          message: "Subagent failed: crashed hard",
        },
      ]);
    });

    it("falls back to a generic notice for an unparseable body instead of a user message", () => {
      const raw = notificationRaw("not json at all");
      expect(
        parseCodexRolloutMessage(raw, timestamp, { includeUserMessages: true })
      ).toEqual([
        {
          kind: "task_notification",
          timestamp,
          message: "Subagent notification",
        },
      ]);
    });

    it("leaves an assistant message QUOTING the tag untouched", () => {
      const raw: CodexRolloutRawMessage = {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: 'The harness wraps updates in <subagent_notification>{"agent_path":"agent-1","status":{"completed":"x"}}</subagent_notification> tags.',
            },
          ],
        },
      };
      const events = parseCodexRolloutMessage(raw, timestamp);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("assistant_message");
    });
  });

  it("presents exec_command function calls as the Bash shell card with the command line", () => {
    const [event] = parseCodexRolloutMessage(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-exec",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "cargo test --quiet",
            workdir: "/repo",
            max_output_tokens: 1024,
          }),
        },
      },
      timestamp
    );
    expect(event).toMatchObject({
      kind: "tool_call",
      toolId: "call-exec",
      toolName: "Bash",
      summary: "cargo test --quiet",
    });
    expect(event.kind === "tool_call" ? event.input.command : undefined).toBe(
      "cargo test --quiet"
    );
  });

  it("maps assistant messages and function calls from Codex rollout JSONL", () => {
    const events = [
      parseCodexRolloutMessage(
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: '{"cmd":"pwd"}',
          },
        },
        timestamp
      ),
      parseCodexRolloutMessage(
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "ok",
          },
        },
        timestamp
      ),
      parseCodexRolloutMessage(
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        },
        timestamp
      ),
    ].flat();

    expect(events.map((event) => event.kind)).toEqual([
      "tool_call",
      "tool_result",
      "assistant_message",
    ]);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      toolId: "call-1",
      // exec_command presents as the shared Bash shell card.
      toolName: "Bash",
      input: { cmd: "pwd", command: "pwd" },
    });
    expect(events[1]).toMatchObject({
      kind: "tool_result",
      toolUseId: "call-1",
      result: "ok",
    });
    expect(events[2]).toMatchObject({
      kind: "assistant_message",
      text: "done",
    });
  });

  // Fixtures below are trimmed/sanitized from real files under
  // ~/.codex/sessions/**/*.jsonl -- paths, prompts, and identifiers are
  // replaced with generic placeholders.
  describe("session_meta", () => {
    it("maps a session_meta line to a session_start event using the thread's own id", () => {
      const raw: CodexRolloutRawMessage = {
        type: "session_meta",
        payload: {
          id: "thread-own-id",
          // Parent thread id for sub-agent rollouts -- NOT the id we want.
          session_id: "thread-parent-id",
          cwd: "/repo",
          originator: "vertebrae_local_chat",
          cli_version: "0.142.4",
        } as CodexRolloutRawMessage["payload"],
      };

      expect(parseCodexRolloutMessage(raw, timestamp)).toEqual([
        {
          kind: "session_start",
          timestamp,
          model: "codex",
          sessionId: "thread-own-id",
        },
      ]);
    });

    it("emits session_start only once per id when state is threaded across calls (real rollouts repeat session_meta many times)", () => {
      const raw: CodexRolloutRawMessage = {
        type: "session_meta",
        payload: { id: "thread-own-id" },
      };
      const logs: SessionLog[] = [
        { content: JSON.stringify(raw), created_at: timestamp } as SessionLog,
        { content: JSON.stringify(raw), created_at: timestamp } as SessionLog,
        { content: JSON.stringify(raw), created_at: timestamp } as SessionLog,
      ];

      const events = parseSessionLogs(logs);
      expect(events.filter((e) => e.kind === "session_start")).toHaveLength(1);
    });
  });

  describe("event_msg", () => {
    it("drops agent_message and user_message event_msg lines (duplicate the response_item message)", () => {
      const agentMessage: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "agent_message", message: "hello from codex" },
      };
      const userMessage: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "user_message", message: "hello from user" },
      };

      expect(parseCodexRolloutMessage(agentMessage, timestamp)).toEqual([]);
      expect(
        parseCodexRolloutMessage(userMessage, timestamp, {
          includeUserMessages: true,
        })
      ).toEqual([]);
    });

    it("drops task_started, task_complete, and token_count -- bookkeeping/telemetry only", () => {
      const taskStarted: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "task_started" },
      };
      const taskComplete: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "task_complete", message: "final reply text" },
      };
      const tokenCount: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "token_count" },
      };

      expect(parseCodexRolloutMessage(taskStarted, timestamp)).toEqual([]);
      expect(parseCodexRolloutMessage(taskComplete, timestamp)).toEqual([]);
      expect(parseCodexRolloutMessage(tokenCount, timestamp)).toEqual([]);
    });

    it("drops mcp_tool_call_end (duplicates a function_call/function_call_output pair) and web_search_end (no result payload observed)", () => {
      const mcpEnd: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "mcp_tool_call_end", call_id: "call-1" },
      };
      const webSearchEnd: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "web_search_end", call_id: "ws-1" },
      };

      expect(parseCodexRolloutMessage(mcpEnd, timestamp)).toEqual([]);
      expect(parseCodexRolloutMessage(webSearchEnd, timestamp)).toEqual([]);
    });

    it("drops unrecognized event_msg subtypes (e.g. context_compacted) without throwing", () => {
      const raw: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "context_compacted" },
      };

      expect(parseCodexRolloutMessage(raw, timestamp)).toEqual([]);
    });

    it("maps turn_aborted to a thinking event, mirroring the exec-json turn.failed convention", () => {
      const raw: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: { type: "turn_aborted", reason: "interrupted" },
      };

      expect(parseCodexRolloutMessage(raw, timestamp)).toEqual([
        {
          kind: "thinking",
          timestamp,
          text: "[error] Turn aborted: interrupted",
        },
      ]);
    });

    it("maps patch_apply_end content for added and deleted files into diff bodies", () => {
      const raw: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call-patch-1",
          success: true,
          changes: {
            "/repo/src/updated.rs": {
              type: "update",
              unified_diff: "@@ -1 +1 @@\n-old\n+new",
            },
            "/repo/src/added.rs": {
              type: "add",
              content: "fn added() {}",
            },
            "/repo/src/removed.rs": {
              type: "delete",
              content: "fn removed() {}",
            },
          },
        } as CodexRolloutRawMessage["payload"],
      };

      const events = parseCodexRolloutMessage(raw, timestamp);
      expect(events).toEqual([
        {
          kind: "file_edit",
          timestamp,
          toolId: "call-patch-1",
          status: "completed",
          changes: [
            {
              path: "/repo/src/updated.rs",
              kind: "update",
              diff: "@@ -1 +1 @@\n-old\n+new",
            },
            { path: "/repo/src/added.rs", kind: "add", diff: "+fn added() {}" },
            {
              path: "/repo/src/removed.rs",
              kind: "delete",
              diff: "-fn removed() {}",
            },
          ],
        },
      ]);
    });

    it("restores an apply_patch diff from Codex exec transcript records", () => {
      const logs: SessionLog[] = [
        {
          id: "exec-call",
          step_execution_id: "codex-session",
          content: JSON.stringify({
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "exec",
              call_id: "call-wrapper",
              input:
                'const patch = "*** Begin Patch\\n*** Update File: patch-demo.txt\\n@@\\n-This file was added\\n+This file was created\\n*** End Patch";',
            },
          }),
          created_at: timestamp,
        },
        {
          id: "patch-result",
          step_execution_id: "codex-session",
          content: JSON.stringify({
            type: "event_msg",
            payload: {
              type: "patch_apply_end",
              call_id: "exec-patch",
              success: true,
              changes: {
                "/repo/patch-demo.txt": {
                  type: "update",
                  unified_diff:
                    "@@ -1,1 +1,1 @@\\n-This file was added\\n+This file was created\\n",
                },
              },
            },
          }),
          created_at: timestamp,
        },
        {
          id: "exec-wrapper-output",
          step_execution_id: "codex-session",
          content: JSON.stringify({
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call-wrapper",
              output: [{ type: "input_text", text: "{}" }],
            },
          }),
          created_at: timestamp,
        },
      ];

      const events = parseSessionLogs(logs);
      expect(events.filter((event) => event.kind === "file_edit")).toHaveLength(
        1
      );
      expect(events).toContainEqual({
        kind: "file_edit",
        timestamp,
        toolId: "exec-patch",
        status: "completed",
        changes: [
          {
            path: "/repo/patch-demo.txt",
            kind: "update",
            diff: "@@ -1,1 +1,1 @@\\n-This file was added\\n+This file was created\\n",
          },
        ],
      });
    });

    it("skips Codex bootstrap context stored as a user-role response item", () => {
      const injectedContext: CodexRolloutRawMessage = {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<recommended_plugins>\n- GitHub\n</recommended_plugins>",
            },
            {
              type: "input_text",
              text: "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>Do things</INSTRUCTIONS>",
            },
            {
              type: "input_text",
              text: "<environment_context><cwd>/repo</cwd></environment_context>",
            },
          ],
        },
      };

      const actualUserMessage: CodexRolloutRawMessage = {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hey there" }],
        },
      };

      expect(
        parseCodexRolloutMessage(injectedContext, timestamp, {
          includeUserMessages: true,
        })
      ).toEqual([]);
      expect(
        parseCodexRolloutMessage(actualUserMessage, timestamp, {
          includeUserMessages: true,
        })
      ).toEqual([{ kind: "user_message", timestamp, text: "Hey there" }]);
    });

    it("marks patch_apply_end as failed when success is false", () => {
      const raw: CodexRolloutRawMessage = {
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          call_id: "call-patch-2",
          success: false,
          changes: {
            "/repo/src/broken.rs": {
              type: "update",
              unified_diff: "@@ -1 +1 @@",
            },
          },
        } as CodexRolloutRawMessage["payload"],
      };

      const [event] = parseCodexRolloutMessage(raw, timestamp);
      expect(event).toMatchObject({ kind: "file_edit", status: "failed" });
    });

    it("renders rollout apply_patch custom tool calls with their terminal status", () => {
      const logs: SessionLog[] = [
        {
          id: "patch-start",
          step_execution_id: "rollout-file-exec",
          content: JSON.stringify({
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "apply_patch",
              call_id: "patch-1",
              input:
                "*** Begin Patch\n*** Add File: src/new.ts\n+export {}\n*** Update File: src/lib.ts\n@@\n-old\n+new\n*** End Patch",
            },
          }),
          created_at: timestamp,
        },
        {
          id: "patch-output",
          step_execution_id: "rollout-file-exec",
          content: JSON.stringify({
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "patch-1",
              output: "applied",
            },
          }),
          created_at: timestamp,
        },
      ];
      expect(parseSessionLogs(logs)).toMatchObject([
        {
          kind: "file_edit",
          toolId: "patch-1",
          status: "completed",
          changes: [
            { path: "src/new.ts", kind: "add" },
            {
              path: "src/lib.ts",
              kind: "update",
              diff: expect.stringContaining("+new"),
            },
          ],
        },
      ]);
    });
  });

  describe("full-rollout pipeline via parseSessionLogs (regression coverage)", () => {
    it("routes response_item/event_msg/session_meta lines correctly without dropping meaningful content or double-emitting", () => {
      const lines: CodexRolloutRawMessage[] = [
        { type: "session_meta", payload: { id: "thread-1" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "do the thing" }],
          },
        },
        // Duplicate of the response_item message above -- must be skipped.
        {
          type: "event_msg",
          payload: { type: "user_message", message: "do the thing" },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done doing it" }],
          },
        },
        // Duplicate of the response_item message above -- must be skipped.
        {
          type: "event_msg",
          payload: { type: "agent_message", message: "done doing it" },
        },
        {
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "call-1",
            success: true,
            changes: {
              "/repo/a.rs": { type: "update", unified_diff: "@@ diff @@" },
            },
          } as CodexRolloutRawMessage["payload"],
        },
      ];

      const logs: SessionLog[] = lines.map(
        (raw) =>
          ({
            content: JSON.stringify(raw),
            created_at: timestamp,
          }) as SessionLog
      );

      const events = parseSessionLogs(logs, { includeUserMessages: true });

      expect(events.map((e) => e.kind)).toEqual([
        "session_start",
        "user_message",
        "assistant_message",
        "file_edit",
      ]);
    });
  });
});

describe("parseSessionLogs provider dispatch", () => {
  const createLog = (
    content: string,
    createdAt: string,
    execId = "exec-1"
  ): SessionLog => ({
    id: `log-${createdAt}`,
    step_execution_id: execId,
    content,
    created_at: createdAt,
  });

  it("dispatches Codex JSONL lines through parseCodexMessage and Claude lines through parseClaudeMessage", () => {
    // Codex success streams have no `thread.completed` -- they just terminate
    // after `turn.completed`. The Codex side here therefore emits
    // session_start + thinking with no session_end of its own.
    const logs: SessionLog[] = [
      createLog(
        JSON.stringify({
          type: "thread.started",
          thread_id: "thr-1",
        }),
        "2024-01-02T08:00:00Z",
        "codex-exec"
      ),
      createLog(
        JSON.stringify({ type: "turn.started" }),
        "2024-01-02T08:00:01Z",
        "codex-exec"
      ),
      createLog(
        JSON.stringify({
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: "ok" },
        }),
        "2024-01-02T08:00:02Z",
        "codex-exec"
      ),
      createLog(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        "2024-01-02T08:00:03Z",
        "codex-exec"
      ),
      // A Claude assistant log on a different execution -- must dispatch via
      // parseClaudeMessage and NOT share state with the Codex execution.
      createLog(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello" }] },
        }),
        "2024-01-02T09:00:00Z",
        "claude-exec"
      ),
    ];

    const events = parseSessionLogs(logs);

    // Codex: session_start, assistant_message (agent_message → final reply)
    // Claude: assistant_message (Claude's `text` content is the user-facing reply)
    expect(events.map((e) => e.kind)).toEqual([
      "session_start",
      "assistant_message",
      "assistant_message",
    ]);
    expect(events[0]).toMatchObject({
      kind: "session_start",
      sessionId: "thr-1",
      model: "codex",
    });
    expect(events[1]).toMatchObject({ kind: "assistant_message", text: "ok" });
    expect(events[2]).toMatchObject({
      kind: "assistant_message",
      text: "Hello",
    });
  });

  it("projects daemon harness logs into trace events without changing legacy parser dispatch", () => {
    const harness = (
      type: string,
      data: Record<string, unknown>,
      sequence: number,
      streamId = "root"
    ) =>
      JSON.stringify({
        version: 1,
        event_id: `harness-${sequence}`,
        stream_id: streamId,
        sequence,
        correlation:
          streamId === "child"
            ? {
                session_id: "session-1",
                thread_id: "child-thread",
                turn_id: "child-turn",
                parent_tool_call_id: "spawn-1",
              }
            : {
                session_id: "session-1",
                thread_id: "root-thread",
                turn_id: "root-turn",
              },
        timestamp: `2024-01-02T08:00:0${sequence}Z`,
        semantics: type === "text" && sequence === 4 ? "delta" : "snapshot",
        type,
        data,
      });
    const harnessLog = (
      content: string,
      createdAt: string,
      sequence: number
    ): SessionLog => {
      return {
        ...createLog(content, createdAt, "harness-exec"),
        id: `harness-log-${sequence}`,
        format: "harness",
        content,
        step_execution_id: "harness-exec",
      };
    };

    const logs: SessionLog[] = [
      harnessLog(
        harness(
          "session_started",
          {
            provider: "anthropic",
            model: "claude-sonnet",
            provider_resume_id: "session-1",
          },
          1
        ),
        "2024-01-02T08:00:01Z",
        1
      ),
      harnessLog(
        harness(
          "tool_call",
          {
            tool_call_id: "spawn-1",
            name: "Task",
            input: { prompt: "Inspect" },
          },
          2
        ),
        "2024-01-02T08:00:02Z",
        2
      ),
      harnessLog(
        harness(
          "turn_input",
          {
            thread_id: "child-thread",
            content: "Inspect",
            provenance: "agent",
          },
          3,
          "child"
        ),
        "2024-01-02T08:00:03Z",
        3
      ),
      harnessLog(
        harness("text", { text: "Child report" }, 4, "child"),
        "2024-01-02T08:00:04Z",
        4
      ),
      harnessLog(
        harness("text", { text: "Child report" }, 5, "child"),
        "2024-01-02T08:00:05Z",
        5
      ),
      harnessLog(
        harness(
          "tool_call",
          { tool_call_id: "bash-1", name: "Bash", input: { command: "pwd" } },
          6,
          "child"
        ),
        "2024-01-02T08:00:06Z",
        6
      ),
      harnessLog(
        harness(
          "tool_output",
          {
            tool_call_id: "bash-1",
            output: { stdout: "/repo" },
            status: "completed",
          },
          7,
          "child"
        ),
        "2024-01-02T08:00:07Z",
        7
      ),
      harnessLog(
        harness("usage", { session_snapshot: { cost_microusd: 42000 } }, 8),
        "2024-01-02T08:00:08Z",
        8
      ),
      harnessLog(
        harness(
          "run_finished",
          {
            status: "completed",
            metrics: {
              duration_ms: 1200,
              turn_count: 1,
              total_cost_usd: 0.042,
            },
          },
          9
        ),
        "2024-01-02T08:00:09Z",
        9
      ),
    ];

    const events = parseSessionLogs(logs);

    expect(events.map((event) => event.kind)).toEqual([
      "session_start",
      "tool_call",
      "user_message",
      "assistant_message",
      "tool_call",
      "tool_result",
      "session_end",
    ]);
    expect(events[3]).toMatchObject({
      text: "Child report",
      parentToolUseId: "spawn-1",
    });
    expect(events[5]).toMatchObject({
      toolUseId: "bash-1",
      parentToolUseId: "spawn-1",
      result: '{"stdout":"/repo"}',
    });
    expect(events[events.length - 1]).toMatchObject({
      kind: "session_end",
      durationMs: 1200,
      numTurns: 1,
      costUsd: 0.042,
    });
  });

  it("keeps harness dedupe within a turn and replaces harness plan snapshots", () => {
    const log = (
      sequence: number,
      type: string,
      data: Record<string, unknown>,
      turnId?: string
    ): SessionLog => ({
      ...createLog(
        JSON.stringify({
          version: 1,
          event_id: `harness-state-${sequence}`,
          stream_id: "persistent-root",
          sequence,
          correlation: {
            session_id: "session-1",
            thread_id: "root-thread",
            ...(turnId ? { turn_id: turnId } : {}),
          },
          timestamp: `2024-01-03T08:00:0${sequence}Z`,
          semantics: type === "text" && sequence === 1 ? "delta" : "snapshot",
          type,
          data,
        }),
        `2024-01-03T08:00:0${sequence}Z`,
        "harness-exec"
      ),
      id: `harness-state-log-${sequence}`,
      format: "harness",
    });

    const events = parseSessionLogs([
      log(1, "text", { text: "turn one delta" }, "turn-1"),
      log(2, "text", { text: "turn one snapshot" }, "turn-1"),
      log(
        3,
        "turn_finished",
        { status: "completed", result_text: "turn one result" },
        "turn-1"
      ),
      log(
        4,
        "turn_finished",
        { status: "completed", result_text: "turn two result" },
        "turn-2"
      ),
      log(
        5,
        "plan",
        { entries: [{ id: "plan-1", text: "Review", status: "pending" }] },
        "turn-2"
      ),
      log(
        6,
        "plan",
        { entries: [{ id: "plan-1", text: "Review", status: "completed" }] },
        "turn-2"
      ),
      log(
        7,
        "file_change",
        {
          changes: [
            { path: "new.rs", kind: "Added" },
            { path: "old.rs", kind: "deleted" },
            { path: "renamed.rs", kind: "Renamed", previous_path: "before.rs" },
          ],
        },
        "turn-2"
      ),
    ]);

    expect(
      events.filter((event) => event.kind === "assistant_message")
    ).toMatchObject([{ text: "turn one delta" }, { text: "turn two result" }]);
    expect(events.filter((event) => event.kind === "todo_list")).toMatchObject([
      {
        itemId: "harness-plan:root-thread",
        items: [{ text: "Review", completed: true }],
      },
    ]);
    expect(events.find((event) => event.kind === "file_edit")).toMatchObject({
      changes: [
        { path: "new.rs", kind: "add" },
        { path: "old.rs", kind: "delete" },
        { path: "renamed.rs", kind: "rename" },
      ],
    });
  });

  it("uses the Claude label when a harness session start has no model", () => {
    const events = parseSessionLogs([
      {
        ...createLog(
          JSON.stringify({
            version: 1,
            event_id: "harness-session-start",
            stream_id: "root",
            correlation: { session_id: "session-1" },
            type: "session_started",
            data: { provider: "anthropic" },
          }),
          "2024-01-03T08:01:00Z",
          "harness-exec"
        ),
        format: "harness",
      },
    ]);

    expect(events).toMatchObject([{ kind: "session_start", model: "Claude" }]);
  });

  it("normalizes Codex rollout multi-agent records into spawn parents and child transcript rows", () => {
    const logs: SessionLog[] = [
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            namespace: "multi_agent_v1",
            call_id: "call-spawn",
            name: "spawn_agent",
            arguments: JSON.stringify({
              agent_type: "explorer",
              message: "Inspect traces",
            }),
          },
        }),
        "2024-01-02T08:00:00Z",
        "codex-rollout"
      ),
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-spawn",
            output: JSON.stringify({
              agent_id: "agent-1",
              nickname: "Avicenna",
            }),
          },
        }),
        "2024-01-02T08:00:01Z",
        "codex-rollout"
      ),
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `<subagent_notification>
{"agent_path":"agent-1","status":{"completed":"child report"}}
</subagent_notification>`,
              },
            ],
          },
        }),
        "2024-01-02T08:00:02Z",
        "codex-rollout"
      ),
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            namespace: "multi_agent_v1",
            call_id: "call-close",
            name: "close_agent",
            arguments: JSON.stringify({ target: "agent-1" }),
          },
        }),
        "2024-01-02T08:00:03Z",
        "codex-rollout"
      ),
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-close",
            output: JSON.stringify({
              previous_status: { completed: "child report" },
            }),
          },
        }),
        "2024-01-02T08:00:04Z",
        "codex-rollout"
      ),
    ];

    const events = parseSessionLogs(logs, { includeUserMessages: true });

    expect(events.map((event) => event.kind)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ]);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      toolId: "agent:agent-1",
      toolName: "Agent",
      input: {
        collab_tool: "spawnAgent",
        agent_path: "agent-1",
        receiver_thread_ids: ["agent-1"],
        agent_type: "explorer",
        agent_nickname: "Avicenna",
        description: "Inspect traces",
        agents_states: {
          "agent-1": {
            status: "completed",
          },
        },
      },
    });
    expect(events[1]).toMatchObject({
      kind: "tool_result",
      toolUseId: "agent:agent-1",
      result: "completed",
    });
    expect(events[2]).toMatchObject({
      kind: "tool_call",
      toolId: "agent:agent-1:result:agent-1",
      toolName: "Agent Result",
      input: {
        collab_tool: "agentResult",
        agent_path: "agent-1",
        receiver_thread_ids: ["agent-1"],
        parent_tool_use_id: "agent:agent-1",
      },
    });
    expect(events[3]).toMatchObject({
      kind: "tool_result",
      toolUseId: "agent:agent-1:result:agent-1",
      result: "child report",
    });
  });

  it("normalizes Codex rollout wait_agent status when no notification message is present", () => {
    const logs: SessionLog[] = [
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            namespace: "multi_agent_v1",
            call_id: "call-spawn",
            name: "spawn_agent",
            arguments: JSON.stringify({ message: "Inspect state" }),
          },
        }),
        "2024-01-02T08:00:00Z",
        "codex-rollout"
      ),
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-spawn",
            output: JSON.stringify({ agent_id: "agent-2" }),
          },
        }),
        "2024-01-02T08:00:01Z",
        "codex-rollout"
      ),
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            namespace: "multi_agent_v1",
            call_id: "call-wait",
            name: "wait_agent",
            arguments: "{}",
          },
        }),
        "2024-01-02T08:00:02Z",
        "codex-rollout"
      ),
      createLog(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-wait",
            output: JSON.stringify({
              status: { "agent-2": { completed: "waited report" } },
            }),
          },
        }),
        "2024-01-02T08:00:03Z",
        "codex-rollout"
      ),
    ];

    const events = parseSessionLogs(logs);

    expect(events.map((event) => event.kind)).toEqual([
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
    ]);
    expect(events[0]).toMatchObject({
      kind: "tool_call",
      input: {
        agents_states: {
          "agent-2": {
            status: "completed",
          },
        },
      },
    });
    expect(events[1]).toMatchObject({
      kind: "tool_result",
      toolUseId: "agent:agent-2",
      result: "completed",
    });
    expect(events[3]).toMatchObject({
      kind: "tool_result",
      toolUseId: "agent:agent-2:result:agent-2",
      result: "waited report",
    });
  });

  it("isolates Codex turn-count state per step_execution_id so concurrent executions don't bleed into each other", () => {
    // We use top-level `error` events here as the only JSONL marker that
    // emits a `session_end` carrying the accumulated turn count.
    const logs: SessionLog[] = [
      // Execution A: 3 turns then a fatal error
      createLog(
        JSON.stringify({ type: "thread.started", thread_id: "a" }),
        "t1",
        "exec-a"
      ),
      createLog(JSON.stringify({ type: "turn.started" }), "t2", "exec-a"),
      createLog(JSON.stringify({ type: "turn.started" }), "t3", "exec-a"),
      createLog(JSON.stringify({ type: "turn.started" }), "t4", "exec-a"),
      createLog(
        JSON.stringify({ type: "error", message: "boom-a" }),
        "t5",
        "exec-a"
      ),
      // Execution B: 1 turn then a fatal error -- must report numTurns=1, not 4.
      createLog(
        JSON.stringify({ type: "thread.started", thread_id: "b" }),
        "t6",
        "exec-b"
      ),
      createLog(JSON.stringify({ type: "turn.started" }), "t7", "exec-b"),
      createLog(
        JSON.stringify({ type: "error", message: "boom-b" }),
        "t8",
        "exec-b"
      ),
    ];

    const events = parseSessionLogs(logs);
    const sessionEnds = events.filter((e) => e.kind === "session_end");
    expect(sessionEnds).toHaveLength(2);
    expect(sessionEnds[0]).toMatchObject({ numTurns: 3 });
    expect(sessionEnds[1]).toMatchObject({ numTurns: 1 });
  });

  it("renders a full Codex trace covering every supported item type without dropping artefacts", () => {
    const logs: SessionLog[] = [
      createLog(
        JSON.stringify({ type: "thread.started", thread_id: "thr-mix" }),
        "t1",
        "exec-mix"
      ),
      createLog(JSON.stringify({ type: "turn.started" }), "t2", "exec-mix"),
      createLog(
        JSON.stringify({
          type: "item.completed",
          item: { id: "r1", type: "reasoning", text: "let me think" },
        }),
        "t3",
        "exec-mix"
      ),
      createLog(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "c1",
            type: "command_execution",
            command: "ls",
            exit_code: 0,
            aggregated_output: "foo bar",
          },
        }),
        "t4",
        "exec-mix"
      ),
      createLog(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "mcp1",
            type: "mcp_tool_call",
            server: "morph_mcp",
            tool: "edit_file",
            arguments: { path: "x" },
            result: "ok",
          },
        }),
        "t5",
        "exec-mix"
      ),
      createLog(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "ws1",
            type: "web_search",
            query: "rust",
            action: "search",
            result: ["a"],
          },
        }),
        "t6",
        "exec-mix"
      ),
      createLog(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "fc1",
            type: "file_change",
            status: "completed",
            changes: [{ path: "a.rs", kind: "update", diff: "@@ -1 +1 @@" }],
          },
        }),
        "t7",
        "exec-mix"
      ),
      createLog(
        JSON.stringify({
          type: "item.started",
          item: {
            id: "plan",
            type: "todo_list",
            items: [{ text: "do x", completed: false }],
          },
        }),
        "t8",
        "exec-mix"
      ),
      createLog(
        JSON.stringify({
          type: "item.updated",
          item: {
            id: "plan",
            type: "todo_list",
            items: [{ text: "do x", completed: true }],
          },
        }),
        "t9",
        "exec-mix"
      ),
      createLog(
        JSON.stringify({
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: "all done" },
        }),
        "t10",
        "exec-mix"
      ),
    ];

    const events = parseSessionLogs(logs);
    // Expected sequence:
    //   session_start, thinking (reasoning), tool_call/tool_result (command),
    //   tool_call/tool_result (mcp), tool_call/tool_result (web_search),
    //   file_edit, todo_list, assistant_message
    expect(events.map((e) => e.kind)).toEqual([
      "session_start",
      "thinking",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "file_edit",
      "todo_list",
      "assistant_message",
    ]);
    // Acceptance criterion 3: the rendered todo_list reflects the latest
    // item.updated state (completed=true), not the started state.
    const todo = events.find((e) => e.kind === "todo_list");
    expect(todo).toMatchObject({
      kind: "todo_list",
      itemId: "plan",
      items: [{ text: "do x", completed: true }],
    });
  });

  it("isolates todo_list dedup state per execution so concurrent plans don't trample each other", () => {
    const logs: SessionLog[] = [
      createLog(
        JSON.stringify({
          type: "item.started",
          item: {
            id: "plan",
            type: "todo_list",
            items: [{ text: "exec-a step", completed: false }],
          },
        }),
        "ta1",
        "exec-a"
      ),
      createLog(
        JSON.stringify({
          type: "item.started",
          item: {
            id: "plan", // same id, different execution -- must NOT merge
            type: "todo_list",
            items: [{ text: "exec-b step", completed: false }],
          },
        }),
        "tb1",
        "exec-b"
      ),
    ];
    const events = parseSessionLogs(logs);
    const todos = events.filter((e) => e.kind === "todo_list");
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({
      itemId: "plan",
      items: [{ text: "exec-a step" }],
    });
    expect(todos[1]).toMatchObject({
      itemId: "plan",
      items: [{ text: "exec-b step" }],
    });
  });

  it("skips malformed JSON without throwing", () => {
    const logs: SessionLog[] = [
      createLog("{not-json", "2024-01-02T08:00:00Z", "exec-bad"),
      createLog(
        JSON.stringify({
          type: "thread.started",
          thread_id: "thr-ok",
        }),
        "2024-01-02T08:00:01Z",
        "exec-ok"
      ),
    ];
    const events = parseSessionLogs(logs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "session_start",
      sessionId: "thr-ok",
    });
  });
});
