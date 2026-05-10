import { describe, it, expect } from "vitest";
import {
  parseClaudeMessage,
  parseCodexMessage,
  parseSessionLogs,
  getToolIcon,
  type ClaudeRawMessage,
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

// ============================================================================
// Codex JSONL parser tests
// ============================================================================

describe("parseCodexMessage", () => {
  const timestamp = "2024-01-02T08:00:00Z";

  const newState = (): CodexParseState => ({ turnCount: 0 });

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
    expect(parseCodexMessage({ type: "turn.started" }, timestamp, state)).toEqual([]);
    expect(parseCodexMessage({ type: "turn.started" }, timestamp, state)).toEqual([]);
    expect(state.turnCount).toBe(2);
  });

  it("turn.completed emits no events", () => {
    const state = newState();
    const events = parseCodexMessage(
      {
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 },
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

  it("maps agent_message item.completed to a thinking event carrying the final reply", () => {
    const events = parseCodexMessage(
      {
        type: "item.completed",
        item: { id: "m1", type: "agent_message", text: "Done!" },
      },
      timestamp,
      newState()
    );
    expect(events).toEqual([{ kind: "thinking", timestamp, text: "Done!" }]);
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
      // newlines collapsed into spaces, like the Claude tool_result mapping does.
      result: "total 8 foo bar",
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
    const events = parseCodexMessage(
      { type: "error" },
      timestamp,
      newState()
    );
    expect(events[0]).toMatchObject({
      kind: "thinking",
      text: "[error] codex error",
    });
    expect(events[1]).toMatchObject({ kind: "session_end" });
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

    // Codex: session_start, thinking (agent_message)
    // Claude: thinking
    expect(events.map((e) => e.kind)).toEqual([
      "session_start",
      "thinking",
      "thinking",
    ]);
    expect(events[0]).toMatchObject({
      kind: "session_start",
      sessionId: "thr-1",
      model: "codex",
    });
    expect(events[1]).toMatchObject({ kind: "thinking", text: "ok" });
    expect(events[2]).toMatchObject({ kind: "thinking", text: "Hello" });
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
