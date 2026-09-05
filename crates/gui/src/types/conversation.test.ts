import { describe, it, expect } from "vitest";
import {
  parseHarnessJsonl,
  parseSessionLogs,
  getToolIcon,
} from "./conversation";
import type { SessionLog } from "../bindings";

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
// Normalized HarnessEventV1 projection tests
// ============================================================================

describe("parseSessionLogs", () => {
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

  it("projects normalized harness logs into trace events", () => {
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

  it("accumulates harness deltas until the completed item snapshot", () => {
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
          semantics:
            type === "text" && (sequence === 1 || sequence === 2)
              ? "delta"
              : "snapshot",
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
      log(1, "text", { text: "turn one " }, "turn-1"),
      log(2, "text", { text: "delta" }, "turn-1"),
      log(3, "text", { text: "turn one delta" }, "turn-1"),
      log(
        4,
        "turn_finished",
        { status: "completed", result_text: "turn one delta" },
        "turn-1"
      ),
      log(
        5,
        "turn_finished",
        { status: "completed", result_text: "turn two result" },
        "turn-2"
      ),
      log(
        6,
        "plan",
        { entries: [{ id: "plan-1", text: "Review", status: "pending" }] },
        "turn-2"
      ),
      log(
        7,
        "plan",
        { entries: [{ id: "plan-1", text: "Review", status: "completed" }] },
        "turn-2"
      ),
      log(
        8,
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

  it("keeps interleaved item identities and terminal lifecycles distinct during replay", () => {
    const raw = (
      sequence: number,
      itemId: string | undefined,
      semantics: "delta" | "snapshot",
      text: string,
      completionStatus?: string
    ) =>
      JSON.stringify({
        version: 1,
        event_id: `item-${sequence}`,
        stream_id: "item-stream",
        sequence,
        correlation: {
          session_id: "session-1",
          thread_id: "root-thread",
          turn_id: "turn-items",
          ...(itemId ? { item_id: itemId } : {}),
        },
        timestamp: `2024-01-04T08:00:0${sequence}Z`,
        semantics,
        type: "text",
        data: {
          text,
          ...(completionStatus ? { completion_status: completionStatus } : {}),
        },
      });
    const logs = [
      raw(1, "item-a", "delta", "A "),
      raw(2, "item-b", "delta", "B "),
      raw(3, "item-a", "snapshot", "A complete", "completed"),
      raw(4, "item-b", "snapshot", "B complete", "completed"),
      raw(5, "item-a", "snapshot", "duplicate"),
      JSON.stringify({
        version: 1,
        event_id: "item-end",
        stream_id: "item-stream",
        sequence: 6,
        correlation: {
          session_id: "session-1",
          thread_id: "root-thread",
          turn_id: "turn-items",
        },
        timestamp: "2024-01-04T08:00:06Z",
        semantics: "snapshot",
        type: "turn_finished",
        data: { status: "completed" },
      }),
    ].map((content, index) => ({
      ...createLog(content, `2024-01-04T08:00:0${index}Z`, "item-exec"),
      id: `item-log-${index}`,
      format: "harness",
    })) as SessionLog[];

    const assistants = parseSessionLogs(logs).filter(
      (event): event is Extract<typeof event, { kind: "assistant_message" }> =>
        event.kind === "assistant_message"
    );

    expect(assistants).toMatchObject([
      {
        itemId: "item-a",
        text: "A complete",
        lifecycle: "completed",
      },
      {
        itemId: "item-b",
        text: "B complete",
        lifecycle: "completed",
      },
    ]);
  });

  it("does not treat an unclassified item snapshot as successful completion", () => {
    const logs = [
      JSON.stringify({
        version: 1,
        event_id: "unclassified-delta",
        stream_id: "unclassified-stream",
        correlation: { turn_id: "turn-unclassified", item_id: "item-a" },
        semantics: "delta",
        type: "text",
        data: { text: "received" },
      }),
      JSON.stringify({
        version: 1,
        event_id: "unclassified-snapshot",
        stream_id: "unclassified-stream",
        correlation: { turn_id: "turn-unclassified", item_id: "item-a" },
        semantics: "snapshot",
        type: "text",
        data: { text: "provider replacement" },
      }),
    ].map((content, index) => ({
      ...createLog(content, `2024-01-06T08:00:0${index}Z`, "unclassified-exec"),
      id: `unclassified-log-${index}`,
      format: "harness",
    })) as SessionLog[];

    expect(parseSessionLogs(logs)).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        itemId: "item-a",
        text: "received",
        turnId: "turn-unclassified",
        lifecycle: "streaming",
      }),
    ]);
  });

  it.each(["turn_finished", "error"] as const)("interrupts pending text on %s", (terminalType) => {
    const makeLog = (
      sequence: number,
      type: "text" | "turn_finished" | "error",
      data: Record<string, unknown>,
      itemId?: string
    ): SessionLog => ({
      ...createLog(
        JSON.stringify({
          version: 1,
          event_id: `cancel-${sequence}`,
          stream_id: "cancel-stream",
          sequence,
          correlation: {
            turn_id: "cancelled-turn",
            ...(itemId ? { item_id: itemId } : {}),
          },
          timestamp: `2024-01-05T08:00:0${sequence}Z`,
          semantics: type === "text" ? "delta" : "snapshot",
          type,
          data,
        }),
        `2024-01-05T08:00:0${sequence}Z`,
        "cancel-exec"
      ),
      id: `cancel-log-${sequence}`,
      format: "harness",
    });

    const assistants = parseSessionLogs([
      makeLog(1, "text", { text: "received A" }, "item-a"),
      makeLog(2, "text", { text: "received B" }, "item-b"),
      makeLog(3, terminalType, { status: "cancelled" }),
    ]).filter((event) => event.kind === "assistant_message");

    expect(assistants).toEqual([
      expect.objectContaining({
        itemId: "item-a",
        text: "received A",
        lifecycle: "interrupted",
      }),
      expect.objectContaining({
        itemId: "item-b",
        text: "received B",
        lifecycle: "interrupted",
      }),
    ]);
  });

  it("uses the provider label when a harness session start has no model", () => {
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

    expect(events).toMatchObject([
      { kind: "session_start", model: "anthropic" },
    ]);
  });

  it("isolates todo_list dedup state per execution so concurrent plans don't trample each other", () => {
    const logs: SessionLog[] = [
      {
        id: "plan-a",
        step_execution_id: "exec-a",
        format: "harness",
        content: JSON.stringify({
          version: 1,
          event_id: "plan-a",
          stream_id: "stream-a",
          correlation: { thread_id: "thread-a" },
          type: "plan",
          data: {
            entries: [{ id: "plan", text: "exec-a step", status: "pending" }],
          },
        }),
        created_at: "ta1",
      },
      {
        id: "plan-b",
        step_execution_id: "exec-b",
        format: "harness",
        content: JSON.stringify({
          version: 1,
          event_id: "plan-b",
          stream_id: "stream-b",
          correlation: { thread_id: "thread-b" },
          type: "plan",
          data: {
            entries: [{ id: "plan", text: "exec-b step", status: "pending" }],
          },
        }),
        created_at: "tb1",
      },
    ];
    const events = parseSessionLogs(logs);
    const todos = events.filter((e) => e.kind === "todo_list");
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({
      itemId: "harness-plan:thread-a",
      items: [{ text: "exec-a step" }],
    });
    expect(todos[1]).toMatchObject({
      itemId: "harness-plan:thread-b",
      items: [{ text: "exec-b step" }],
    });
  });

  it("skips malformed JSON without throwing", () => {
    const harnessLog = (content: string, id: string): SessionLog => ({
      id,
      step_execution_id: "exec",
      content,
      format: "harness",
      created_at: "2024-01-02T08:00:00Z",
    });
    const logs: SessionLog[] = [
      harnessLog("{not-json", "bad"),
      harnessLog(
        JSON.stringify({
          version: 1,
          event_id: "event-ok",
          stream_id: "stream-ok",
          type: "session_started",
          data: { model: "claude" },
        }),
        "ok"
      ),
    ];
    const events = parseSessionLogs(logs);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "session_start",
      sessionId: "stream-ok",
      model: "claude",
    });
  });
});

describe("parseHarnessJsonl", () => {
  it("preserves raw stored turn input for historical transcript artifacts", () => {
    const body = JSON.stringify({
      version: 1,
      event_id: "artifact-user-input",
      stream_id: "artifact-stream",
      timestamp: "2026-08-02T00:00:00Z",
      type: "turn_input",
      data: {
        provenance: "human",
        content: "# AGENTS.md instructions for /historic/worktree",
      },
    });

    expect(parseHarnessJsonl(body)).toMatchObject([
      {
        kind: "user_message",
        text: "# AGENTS.md instructions for /historic/worktree",
      },
    ]);
  });
});
