import { describe, it, expect } from "vitest";
import {
  runToThreads,
  runToRun,
  msgsToThread,
  conversationEventsToThread,
  stepKindFromStepType,
  humanDuration,
  type RunInput,
  type ChatMsg,
} from "./normalize";
import type { SessionLog, StepExecution, TaskRun } from "../../bindings";
import type { ConversationEvent } from "../../types/conversation";
import type {
  AgentMessage,
  ResultMessage,
  SpawnMessage,
  SystemMessage,
  ToolMessage,
  WaitMessage,
} from "./types";

// ===========================================================================
// Fixtures — normalized HarnessEventV1 session-log rows.
// ===========================================================================

const RUN_ID = "run-1";

function taskRun(startedAt: string): TaskRun {
  return {
    id: RUN_ID,
    task_id: "task-1",
    project_id: "proj-1",
    user_id: null,
    status: "executing",
    started_at: startedAt,
    ended_at: null,
    stop_requested_at: null,
    latest_step_execution_id: null,
    outcome_kind: null,
    outcome_context: null,
    parent_task_run_id: null,
    root_task_run_id: null,
    triggered_by_step_execution_id: null,
    inserted_at: null,
    updated_at: null,
  };
}

function exec(over: Partial<StepExecution> & { id: string }): StepExecution {
  return {
    task_id: "task-1",
    task_run_id: RUN_ID,
    workflow_id: "wf-1",
    step_name: "step",
    step_type: "execute",
    started_at: "2024-01-01T10:00:00Z",
    completed_at: null,
    status: "completed",
    prompt: null,
    output: null,
    context: null,
    transition_result: null,
    model: null,
    model_provider: null,
    input_tokens: null,
    output_tokens: null,
    cost: null,
    duration_ms: null,
    handoff: null,
    session_id: null,
    ...over,
  };
}

function harnessLog(
  execId: string,
  type: string,
  data: Record<string, unknown>,
  createdAt: string,
  options: {
    streamId?: string;
    turnId?: string;
    parentToolCallId?: string;
    semantics?: "delta" | "snapshot";
  } = {}
): SessionLog {
  const streamId = options.streamId ?? "root";
  const eventId = execId + "-" + createdAt + "-" + type;
  return {
    id: eventId,
    step_execution_id: execId,
    format: "harness",
    content: JSON.stringify({
      version: 1,
      event_id: eventId,
      stream_id: streamId,
      correlation: {
        session_id: "session-1",
        thread_id: streamId + "-thread",
        ...(options.turnId ? { turn_id: options.turnId } : {}),
        ...(options.parentToolCallId
          ? { parent_tool_call_id: options.parentToolCallId }
          : {}),
      },
      timestamp: createdAt,
      semantics: options.semantics ?? "snapshot",
      type,
      data,
    }),
    created_at: createdAt,
  };
}

function harnessConversationLogs(execId: string, model: string): SessionLog[] {
  return [
    harnessLog(
      execId,
      "session_started",
      { provider: model === "codex" ? "openai" : "anthropic", model },
      "2024-01-01T10:00:01Z"
    ),
    harnessLog(
      execId,
      "text",
      { text: "Let me run the tests." },
      "2024-01-01T10:00:02Z",
      { turnId: "turn-1" }
    ),
    harnessLog(
      execId,
      "tool_call",
      { tool_call_id: "tu-1", name: "Bash", input: { command: "mix test" } },
      "2024-01-01T10:00:03Z",
      { turnId: "turn-1" }
    ),
    harnessLog(
      execId,
      "tool_output",
      {
        tool_call_id: "tu-1",
        output: "41 tests, 0 failures",
        status: "completed",
      },
      "2024-01-01T10:00:05Z",
      { turnId: "turn-1" }
    ),
    harnessLog(
      execId,
      "turn_finished",
      {
        status: "completed",
        metrics: { duration_ms: 5000, turn_count: 1, total_cost_usd: 0.01 },
      },
      "2024-01-01T10:00:06Z",
      { turnId: "turn-1" }
    ),
  ];
}

