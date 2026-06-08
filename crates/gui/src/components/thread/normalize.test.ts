import { describe, it, expect } from "vitest";
import {
  runToThreads,
  runToRun,
  msgsToThread,
  stepKindFromStepType,
  humanDuration,
  type RunInput,
  type ChatMsg,
} from "./normalize";
import type { SessionLog, StepExecution, TaskRun } from "../../bindings";
import type {
  AgentMessage,
  SystemMessage,
  ToolMessage,
  WaitMessage,
} from "./types";

// ===========================================================================
// Fixtures — raw JSONL log lines for both providers, mirroring the shapes in
// types/conversation.test.ts. parseSessionLogs() converts these to events.
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

function log(execId: string, obj: unknown, createdAt: string): SessionLog {
  return {
    id: `${execId}-${createdAt}`,
    step_execution_id: execId,
    content: JSON.stringify(obj),
    created_at: createdAt,
  };
}

// --- Claude (anthropic) stream-json lines ---
const claudeLogs = (execId: string): SessionLog[] => [
  log(
    execId,
    { type: "system", subtype: "init", model: "claude-sonnet-4.5", session_id: "s1" },
    "2024-01-01T10:00:01Z"
  ),
  log(
    execId,
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Let me run the tests." }] },
    },
    "2024-01-01T10:00:02Z"
  ),
  log(
    execId,
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "mix test" } },
        ],
      },
    },
    "2024-01-01T10:00:03Z"
  ),
  log(
    execId,
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-1", content: "41 tests, 0 failures", is_error: false },
        ],
      },
    },
    "2024-01-01T10:00:05Z"
  ),
  log(
    execId,
    { type: "result", subtype: "success", duration_ms: 5000, num_turns: 1, total_cost_usd: 0.01 },
    "2024-01-01T10:00:06Z"
  ),
];

// --- Codex (openai) exec --json lines ---
const codexLogs = (execId: string): SessionLog[] => [
  log(execId, { type: "thread.started", thread_id: "t1" }, "2024-01-01T10:00:01Z"),
  log(execId, { type: "turn.started" }, "2024-01-01T10:00:01Z"),
  log(
    execId,
    { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Planning the patch." } },
    "2024-01-01T10:00:02Z"
  ),
  log(
    execId,
    {
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "mix test", exit_code: 1, aggregated_output: "2 failed" },
    },
    "2024-01-01T10:00:03Z"
  ),
  log(
    execId,
    { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Tests are red; fixing." } },
    "2024-01-01T10:00:04Z"
  ),
];

// ===========================================================================

describe("stepKindFromStepType", () => {
  it("maps the five known step types and falls back to execute", () => {
    expect(stepKindFromStepType("execute")).toBe("execute");
    expect(stepKindFromStepType("evaluate")).toBe("eval");
    expect(stepKindFromStepType("route")).toBe("route");
    expect(stepKindFromStepType("human_input")).toBe("human");
    expect(stepKindFromStepType("wait_children")).toBe("wait");
    expect(stepKindFromStepType(null)).toBe("execute");
    expect(stepKindFromStepType({ unsupported: "x" })).toBe("execute");
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
        exec({ id: "e2", step_name: "second", started_at: "2024-01-01T10:05:00Z" }),
        exec({ id: "e1", step_name: "first", started_at: "2024-01-01T10:00:00Z" }),
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
      stepExecutions: [exec({ id: "e1", step_type: "evaluate", duration_ms: 9000 })],
      logsByExecutionId: {},
    };
    const [t] = runToThreads(input);
    expect(t.step?.kind).toBe("eval");
    expect(t.step?.runtime).toBe("9.0s");
    expect(t.kind).toBe("eval");
  });
});

