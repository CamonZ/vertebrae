import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { UnifiedChatView } from "./UnifiedChatView";
import type { SessionLog, StepExecution, Task, Workflow } from "../../bindings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeTask = (overrides: Partial<Task> & { id: string }): Task => ({
  id: overrides.id,
  title: overrides.title ?? `task-${overrides.id}`,
  description: null,
  level: overrides.level ?? "ticket",
  priority: null,
  tags: [],
  workflow_id: overrides.workflow_id ?? "wf-1",
  current_step_id: null,
  workflow_name: overrides.workflow_name ?? "Implementation",
  step_name: null,
  needs_human_review: null,
  archived: false,
  worktree: null,
  review_comment: null,
  revision_feedback: null,
  rejection_reason: null,
  parent_id: overrides.parent_id ?? null,
  dependency_ids: [],
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
  started_at: null,
  completed_at: null,
});

const makeExec = (
  overrides: Partial<StepExecution> & { id: string; task_id: string }
): StepExecution => ({
  id: overrides.id,
  task_id: overrides.task_id,
  workflow_id: overrides.workflow_id ?? "wf-1",
  step_name: overrides.step_name ?? "implement",
  step_type: overrides.step_type ?? "human_input",
  started_at: overrides.started_at ?? "2024-01-01T10:00:00.000Z",
  completed_at: overrides.completed_at ?? null,
  status: overrides.status ?? "completed",
  prompt: null,
  output: null,
  context: null,
  transition_result: null,
  model: overrides.model ?? "claude-opus-4",
  model_provider: "anthropic",
  input_tokens: null,
  output_tokens: null,
  cost: overrides.cost ?? "0.05",
  duration_ms: null,
  handoff: null,
  session_id: null,
});

const makeLog = (
  execId: string,
  content: object,
  createdAt: string,
  idx: number
): SessionLog => ({
  id: `log-${execId}-${idx}`,
  step_execution_id: execId,
  content: JSON.stringify(content),
  created_at: createdAt,
});