// ===========================================================================

describe("stepKindFromStepType", () => {
  it("maps the seven known step types and falls back to execute", () => {
    expect(stepKindFromStepType("execute")).toBe("execute");
    expect(stepKindFromStepType("evaluate")).toBe("eval");
    expect(stepKindFromStepType("route")).toBe("route");
    expect(stepKindFromStepType("human_input")).toBe("human");
    expect(stepKindFromStepType("wait_children")).toBe("wait");
    expect(stepKindFromStepType("stop")).toBe("stop");
    expect(stepKindFromStepType("finish")).toBe("finish");
    expect(stepKindFromStepType(null)).toBe("execute");
    expect(stepKindFromStepType({ unsupported: "x" })).toBe("execute");
  });
});

describe("runToThreads — finish step", () => {
  it("renders finish as a terminal result without parsing provider logs", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [
        exec({
          id: "finish-1",
          step_name: "Complete",
          step_type: "finish",
          output: null,
        }),
      ],
      logsByExecutionId: {
        "finish-1": [
          {
            ...harnessLog("finish-1", "text", {}, "not-a-date"),
            content: "not a session log",
          },
        ],
      },
    };

    const [thread] = runToThreads(input);
    expect(thread.kind).toBe("finish");
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].messages).toEqual([
      expect.objectContaining({
        type: "result",
        label: "finish",
        body: "Task completed by finish step",
      }),
    ]);
  });
});

describe("humanDuration", () => {
  it("formats sub-second, second, minute and hour scales", () => {
    expect(humanDuration(142)).toBe("142ms");
    expect(humanDuration(9000)).toBe("9.0s");
    expect(humanDuration(8 * 60_000 + 58_000)).toBe("8m 58s");
    expect(humanDuration(7 * 3_600_000 + 36 * 60_000)).toBe("7h 36m");
  });
});

describe("runToThreads — ordering & step head", () => {
  it("emits one root thread per StepExecution, ordered by started_at", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [
        exec({
          id: "e2",
          step_name: "second",
          started_at: "2024-01-01T10:05:00Z",
        }),
        exec({
          id: "e1",
          step_name: "first",
          started_at: "2024-01-01T10:00:00Z",
        }),
      ],
      logsByExecutionId: {},
    };
    const threads = runToThreads(input);
    expect(threads.map((t) => t.id)).toEqual(["e1", "e2"]);
    expect(threads[0].step?.to).toBe("first");
    expect(threads[0].step?.rel).toBe("+0ms");
    expect(threads[1].step?.rel).toBe("+5m 0s");
  });

  it("derives the step head kind/runtime from step_type/duration_ms", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [
        exec({ id: "e1", step_type: "evaluate", duration_ms: 9000 }),
      ],
      logsByExecutionId: {},
    };
    const [t] = runToThreads(input);
    expect(t.step?.kind).toBe("eval");
    expect(t.step?.runtime).toBe("9.0s");
    expect(t.kind).toBe("eval");
  });
});