describe("runToThreads — Claude (anthropic) turn grouping + tool pairing", () => {
  const input: RunInput = {
    taskRun: taskRun("2024-01-01T10:00:00Z"),
    stepExecutions: [exec({ id: "e1", prompt: "do the thing" })],
    logsByExecutionId: { e1: claudeLogs("e1") },
  };

  it("opens a leading SystemMessage from the interpolated prompt", () => {
    const [t] = runToThreads(input);
    const msgs = t.turns[0].messages;
    const sys = msgs[0] as SystemMessage;
    expect(sys.type).toBe("system");
    expect(sys.label).toBe("System · interpolated");
    expect(sys.text).toBe("do the thing");
  });

  it("maps assistant text to an AgentMessage prose row", () => {
    const [t] = runToThreads(input);
    const agent = t.turns[0].messages.find((m) => m.type === "agent") as AgentMessage;
    expect(agent.prose).toBe("Let me run the tests.");
    expect(agent.speaker).toBe("Agent · claude-sonnet-4.5");
  });

  it("pairs tool_call + tool_result into ONE ToolMessage card", () => {
    const [t] = runToThreads(input);
    const tools = t.turns[0].messages.filter((m) => m.type === "tool") as ToolMessage[];
    expect(tools).toHaveLength(1);
    expect(tools[0].evt).toBe("tu-1");
    expect(tools[0].kind).toBe("shell");
    expect(tools[0].cmd).toBe("mix test");
    expect(tools[0].status).toBe("done");
    expect(tools[0].body).toBe("41 tests, 0 failures");
    // session_start / session_end / tool_result produce no standalone rows.
    expect(t.summary?.tools).toBe(1);
  });
});

describe("runToThreads — Codex (openai) shapes", () => {
  const input: RunInput = {
    taskRun: taskRun("2024-01-01T10:00:00Z"),
    stepExecutions: [exec({ id: "e1", model: "codex" })],
    logsByExecutionId: { e1: codexLogs("e1") },
  };

  it("maps reasoning to a quieter agent prose and agent_message to reply prose", () => {
    const [t] = runToThreads(input);
    const agents = t.turns[0].messages.filter((m) => m.type === "agent") as AgentMessage[];
    expect(agents).toHaveLength(2);
    expect(agents[0].speaker).toContain("reasoning");
    expect(agents[0].prose).toBe("Planning the patch.");
    expect(agents[1].speaker).not.toContain("reasoning");
    expect(agents[1].prose).toBe("Tests are red; fixing.");
  });

  it("turns a failing command_execution into a shell ToolMessage with err status", () => {
    const [t] = runToThreads(input);
    const tool = t.turns[0].messages.find((m) => m.type === "tool") as ToolMessage;
    expect(tool.cmd).toBe("mix test");
    expect(tool.status).toBe("err");
    expect(tool.error).toBe(true);
    expect(tool.body).toBe("2 failed");
    expect(t.summary?.status).toBe("err");
  });
});

describe("runToThreads — error encoding + file_edit + todo_list", () => {
  it("detects the Codex [error] thinking prefix and emits an ErrorMessage", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "e1" })],
      logsByExecutionId: {
        e1: [log("e1", { type: "turn.failed", error: { message: "boom" } }, "2024-01-01T10:00:02Z")],
      },
    };
    const [t] = runToThreads(input);
    const err = t.turns[0].messages.find((m) => m.type === "error");
    expect(err).toMatchObject({ type: "error", title: "boom" });
  });

  it("maps file_change to an apply_patch ToolMessage and todo_list to a checklist tool", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "e1" })],
      logsByExecutionId: {
        e1: [
          log(
            "e1",
            {
              type: "item.completed",
              item: {
                id: "f1",
                type: "file_change",
                status: "completed",
                changes: [{ path: "lib/x.ex", kind: "update", diff: "@@ -1 +1 @@" }],
              },
            },
            "2024-01-01T10:00:02Z"
          ),
          log(
            "e1",
            {
              type: "item.completed",
              item: {
                id: "td1",
                type: "todo_list",
                items: [
                  { text: "write test", completed: true },
                  { text: "make it pass", completed: false },
                ],
              },
            },
            "2024-01-01T10:00:03Z"
          ),
        ],
      },
    };
    const [t] = runToThreads(input);
    const tools = t.turns[0].messages.filter((m) => m.type === "tool") as ToolMessage[];
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
});

describe("runToThreads — spawn nesting (BLOCKER)", () => {
  it("produces a correct FLAT thread when parent_tool_use_id is absent (no crash)", () => {
    // The parser does not expose parent_tool_use_id today, so even a stream
    // that logically contains a subagent normalizes flat — no spawn rows.
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "e1" })],
      logsByExecutionId: { e1: claudeLogs("e1") },
    };
    const [t] = runToThreads(input);
    const hasSpawn = t.turns.some((turn) =>
      turn.messages.some((m) => m.type === "spawn")
    );
    expect(hasSpawn).toBe(false);
  });
});

describe("runToRun", () => {
  it("wraps runToThreads into a single Run keyed by the task_run id", () => {
    const input: RunInput = {
      taskRun: taskRun("2024-01-01T10:00:00Z"),
      stepExecutions: [exec({ id: "e1" })],
      logsByExecutionId: { e1: claudeLogs("e1") },
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
