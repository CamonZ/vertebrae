import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createMockStepExecution,
  createMockTask,
  createMockTaskRun,
} from "../../../test/test-utils";
import type { Thread } from "../../thread/types";
import { useChatStore, type RunChatPane } from "../../../stores/chatStore";
import { RunPaneWindow } from "./RunChatPane";

const mocks = vi.hoisted(() => ({
  task: null as ReturnType<typeof createMockTask> | null,
  runs: [] as ReturnType<typeof createMockTaskRun>[],
  executions: [] as ReturnType<typeof createMockStepExecution>[],
  threads: null as Thread[] | null,
  traceError: null as string | null,
  gate: null as object | null,
  resolveGateInChat: vi.fn(),
  stopRun: vi.fn(async () => ({ status: "ok", data: null })),
}));

vi.mock("../../../hooks", () => ({
  useTask: () => ({ task: mocks.task, isLoading: false, error: null }),
  useRunTrace: () => ({
    stepExecutions: mocks.executions,
    logsByExecutionId: {},
    logBucketsByExecutionId: {},
    isLoading: false,
    error: mocks.traceError,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../hooks/useTaskRuns", () => ({
  useTaskRuns: () => ({ runs: mocks.runs, isLoading: false, error: null }),
}));

vi.mock("../../../hooks/useGateChat", () => ({
  resolveGateInChat: mocks.resolveGateInChat,
}));

vi.mock("../../../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../bindings")>();
  return {
    ...actual,
    commands: { ...actual.commands, stopRun: mocks.stopRun },
  };
});

vi.mock("../../../utils/humanInputGate", () => ({
  resolveHumanInputGate: () => mocks.gate,
}));

// Gate internals are covered by HumanInputGate.test; this pane wires its
// Resolve and Stop callbacks.
vi.mock("./HumanInputGate", () => ({
  HumanInputGate: (props: {
    stoppable: boolean;
    onStop: () => void;
    onResolve: (context: object) => void;
    context: object;
  }) => (
    <div data-testid="human-input-gate">
      <button type="button" onClick={() => props.onResolve(props.context)}>
        Resolve
      </button>
      {props.stoppable && (
        <button type="button" onClick={props.onStop}>
          Stop
        </button>
      )}
    </div>
  ),
}));

vi.mock("../../thread", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../thread")>();
  return {
    ...actual,
    runToThreads: (input: Parameters<typeof actual.runToThreads>[0]) =>
      mocks.threads ?? actual.runToThreads(input),
  };
});