describe("runToThreads — normalized harness events", () => {
  const input: RunInput = {
    taskRun: taskRun("2024-01-01T10:00:00Z"),
    stepExecutions: [
      exec({ id: "e1", prompt: "do the thing", model: "claude-sonnet-4.5" }),
    ],
    logsByExecutionId: {
      e1: harnessConversationLogs("e1", "claude-sonnet-4.5"),
    },
  };

  it("opens a leading SystemMessage from the interpolated prompt", () => {
    const [t] = runToThreads(input);
    const sys = t.turns[0].messages[0] as SystemMessage;
    expect(sys.type).toBe("system");
    expect(sys.label).toBe("System");
    expect(sys.text).toBe("do the thing");
    expect(sys.body).toBe("do the thing");
  });

  it("maps normalized assistant text to an AgentMessage prose row", () => {
    const [t] = runToThreads(input);
    const agent = t.turns[0].messages.find(
      (m) => m.type === "agent"
    ) as AgentMessage;
    expect(agent.prose).toBe("Let me run the tests.");
    expect(agent.speaker).toBe("Agent · claude-sonnet-4.5");
  });

  it("pairs normalized tool_call + tool_output into one ToolMessage card", () => {
    const [t] = runToThreads(input);
    const tools = t.turns[0].messages.filter(
      (m) => m.type === "tool"
    ) as ToolMessage[];
    expect(tools).toHaveLength(1);
    expect(tools[0].evt).toBe("tu-1");
    expect(tools[0].kind).toBe("shell");
    expect(tools[0].cmd).toBe("mix test");
    expect(tools[0].status).toBe("done");
    expect(tools[0].body).toBe("41 tests, 0 failures");
    expect(t.summary?.tools).toBe(1);
  });

  it("maps normalized reasoning, text and failing tool output for Codex", () => {
    const codexInput: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "e2", model: "codex" })],
      logsByExecutionId: {
        e2: [
          harnessLog(
            "e2",
            "session_started",
            { provider: "openai", model: "codex" },
            "2024-01-01T10:00:01Z"
          ),
          harnessLog(
            "e2",
            "reasoning",
            { text: "Planning the patch." },
            "2024-01-01T10:00:02Z",
            { turnId: "turn-1" }
          ),
          harnessLog(
            "e2",
            "tool_call",
            {
              tool_call_id: "codex-tool",
              name: "Bash",
              input: { command: "mix test" },
            },
            "2024-01-01T10:00:03Z",
            { turnId: "turn-1" }
          ),
          harnessLog(
            "e2",
            "tool_output",
            {
              tool_call_id: "codex-tool",
              output: "2 failed",
              status: "failed",
            },
            "2024-01-01T10:00:04Z",
            { turnId: "turn-1" }
          ),
          harnessLog(
            "e2",
            "text",
            { text: "Tests are red; fixing." },
            "2024-01-01T10:00:05Z",
            { turnId: "turn-1" }
          ),
        ],
      },
    };
    const [t] = runToThreads(codexInput);
    const agents = t.turns[0].messages.filter(
      (m) => m.type === "agent"
    ) as AgentMessage[];
    expect(agents).toHaveLength(2);
    expect(agents[0].speaker).toContain("reasoning");
    expect(agents[0].prose).toBe("Planning the patch.");
    expect(agents[1].speaker).not.toContain("reasoning");
    expect(agents[1].prose).toBe("Tests are red; fixing.");
    const tool = t.turns[0].messages.find(
      (m) => m.type === "tool"
    ) as ToolMessage;
    expect(tool.cmd).toBe("mix test");
    expect(tool.status).toBe("err");
    expect(tool.error).toBe(true);
    expect(tool.body).toBe("2 failed");
  });

  it("maps normalized file_change to an apply_patch ToolMessage and plan to a checklist tool", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "e3" })],
      logsByExecutionId: {
        e3: [
          harnessLog(
            "e3",
            "file_change",
            {
              tool_call_id: "patch-1",
              status: "completed",
              changes: [
                { path: "lib/x.ex", kind: "update", patch: "@@ -1 +1 @@" },
              ],
            },
            "2024-01-01T10:00:02Z",
            { turnId: "turn-1" }
          ),
          harnessLog(
            "e3",
            "plan",
            {
              entries: [
                { id: "td1", text: "write test", status: "completed" },
                { id: "td2", text: "make it pass", status: "pending" },
              ],
            },
            "2024-01-01T10:00:03Z",
            { turnId: "turn-1" }
          ),
        ],
      },
    };
    const [t] = runToThreads(input);
    const tools = t.turns[0].messages.filter(
      (m) => m.type === "tool"
    ) as ToolMessage[];
    const patch = tools.find((m) => m.cmd === "apply_patch")!;
    expect(patch.em).toBe("lib/x.ex");
    expect(patch.body).toContain("@@");
    const todo = tools.find((m) => m.name === "todo_list")!;
    expect(todo.summary).toBe("1/2");
    expect(todo.body).toContain("[x] write test");
    expect(todo.body).toContain("[ ] make it pass");
  });
});