const thinking = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnifiedChatView", () => {
  it("renders empty state when there are no executions", () => {
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[]}
        tasks={[makeTask({ id: "t-root" })]}
        logsByExecutionId={{}}
      />
    );
    expect(screen.getByTestId("unified-chat-empty")).toBeInTheDocument();
    expect(screen.getByTestId("unified-chat-view")).toBeInTheDocument();
  });

  it("renders loading state when isLoading and no segments yet", () => {
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[]}
        tasks={[makeTask({ id: "t-root" })]}
        logsByExecutionId={{}}
        isLoading
      />
    );
    expect(screen.getByTestId("unified-chat-loading")).toBeInTheDocument();
  });

  it("renders error chip when error is provided", () => {
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[]}
        tasks={[makeTask({ id: "t-root" })]}
        logsByExecutionId={{}}
        error="boom"
      />
    );
    const err = screen.getByTestId("unified-chat-error");
    expect(err).toHaveTextContent(/Failed to load conversation/);
    expect(err).toHaveTextContent("boom");
  });

  it("merges events from multiple executions into one continuous scroll surface", () => {
    const tasks = [makeTask({ id: "t-root", title: "Root" })];
    const execA = makeExec({
      id: "exec-a",
      task_id: "t-root",
      step_name: "plan",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const execB = makeExec({
      id: "exec-b",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:05:00.000Z",
    });
    const logs = {
      "exec-a": [
        makeLog(
          "exec-a",
          thinking("planning step"),
          "2024-01-01T10:00:01.000Z",
          0
        ),
      ],
      "exec-b": [
        makeLog(
          "exec-b",
          thinking("implementing step"),
          "2024-01-01T10:05:01.000Z",
          0
        ),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[execA, execB]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );

    // Single scroll container
    const view = screen.getByTestId("unified-chat-view");
    expect(view).toBeInTheDocument();
    const containers = screen.getAllByTestId("unified-chat-view");
    expect(containers).toHaveLength(1);

    // Both executions' events render inside the same surface
    const events = within(view).getAllByTestId("unified-chat-event");
    expect(events).toHaveLength(2);
    expect(events[0]).toHaveAttribute("data-execution-id", "exec-a");
    expect(events[1]).toHaveAttribute("data-execution-id", "exec-b");
    expect(within(view).getByText("planning step")).toBeInTheDocument();
    expect(within(view).getByText("implementing step")).toBeInTheDocument();

    // Two distinct sticky step boundaries — visually distinct, not just <hr>
    const boundaries = within(view).getAllByTestId(
      "unified-chat-step-boundary"
    );
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toHaveAttribute("data-step-name", "plan");
    expect(boundaries[1]).toHaveAttribute("data-step-name", "implement");
    // Sticky positioning — the regression test for the per-execution box
    // anti-pattern. Each boundary is `position: sticky` inside the shared
    // scroll surface.
    expect(boundaries[0].className).toContain("sticky");
  });

  it("renders an inline transition marker between consecutive executions on the same task", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const execA = makeExec({
      id: "exec-a",
      task_id: "t-root",
      step_name: "plan",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const execB = makeExec({
      id: "exec-b",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:05:00.000Z",
    });
    const logs = {
      "exec-a": [
        makeLog("exec-a", thinking("a"), "2024-01-01T10:00:01.000Z", 0),
      ],
      "exec-b": [
        makeLog("exec-b", thinking("b"), "2024-01-01T10:05:01.000Z", 0),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[execA, execB]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    const transition = screen.getByTestId("unified-chat-transition");
    expect(transition).toHaveAttribute("data-from-step", "plan");
    expect(transition).toHaveAttribute("data-to-step", "implement");
    expect(transition).toHaveAttribute("data-task-id", "t-root");
  });

  it("renders one segment per execution when timestamps interleave", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const execA = makeExec({
      id: "exec-a",
      task_id: "t-root",
      step_name: "plan",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const execB = makeExec({
      id: "exec-b",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:00:01.000Z",
    });
    const logs = {
      "exec-a": [
        makeLog("exec-a", thinking("a-1"), "2024-01-01T10:00:01.000Z", 0),
        makeLog("exec-a", thinking("a-2"), "2024-01-01T10:00:03.000Z", 1),
      ],
      "exec-b": [
        makeLog("exec-b", thinking("b-1"), "2024-01-01T10:00:02.000Z", 0),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[execA, execB]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );

    const segments = screen.getAllByTestId("unified-chat-segment");
    expect(segments).toHaveLength(2);
    expect(
      segments.map((segment) =>
        segment.getAttribute("data-segment-execution-id")
      )
    ).toEqual(["exec-a", "exec-b"]);
    expect(screen.getAllByTestId("unified-chat-step-boundary")).toHaveLength(2);
    expect(within(segments[0]).getByText("a-1")).toBeInTheDocument();
    expect(within(segments[0]).getByText("a-2")).toBeInTheDocument();
    expect(within(segments[1]).getByText("b-1")).toBeInTheDocument();
  });

  it("renders a delegation block for a descendant task with its own boundary header indented", () => {
    const tasks = [
      makeTask({ id: "t-root", title: "Root Task" }),
      makeTask({ id: "t-child", title: "Child Task", parent_id: "t-root" }),
    ];
    const parentExec = makeExec({
      id: "exec-parent",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const childExec = makeExec({
      id: "exec-child",
      task_id: "t-child",
      step_name: "review",
      started_at: "2024-01-01T10:01:00.000Z",
    });
    const logs = {
      "exec-parent": [
        makeLog(
          "exec-parent",
          thinking("parent thinking"),
          "2024-01-01T10:00:30.000Z",
          0
        ),
      ],
      "exec-child": [
        makeLog(
          "exec-child",
          thinking("child thinking"),
          "2024-01-01T10:01:30.000Z",
          0
        ),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[parentExec, childExec]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    const delegation = screen.getByTestId("unified-chat-delegation");
    expect(delegation).toHaveAttribute("data-parent-task-id", "t-root");
    expect(delegation).toHaveAttribute("data-child-task-id", "t-child");
    // Indented (depth ≥ 1)
    expect(
      Number(delegation.getAttribute("data-depth"))
    ).toBeGreaterThanOrEqual(1);
    // Has its own boundary header inside
    const innerBoundary = within(delegation).getByTestId(
      "unified-chat-step-boundary"
    );
    expect(innerBoundary).toHaveAttribute("data-task-id", "t-child");
    expect(innerBoundary).toHaveAttribute("data-step-name", "review");
    // Child's events appear inside the delegation block, not flat
    expect(within(delegation).getByText("child thinking")).toBeInTheDocument();
  });

  it("sorts events by timestamp across executions, then by execution start_at, then by index", () => {
    const tasks = [makeTask({ id: "t-root" })];
    // Two executions; execA started first but its event timestamp is later
    // than execB's event timestamp — output order must follow timestamp.
    const execA = makeExec({
      id: "exec-a",
      task_id: "t-root",
      step_name: "first",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const execB = makeExec({
      id: "exec-b",
      task_id: "t-root",
      step_name: "second",
      started_at: "2024-01-01T10:00:05.000Z",
    });
    const sharedTs = "2024-01-01T10:00:10.000Z";
    const logs = {
      "exec-a": [
        makeLog("exec-a", thinking("A-late"), "2024-01-01T10:00:20.000Z", 0),
      ],
      "exec-b": [
        // Tie with itself on timestamp — preserved by eventIndex
        makeLog("exec-b", thinking("B-tie-1"), sharedTs, 0),
        makeLog("exec-b", thinking("B-tie-2"), sharedTs, 1),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[execA, execB]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    const events = screen.getAllByTestId("unified-chat-event");
    const texts = events.map((e) => e.textContent);
    // Expected order: B-tie-1, B-tie-2 (10:00:10), then A-late (10:00:20)
    expect(texts[0]).toContain("B-tie-1");
    expect(texts[1]).toContain("B-tie-2");
    expect(texts[2]).toContain("A-late");
  });

  it("does NOT render Session Started or Session Complete cards — facts fold into the boundary header", () => {
    const tasks = [makeTask({ id: "t-root", title: "Root" })];
    const exec = makeExec({
      id: "exec-a",
      task_id: "t-root",
      step_name: "implement",
      cost: "0",
    });
    // Session start (system/init) and session end (result) wrapped per the
    // raw payload shapes parseSessionLog accepts.
    const sessionStart = {
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-sonnet-4-6",
    };
    const sessionEnd = {
      type: "result",
      subtype: "success",
      duration_ms: 12500,
      num_turns: 4,
      total_cost_usd: 0.31,
    };
    const logs = {
      "exec-a": [
        makeLog("exec-a", sessionStart, "2024-01-01T10:00:00.000Z", 0),
        makeLog(
          "exec-a",
          thinking("doing the thing"),
          "2024-01-01T10:00:05.000Z",
          1
        ),
        makeLog("exec-a", sessionEnd, "2024-01-01T10:00:12.500Z", 2),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[exec]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );

    // No standalone session banner cards anywhere in the DOM.
    expect(screen.queryByText("Session Started")).toBeNull();
    expect(screen.queryByText("Session Complete")).toBeNull();
    // The thinking event still renders.
    expect(screen.getByText("doing the thing")).toBeInTheDocument();

    // Folded facts appear in the boundary header.
    const boundary = screen.getByTestId("unified-chat-step-boundary");
    expect(within(boundary).getByText("claude-sonnet-4-6")).toBeInTheDocument();
    expect(
      within(boundary).getByTestId("step-boundary-duration").textContent
    ).toBe("12.5s");
    expect(
      within(boundary).getByTestId("step-boundary-turns").textContent
    ).toBe("4 turns");
    expect(within(boundary).getByTestId("step-boundary-cost").textContent).toBe(
      "$0.31"
    );

    // Only the thinking event survives in the renderable event list — the
    // session_start / session_end events were folded out.
    const events = screen.getAllByTestId("unified-chat-event");
    expect(events).toHaveLength(1);
    expect(events[0].textContent).toContain("doing the thing");
  });

  it("hides the task title in the boundary when the segment is on the root task (single-task scope)", () => {
    const tasks = [makeTask({ id: "t-root", title: "Root Task Title" })];
    const exec = makeExec({
      id: "exec-a",
      task_id: "t-root",
      step_name: "plan",
    });
    const logs = {
      "exec-a": [
        makeLog("exec-a", thinking("hi"), "2024-01-01T10:00:01.000Z", 0),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[exec]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    const boundary = screen.getByTestId("unified-chat-step-boundary");
    expect(boundary.getAttribute("data-task-title-placement")).toBe("hidden");
    expect(within(boundary).queryByText("Root Task Title")).toBeNull();
  });

  it("renders descendant task titles as a subtitle in subtree views (multi-task scope)", () => {
    const tasks = [
      makeTask({ id: "t-root", title: "Root" }),
      makeTask({
        id: "t-child",
        title: "Child Task Subtitle",
        parent_id: "t-root",
      }),
    ];
    const parentExec = makeExec({
      id: "exec-parent",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const childExec = makeExec({
      id: "exec-child",
      task_id: "t-child",
      step_name: "review",
      started_at: "2024-01-01T10:01:00.000Z",
    });
    const logs = {
      "exec-parent": [
        makeLog("exec-parent", thinking("p"), "2024-01-01T10:00:30.000Z", 0),
      ],
      "exec-child": [
        makeLog("exec-child", thinking("c"), "2024-01-01T10:01:30.000Z", 0),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[parentExec, childExec]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    const boundaries = screen.getAllByTestId("unified-chat-step-boundary");
    const childBoundary = boundaries.find(
      (b) => b.getAttribute("data-task-id") === "t-child"
    );
    expect(childBoundary).toBeDefined();
    expect(childBoundary!.getAttribute("data-task-title-placement")).toBe(
      "subtitle"
    );
    const subtitle = within(childBoundary!).getByTestId(
      "step-boundary-task-subtitle"
    );
    expect(subtitle.textContent).toBe("Child Task Subtitle");
  });

  it("uses 'time after' (not 'time before') as the differential-mode hint label", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const exec = makeExec({ id: "exec-a", task_id: "t-root" });
    const logs = {
      "exec-a": [
        makeLog("exec-a", thinking("hi"), "2024-01-01T10:00:01.000Z", 0),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[exec]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    // Default mode is absolute; flipping the affordance reads "time after".
    const view = screen.getByTestId("unified-chat-view");
    // The label is the static affordance hint at the top of the view.
    expect(within(view).getByText(/HH:MM:SS\.mmm/)).toBeInTheDocument();
    expect(within(view).queryByText(/time before/)).toBeNull();
  });

  it("step boundary is visually distinct from event rows (not a plain hr)", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const exec = makeExec({
      id: "exec-a",
      task_id: "t-root",
      step_name: "plan",
    });
    const logs = {
      "exec-a": [
        makeLog("exec-a", thinking("hello"), "2024-01-01T10:00:01.000Z", 0),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[exec]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    const boundary = screen.getByTestId("unified-chat-step-boundary");
    // Has the workflow + step badges
    expect(within(boundary).getByText("Implementation")).toBeInTheDocument();
    expect(within(boundary).getByText("plan")).toBeInTheDocument();
    // Cost rendered (formatCost — $0.05)
    expect(within(boundary).getByText("$0.05")).toBeInTheDocument();
    // Model rendered
    expect(within(boundary).getByText("claude-opus-4")).toBeInTheDocument();
    // Not an <hr>
    expect(boundary.tagName).not.toBe("HR");
  });

  it("each execution's workflow tag reflects the workflow it ran in, not the task's current workflow", () => {
    // Task currently lives in the Implementation workflow (post-routing).
    const tasks = [
      makeTask({
        id: "t-root",
        workflow_id: "wf-impl",
        workflow_name: "Implementation",
      }),
    ];
    // Two historical executions: the first ran under Backlog (wf-backlog),
    // the second under Implementation (wf-impl) after the route.
    const execBacklog = makeExec({
      id: "exec-backlog",
      task_id: "t-root",
      workflow_id: "wf-backlog",
      step_name: "triage",
      started_at: "2024-01-01T09:00:00.000Z",
    });
    const execImpl = makeExec({
      id: "exec-impl",
      task_id: "t-root",
      workflow_id: "wf-impl",
      step_name: "implement",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const logs = {
      "exec-backlog": [
        makeLog(
          "exec-backlog",
          thinking("triaging"),
          "2024-01-01T09:00:01.000Z",
          0
        ),
      ],
      "exec-impl": [
        makeLog(
          "exec-impl",
          thinking("implementing"),
          "2024-01-01T10:00:01.000Z",
          0
        ),
      ],
    };
    const workflows: Workflow[] = [
      {
        id: "wf-backlog",
        name: "Backlog",
        description: null,
        initial_step: null,
        kanban_column: null,
        steps: [],
        position: 0,
      } as unknown as Workflow,
      {
        id: "wf-impl",
        name: "Implementation",
        description: null,
        initial_step: null,
        kanban_column: null,
        steps: [],
        position: 1,
      } as unknown as Workflow,
    ];

    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[execBacklog, execImpl]}
        tasks={tasks}
        workflows={workflows}
        logsByExecutionId={logs}
      />
    );

    const boundaries = screen.getAllByTestId("unified-chat-step-boundary");
    expect(boundaries).toHaveLength(2);
    // Boundaries are ordered chronologically — Backlog first, then Implementation.
    const [backlogBoundary, implBoundary] = boundaries;
    expect(backlogBoundary.getAttribute("data-execution-id")).toBe(
      "exec-backlog"
    );
    expect(implBoundary.getAttribute("data-execution-id")).toBe("exec-impl");
    expect(within(backlogBoundary).getByText("Backlog")).toBeInTheDocument();
    expect(within(backlogBoundary).queryByText("Implementation")).toBeNull();
    expect(
      within(implBoundary).getByText("Implementation")
    ).toBeInTheDocument();
  });

  it("falls back to the task's current workflow_name when no workflows prop is provided", () => {
    const tasks = [
      makeTask({
        id: "t-root",
        workflow_id: "wf-impl",
        workflow_name: "Implementation",
      }),
    ];
    const exec = makeExec({
      id: "exec-a",
      task_id: "t-root",
      workflow_id: "wf-backlog",
      step_name: "triage",
    });
    const logs = {
      "exec-a": [
        makeLog("exec-a", thinking("hi"), "2024-01-01T10:00:01.000Z", 0),
      ],
    };
    render(
      <UnifiedChatView
        rootTaskId="t-root"
        executions={[exec]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    const boundary = screen.getByTestId("unified-chat-step-boundary");
    // Without a workflows lookup table, resolution can't map wf-backlog →
    // "Backlog" so we fall back to the task's current workflow name.
    expect(within(boundary).getByText("Implementation")).toBeInTheDocument();
  });

  describe("waiting human_input gate", () => {
    function makeRunProjection(
      runs: Array<{
        id: string;
        status: "waiting" | "executing" | "completed";
        executions: StepExecution[];
        latestExecutionId?: string;
      }>
    ) {
      const runsById = new Map<string, ReturnType<typeof buildNode>>();
      function buildNode(args: {
        id: string;
        status: "waiting" | "executing" | "completed";
        executions: StepExecution[];
        latestExecutionId?: string;
      }) {
        return {
          run: {
            id: args.id,
            task_id: "t-root",
            project_id: "project-1",
            user_id: null,
            status: args.status,
            started_at: "2024-01-01T10:00:00.000Z",
            ended_at: null,
            stop_requested_at: null,
            latest_step_execution_id: args.latestExecutionId ?? null,
            outcome_kind: null,
            outcome_context: null,
            parent_task_run_id: null,
            root_task_run_id: null,
            triggered_by_step_execution_id: null,
            inserted_at: null,
            updated_at: null,
          },
          task: null,
          depth: 0,
          executions: args.executions,
          childRunIds: [],
        };
      }
      const ordered = runs.map(buildNode);
      for (const node of ordered) runsById.set(node.run.id, node);
      const runIdByExecutionId = new Map<string, string>();
      for (const node of ordered) {
        for (const e of node.executions) {
          if (e.id) runIdByExecutionId.set(e.id, node.run.id);
        }
      }
      const orderedTaskGroups = ordered.map((node) => ({
        taskId: node.run.task_id,
        task: null,
        depth: node.depth,
        runs: [node],
        childTaskIds: [],
      }));
      const taskGroupsById = new Map(
        orderedTaskGroups.map((group) => [group.taskId, group])
      );
      return {
        orderedTaskGroups,
        taskGroupsById,
        orderedRuns: ordered,
        runsById,
        delegationEdges: [],
        orphanExecutions: [],
        runIdByExecutionId,
        hasRuns: ordered.length > 0,
      };
    }

    it("renders the gate when the active TaskRun is waiting on human_input", () => {
      const tasks = [makeTask({ id: "t-root", title: "Root" })];
      const exec = makeExec({
        id: "exec-wait",
        task_id: "t-root",
        task_run_id: "run-1",
        step_name: "approval",
        started_at: "2024-01-01T10:00:00.000Z",
        status: "in_progress",
        prompt: "Approve change?",
      });
      const projection = makeRunProjection([
        {
          id: "run-1",
          status: "waiting",
          executions: [exec],
          latestExecutionId: "exec-wait",
        },
      ]);
      const logs = {
        "exec-wait": [
          makeLog("exec-wait", thinking("hi"), "2024-01-01T10:00:01.000Z", 0),
        ],
      };
      render(
        <UnifiedChatView
          rootTaskId="t-root"
          executions={[exec]}
          tasks={tasks}
          runProjection={projection}
          logsByExecutionId={logs}
        />
      );
      const gate = screen.getByTestId("human-input-gate");
      expect(gate).toHaveAttribute("data-run-id", "run-1");
      expect(gate).toHaveAttribute("data-execution-id", "exec-wait");
      expect(
        within(gate).getByTestId("human-input-gate-step")
      ).toHaveTextContent("approval");
      // No submit/approve/bypass action is exposed.
      expect(
        within(gate).queryByRole("button", { name: /approve/i })
      ).toBeNull();
      expect(
        within(gate).queryByRole("button", { name: /submit/i })
      ).toBeNull();
    });

    it("does not render Stop unless activeRunStoppable is true", () => {
      const tasks = [makeTask({ id: "t-root" })];
      const exec = makeExec({
        id: "exec-wait",
        task_id: "t-root",
        task_run_id: "run-1",
        step_name: "approval",
      });
      const projection = makeRunProjection([
        { id: "run-1", status: "waiting", executions: [exec] },
      ]);
      const onStop = vi.fn();
      const { rerender } = render(
        <UnifiedChatView
          rootTaskId="t-root"
          executions={[exec]}
          tasks={tasks}
          runProjection={projection}
          logsByExecutionId={{
            "exec-wait": [
              makeLog(
                "exec-wait",
                thinking("a"),
                "2024-01-01T10:00:01.000Z",
                0
              ),
            ],
          }}
          activeRunStoppable={false}
          onStopActiveRun={onStop}
        />
      );
      expect(
        screen.queryByTestId("human-input-gate-stop")
      ).not.toBeInTheDocument();

      rerender(
        <UnifiedChatView
          rootTaskId="t-root"
          executions={[exec]}
          tasks={tasks}
          runProjection={projection}
          logsByExecutionId={{
            "exec-wait": [
              makeLog(
                "exec-wait",
                thinking("a"),
                "2024-01-01T10:00:01.000Z",
                0
              ),
            ],
          }}
          activeRunStoppable={true}
          onStopActiveRun={onStop}
        />
      );
      expect(screen.getByTestId("human-input-gate-stop")).toBeEnabled();
    });

    it("does not render the gate for wait_children waiting runs with custom step names", () => {
      const tasks = [makeTask({ id: "t-root" })];
      const exec = makeExec({
        id: "exec-wait",
        task_id: "t-root",
        task_run_id: "run-1",
        step_name: "wait",
        step_type: "wait_children",
      });
      const projection = makeRunProjection([
        {
          id: "run-1",
          status: "waiting",
          executions: [exec],
          latestExecutionId: "exec-wait",
        },
      ]);
      render(
        <UnifiedChatView
          rootTaskId="t-root"
          executions={[exec]}
          tasks={tasks}
          runProjection={projection}
          logsByExecutionId={{
            "exec-wait": [
              makeLog(
                "exec-wait",
                thinking("a"),
                "2024-01-01T10:00:01.000Z",
                0
              ),
            ],
          }}
        />
      );
      expect(screen.queryByTestId("human-input-gate")).not.toBeInTheDocument();
    });

    it("renders the gate for human_input even when the display step name is wait_children", () => {
      const tasks = [makeTask({ id: "t-root" })];
      const exec = makeExec({
        id: "exec-wait",
        task_id: "t-root",
        task_run_id: "run-1",
        step_name: "wait_children",
        step_type: "human_input",
      });
      const projection = makeRunProjection([
        {
          id: "run-1",
          status: "waiting",
          executions: [exec],
          latestExecutionId: "exec-wait",
        },
      ]);
      render(
        <UnifiedChatView
          rootTaskId="t-root"
          executions={[exec]}
          tasks={tasks}
          runProjection={projection}
          logsByExecutionId={{}}
        />
      );
      expect(screen.getByTestId("human-input-gate")).toBeInTheDocument();
    });

    it("renders the gate even when there are no events yet", () => {
      const tasks = [makeTask({ id: "t-root" })];
      const exec = makeExec({
        id: "exec-wait",
        task_id: "t-root",
        task_run_id: "run-1",
        step_name: "approval",
      });
      const projection = makeRunProjection([
        { id: "run-1", status: "waiting", executions: [exec] },
      ]);
      render(
        <UnifiedChatView
          rootTaskId="t-root"
          executions={[]}
          tasks={tasks}
          runProjection={projection}
          logsByExecutionId={{}}
        />
      );
      expect(screen.getByTestId("human-input-gate")).toBeInTheDocument();
    });
  });
});