function subagentThreads(): Thread[] {
  return [
    {
      id: "exec-1",
      step: { to: "implement", kind: "llm", at: "01:22:40" },
      summary: { turns: 1, tools: 0, status: "ok" },
      turns: [
        {
          id: "t0",
          messages: [
            {
              type: "spawn",
              evt: "spawn-1",
              thread: {
                id: "sub-1",
                label: "write_failing_test",
                kind: "llm",
                spawnLabel: "subagent",
                summary: { turns: 1, tools: 0, status: "ok" },
                turns: [
                  {
                    id: "st0",
                    messages: [
                      {
                        evt: "sa1",
                        type: "agent",
                        speaker: "Subagent",
                        prose: "subagent done",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ];
}

const pane: RunChatPane = {
  id: "pane-run",
  kind: "run",
  taskId: "task-1",
  runId: "run-1",
  focusThreadId: null,
  scrollRequest: null,
};

function renderPane(overrides: Partial<RunChatPane> = {}) {
  const props = {
    pane: { ...pane, ...overrides },
    paneIsActive: true,
    paneCount: 1,
    index: 0,
    isMaximized: true,
    canAddSplitPane: true,
    focusPane: vi.fn(),
    closePane: vi.fn(),
    unsplitPanes: vi.fn(),
    closeChatPanel: vi.fn(),
    toggleHistorySelector: vi.fn(() => true),
    toggleMaximized: vi.fn(),
    splitWithFreshSession: vi.fn(async () => true),
  };
  return { props, ...render(<RunPaneWindow {...props} />) };
}

describe("RunPaneWindow", () => {
  beforeEach(() => {
    mocks.task = createMockTask({ id: "task-1", title: "Ship the thing" });
    mocks.runs = [createMockTaskRun({ id: "run-1", task_id: "task-1" })];
    mocks.executions = [];
    mocks.threads = null;
    mocks.traceError = null;
    mocks.gate = null;
    mocks.resolveGateInChat.mockReset();
    mocks.stopRun.mockClear();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [pane], activePaneId: pane.id },
      panelOpen: true,
    });
  });

  it("renders one headed section per step execution in started_at order", () => {
    mocks.executions = [
      createMockStepExecution({
        id: "exec-b",
        task_run_id: "run-1",
        step_name: "review",
        started_at: "2026-01-01T00:02:00Z",
      }),
      createMockStepExecution({
        id: "exec-a",
        task_run_id: "run-1",
        step_name: "implement",
        started_at: "2026-01-01T00:01:00Z",
      }),
    ];

    const { container } = renderPane();

    expect(screen.getByTestId("run-pane-title")).toHaveTextContent(
      "Ship the thing"
    );
    const heads = [...container.querySelectorAll(".th-name")].map(
      (node) => node.textContent
    );
    expect(heads).toEqual(["implement", "review"]);
    expect(screen.queryByTestId("local-chat-composer")).toBeNull();
  });

  it("toggles the timestamp gutter from the header", () => {
    mocks.threads = subagentThreads();
    const { container } = renderPane();

    expect(container.querySelector(".evlog--bare")).not.toBeNull();
    fireEvent.click(screen.getByTestId("run-pane-timestamps"));
    expect(container.querySelector(".evlog--timed")).not.toBeNull();
    expect(screen.getByTestId("run-pane-timestamps")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("opens a subagent in a split run pane focused on that thread", () => {
    mocks.threads = subagentThreads();
    renderPane();

    fireEvent.click(screen.getByTitle("Open in focus"));

    const panes = useChatStore.getState().paneLayout.panes;
    expect(panes).toHaveLength(2);
    expect(panes[1]).toMatchObject({
      kind: "run",
      runId: "run-1",
      focusThreadId: "sub-1",
    });
  });

  it("renders only the focused subagent thread", () => {
    mocks.threads = subagentThreads();
    const { container } = renderPane({ focusThreadId: "sub-1" });

    expect(screen.getByText("subagent done")).toBeInTheDocument();
    expect(container.querySelector(".th-name")).toHaveTextContent(
      "write_failing_test"
    );
    expect(screen.queryByText("implement")).toBeNull();
    expect(screen.getByTestId("run-pane-title")).toHaveTextContent(
      "write_failing_test · Ship the thing"
    );
  });

  it("scrolls to a requested thread once it renders", async () => {
    mocks.threads = subagentThreads();
    const scrollIntoTarget = vi.fn();
    const { container, rerender, props } = renderPane();
    const scroller = screen.getByTestId("run-pane-scroll");
    Object.defineProperty(scroller, "scrollTop", {
      get: () => 0,
      set: scrollIntoTarget,
      configurable: true,
    });

    rerender(
      <RunPaneWindow
        {...props}
        pane={{ ...pane, scrollRequest: { threadId: "exec-1", nonce: 1 } }}
      />
    );

    await waitFor(() => expect(scrollIntoTarget).toHaveBeenCalled());
    expect(container.querySelector('[data-thread-id="exec-1"]')).not.toBeNull();
  });

  it("shows the gate with stop and resolves the gate chat beside the run", async () => {
    mocks.runs = [
      createMockTaskRun({ id: "run-1", task_id: "task-1", status: "waiting" }),
    ];
    mocks.task = createMockTask({
      id: "task-1",
      run_controls: {
        stoppable: true,
        runnable: false,
        disabled_reason: null,
        disabled_reason_code: null,
        active_run: null,
      },
    });
    mocks.gate = { run: mocks.runs[0] };
    const sessionId = useChatStore.getState().openSession("Gate", "/repo");
    mocks.resolveGateInChat.mockResolvedValue(sessionId);
    const beside = vi.spyOn(
      useChatStore.getState(),
      "showSessionBesideRunPane"
    );
    renderPane();

    fireEvent.click(screen.getByText("Stop"));
    expect(mocks.stopRun).toHaveBeenCalledWith({
      task_run_id: "run-1",
      task_id: null,
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Resolve"));
    });
    expect(mocks.resolveGateInChat).toHaveBeenCalled();
    expect(beside).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ id: "pane-run", runId: "run-1" })
    );
  });

  it("registers a find opener that expands matching subagents", () => {
    mocks.threads = subagentThreads();
    Element.prototype.scrollIntoView = vi.fn();
    const registerFind = vi.fn();
    const { props, rerender } = renderPane();
    rerender(<RunPaneWindow {...props} registerFind={registerFind} />);

    const openFind = registerFind.mock.calls.at(-1)?.[1] as () => boolean;
    expect(registerFind).toHaveBeenCalledWith("pane-run", expect.any(Function));
    expect(screen.queryByText("subagent done")).toBeNull();

    act(() => {
      openFind();
    });
    fireEvent.change(screen.getByTestId("pane-find-input"), {
      target: { value: "subagent done" },
    });

    expect(screen.getByText("subagent done")).toBeInTheDocument();
    expect(screen.getByTestId("pane-find-count")).toHaveTextContent("1/1");
  });

  it("renders a load error", () => {
    mocks.traceError = "boom";
    renderPane();
    expect(screen.getByTestId("run-pane-error")).toHaveTextContent("boom");
  });
});