describe("runToThreads — wait_children step", () => {
  it("renders a single terminal WaitMessage, never an inlined subtree", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [
        exec({
          id: "ew",
          step_name: "wait_for_children",
          step_type: "wait_children",
          output: "Waiting on 3 child tasks",
        }),
      ],
      logsByExecutionId: {},
    };
    const [t] = runToThreads(input);
    expect(t.step?.kind).toBe("wait");
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].messages).toHaveLength(1);
    const wait = t.turns[0].messages[0] as WaitMessage;
    expect(wait.type).toBe("wait");
    expect(wait.text).toBe("Waiting on 3 child tasks");
    expect(wait.childRunIds).toEqual([]);
  });

  it("appends the step's final structured output as a terminal ResultMessage", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [
        exec({
          id: "er",
          step_name: "verify_changes",
          output: '{"note":"verified","pr_url":null}',
        }),
      ],
      logsByExecutionId: {},
    };
    const [t] = runToThreads(input);
    const result = t.turns
      .flatMap((turn) => turn.messages)
      .find((m) => m.type === "result") as ResultMessage | undefined;
    expect(result).toBeDefined();
    expect(result?.label).toBe("output");
    expect(result?.body).toBe('{"note":"verified","pr_url":null}');
  });

  it("dedups a normalized trailing assistant message that duplicates the output", () => {
    const finalText = "All set — the suite is green.";
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "ed", output: finalText })],
      logsByExecutionId: {
        ed: [
          harnessLog(
            "ed",
            "text",
            { text: finalText },
            "2024-01-01T10:00:01Z",
            {
              turnId: "turn-1",
            }
          ),
          harnessLog(
            "ed",
            "turn_finished",
            { status: "completed", result_text: finalText },
            "2024-01-01T10:00:02Z",
            { turnId: "turn-1" }
          ),
        ],
      },
    };
    const msgs = runToThreads(input)[0].turns.flatMap((t) => t.messages);
    expect(msgs.filter((m) => m.type === "result")).toHaveLength(1);
    expect(
      msgs.some(
        (m) => m.type === "agent" && (m as AgentMessage).prose === finalText
      )
    ).toBe(false);
  });

  it("falls back to handoff when output is absent", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "eh", handoff: '{"workspace":"/tmp"}' })],
      logsByExecutionId: {},
    };
    const result = runToThreads(input)[0]
      .turns.flatMap((turn) => turn.messages)
      .find((m) => m.type === "result") as ResultMessage | undefined;
    expect(result?.label).toBe("handoff");
    expect(result?.body).toBe('{"workspace":"/tmp"}');
  });
});

describe("runToThreads — normalized spawn correlation", () => {
  it("nests child events using the normalized parent tool-call correlation", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "e1" })],
      logsByExecutionId: {
        e1: [
          harnessLog(
            "e1",
            "tool_call",
            {
              tool_call_id: "task-1",
              name: "Task",
              input: { description: "explore" },
            },
            "2024-01-01T10:00:01Z",
            { turnId: "root-turn" }
          ),
          harnessLog(
            "e1",
            "text",
            { text: "Child working." },
            "2024-01-01T10:00:02Z",
            {
              streamId: "child",
              turnId: "child-turn",
              parentToolCallId: "task-1",
            }
          ),
          harnessLog(
            "e1",
            "tool_call",
            {
              tool_call_id: "child-bash",
              name: "Bash",
              input: { command: "ls" },
            },
            "2024-01-01T10:00:03Z",
            {
              streamId: "child",
              turnId: "child-turn",
              parentToolCallId: "task-1",
            }
          ),
          harnessLog(
            "e1",
            "tool_output",
            {
              tool_call_id: "child-bash",
              output: "a b c",
              status: "completed",
            },
            "2024-01-01T10:00:04Z",
            {
              streamId: "child",
              turnId: "child-turn",
              parentToolCallId: "task-1",
            }
          ),
          harnessLog(
            "e1",
            "text",
            { text: "Subagent done." },
            "2024-01-01T10:00:05Z",
            { turnId: "root-turn" }
          ),
        ],
      },
    };
    const [t] = runToThreads(input);
    const msgs = t.turns[0].messages;
    const spawn = msgs.find((m) => m.type === "spawn") as
      | SpawnMessage
      | undefined;
    expect(spawn).toBeDefined();
    expect(
      msgs.find((m) => m.type === "tool" && (m as ToolMessage).evt === "task-1")
    ).toBeUndefined();
    const child = spawn!.thread;
    const childProse = child.turns[0].messages.find(
      (m) => m.type === "agent"
    ) as AgentMessage;
    expect(childProse.prose).toBe("Child working.");
    const childTool = child.turns[0].messages.find(
      (m) => m.type === "tool"
    ) as ToolMessage;
    expect(childTool.evt).toBe("child-bash");
    expect(childTool.body).toBe("a b c");
    expect(
      msgs.filter(
        (m) =>
          m.type === "agent" && (m as AgentMessage).prose === "Subagent done."
      )
    ).toHaveLength(1);
  });
});

describe("runToRun", () => {
  it("wraps runToThreads into a single Run keyed by the task_run id", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "e1" })],
      logsByExecutionId: {},
    };
    const run = runToRun(input);
    expect(run.id).toBe(RUN_ID);
    expect(run.threads).toHaveLength(1);
  });
});

describe("msgsToThread — CHAT variant", () => {
  const msgs: ChatMsg[] = [
    { id: 1, role: "user", text: "hi" },
    {
      id: 2,
      role: "assistant",
      speaker: "sacrum",
      model: "orchestrator",
      prose: "hello",
      tools: [{ evt: "x", type: "tool", name: "query_runs" }],
    },
  ];

  it("opens one turn per user message and attaches agent rows with nested tools", () => {
    const t = msgsToThread(msgs);
    expect(t.id).toBe("chat-thread");
    expect(t.turns).toHaveLength(1);
    const [user, agent] = t.turns[0].messages;
    expect(user.type).toBe("user");
    expect((user as { text?: string }).text).toBe("hi");
    const am = agent as AgentMessage;
    expect(am.type).toBe("agent");
    expect(am.prose).toBe("hello");
    expect(am.tools).toHaveLength(1);
  });

  it("wires onToggle per (msgId, toolIndex)", () => {
    const calls: Array<[string | number, number]> = [];
    const t = msgsToThread(msgs, (id, ti) => calls.push([id, ti]));
    const am = t.turns[0].messages[1] as AgentMessage;
    am.tools![0].onToggle!();
    expect(calls).toEqual([[2, 0]]);
  });
});

describe("conversationEventsToThread", () => {
  it("retains subagent user input inside its spawned child thread", () => {
    const events: ConversationEvent[] = [
      {
        kind: "user_message",
        timestamp: "2026-08-02T00:00:00Z",
        text: "Main request",
      },
      {
        kind: "tool_call",
        timestamp: "2026-08-02T00:00:01Z",
        toolId: "spawn-1",
        toolName: "Agent",
        displayName: "delegate",
        icon: "git-branch",
        summary: "delegate",
        input: { collab_tool: "spawnAgent", prompt: "Investigate" },
      },
      {
        kind: "user_message",
        timestamp: "2026-08-02T00:00:02Z",
        text: "Child task instructions",
        parentToolUseId: "spawn-1",
      },
      {
        kind: "assistant_message",
        timestamp: "2026-08-02T00:00:03Z",
        text: "Child result",
        parentToolUseId: "spawn-1",
      },
    ];

    const thread = conversationEventsToThread(events);

    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].messages[0]).toMatchObject({
      type: "user",
      text: "Main request",
    });
    const spawn = thread.turns[0].messages.find(
      (message) => message.type === "spawn"
    ) as SpawnMessage;
    expect(spawn.thread.turns[0].messages).toMatchObject([
      { type: "user", text: "Child task instructions" },
      { type: "agent", prose: "Child result" },
    ]);
  });
});
