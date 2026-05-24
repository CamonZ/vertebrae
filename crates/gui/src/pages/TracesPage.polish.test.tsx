/**
 * Integration tests for the Traces explorer polish layer:
 *   - cross-mode filter narrowing (THREAD / FLIGHT-STRIP / CORRIDOR)
 *   - live-tail in THREAD when SessionLogCreatedEvent arrives mid-view
 *   - deep-linking via URL fragment #exec=<id>
 *   - keyboard navigation (j/k between executions, / focuses search)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  createMockTask,
  createMockStepExecution,
} from "../test/test-utils";
import { useTaskStore } from "../stores/taskStore";
import { useSessionLogStore } from "../stores/sessionLogStore";
import { TracesPage } from "./TracesPage";
import type { SessionLog } from "../bindings";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom"
  );
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("../bindings", () => ({
  commands: {
    getTask: vi.fn(async () => ({ status: "error", error: { message: "not found" } })),
    listTasks: vi.fn(async () => ({ status: "ok", data: [] })),
    getExecutionLogs: vi.fn(async () => ({ status: "ok", data: [] })),
  },
}));

vi.mock("../hooks", () => ({
  useTask: () => ({
    task: createMockTask({ id: "root", title: "Root", level: "epic" }),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskRuns: () => ({
    runs: [],
    activeRun: null,
    latestRun: null,
    resolveRun: () => ({ run: null, source: "none" }),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskRunsForTasks: () => ({
    runs: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useTaskRunTrace: () => ({
    trace: null,
    taskRuns: [],
    executions: [],
    sessionLogs: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const rollups = {
  totalRuns: 4,
  totalAttempts: 4,
  totalCost: 0,
  totalTokens: 0,
  totalWallTimeMs: 0,
};

const execRootCompletedOpus = createMockStepExecution({
  id: "exec-root-1",
  task_id: "root",
  status: "completed",
  step_name: "in_progress",
  model: "claude-opus-4",
  started_at: "2024-01-01T10:00:00.000Z",
});
const execRootFailedHaiku = createMockStepExecution({
  id: "exec-root-2",
  task_id: "root",
  status: "failed",
  step_name: "review",
  model: "claude-haiku-4",
  started_at: "2024-01-01T10:05:00.000Z",
});
const execChildCompletedOpus = createMockStepExecution({
  id: "exec-child-1",
  task_id: "child",
  status: "completed",
  step_name: "in_progress",
  model: "claude-opus-4",
  started_at: "2024-01-01T10:10:00.000Z",
});

const subtreeExecutions = [
  execRootCompletedOpus,
  execRootFailedHaiku,
  execChildCompletedOpus,
];

vi.mock("../hooks/useSubtreeExecutions", () => ({
  useSubtreeExecutions: () => ({
    executions: subtreeExecutions,
    rollups,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    subtreeTaskIds: ["root", "child"],
    isInSubtree: vi.fn(),
  }),
}));

function makeLog(execId: string, text: string, timestamp: string): SessionLog {
  const content = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
  return {
    id: `log-${execId}-${timestamp}`,
    step_execution_id: execId,
    content,
    created_at: timestamp,
  };
}

const initialLogs: Record<string, SessionLog[]> = {
  "exec-root-1": [
    makeLog("exec-root-1", "planning the root", "2024-01-01T10:00:01.000Z"),
  ],
  "exec-root-2": [
    makeLog("exec-root-2", "review failed", "2024-01-01T10:05:01.000Z"),
  ],
  "exec-child-1": [
    makeLog("exec-child-1", "child working", "2024-01-01T10:10:01.000Z"),
  ],
};

vi.mock("../hooks/useSubtreeSessionLogs", () => ({
  useSubtreeSessionLogs: (executions: { id: string | null }[]) => {
    // Subscribe to the global session log store so appends in tests trigger
    // a re-render. Merge live appends on top of `initialLogs` to mirror the
    // production hook's fetch+live composition.
    const liveBuckets = useSessionLogStore(
      (s: { logsByExecutionId: Record<string, SessionLog[]> }) =>
        s.logsByExecutionId
    );
    const out: Record<string, SessionLog[]> = {};
    for (const e of executions) {
      if (!e.id) continue;
      const base = initialLogs[e.id] ?? [];
      const live = liveBuckets[e.id] ?? [];
      out[e.id] = live.length === 0 ? base : [...base, ...live];
    }
    return {
      logsByExecutionId: out,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/traces/:taskId" element={<TracesPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  useTaskStore.setState({
    tasks: [
      createMockTask({ id: "root", title: "Root Epic", level: "epic" }),
      createMockTask({
        id: "child",
        title: "Child Ticket",
        level: "ticket",
        parent_id: "root",
      }),
    ],
    selectedTaskId: null,
    selectedTask: null,
    isLoading: false,
  });
  useSessionLogStore.setState({ logsByExecutionId: {} });
});

describe("TracesPage filters narrow all three modes", () => {
  it("status filter narrows the THREAD view", () => {
    renderAt("/traces/root?status=failed");
    // Only the failed execution's segment should remain.
    const segments = screen
      .queryAllByTestId("unified-chat-segment")
      .map((el) => el.getAttribute("data-segment-execution-id"));
    expect(new Set(segments)).toEqual(new Set(["exec-root-2"]));
  });

  it("step filter narrows the FLIGHT-STRIP markers", () => {
    renderAt("/traces/root?step=in_progress");
    // Both 'in_progress' executions are kept; the 'review' one is dropped.
    const markers = screen
      .queryAllByTestId("flight-strip-marker-main")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(new Set(markers)).toEqual(
      new Set(["exec-root-1", "exec-child-1"])
    );
  });

  it("model filter narrows the CORRIDOR nodes", () => {
    renderAt("/traces/root?model=claude-haiku-4");
    fireEvent.click(screen.getByTestId("trace-mode-option-corridor"));
    const nodes = screen
      .queryAllByTestId("corridor-node")
      .map((el) => el.getAttribute("data-execution-id"));
    expect(nodes).toEqual(["exec-root-2"]);
  });

  it("rootOnly toggle drops descendant executions across THREAD", () => {
    renderAt("/traces/root?rootOnly=1");
    const segments = screen
      .queryAllByTestId("unified-chat-segment")
      .map((el) => el.getAttribute("data-segment-execution-id"));
    expect(segments).not.toContain("exec-child-1");
    expect(new Set(segments)).toEqual(
      new Set(["exec-root-1", "exec-root-2"])
    );
  });
});

describe("TracesPage live-tail", () => {
  it("appends new SessionLog and preserves manual scroll position when auto-scroll is off", () => {
    renderAt("/traces/root");
    const view = screen.getByTestId("unified-chat-view");
    // Simulate user scrolled up to read history.
    Object.defineProperty(view, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(view, "clientHeight", {
      value: 200,
      configurable: true,
    });
    view.scrollTop = 120;
    expect(view.getAttribute("data-auto-scroll")).toBe("0");

    // Append a new log via the global store; the view should rerender.
    act(() => {
      useSessionLogStore
        .getState()
        .appendLog(
          "exec-root-1",
          makeLog(
            "exec-root-1",
            "live tail event",
            "2024-01-01T10:00:30.000Z"
          )
        );
    });

    // New event is in the DOM
    const events = screen.queryAllByTestId("unified-chat-agent-bubble");
    expect(events.some((e) => e.textContent?.includes("live tail event"))).toBe(
      true
    );
    // Scroll position is unchanged (no auto-scroll jank).
    expect(view.scrollTop).toBe(120);
  });

  it("when auto-scroll is on, scrollTop is pinned to scrollHeight on append", () => {
    renderAt("/traces/root");
    fireEvent.click(screen.getByTestId("traces-auto-scroll"));
    const view = screen.getByTestId("unified-chat-view");
    Object.defineProperty(view, "scrollHeight", {
      value: 1500,
      configurable: true,
    });
    Object.defineProperty(view, "clientHeight", {
      value: 300,
      configurable: true,
    });
    view.scrollTop = 0;
    act(() => {
      useSessionLogStore
        .getState()
        .appendLog(
          "exec-root-1",
          makeLog("exec-root-1", "tail two", "2024-01-01T10:00:40.000Z")
        );
    });
    expect(view.scrollTop).toBe(1500);
  });
});

describe("TracesPage deep-linking", () => {
  it("highlights the execution referenced by the URL fragment", () => {
    renderAt("/traces/root#exec=exec-root-2");
    const target = document.querySelector(
      '[data-segment-execution-id="exec-root-2"]'
    );
    expect(target).not.toBeNull();
    expect(target?.getAttribute("data-active")).toBe("1");
  });
});

describe("TracesPage keyboard nav", () => {
  it("/ focuses the search field", () => {
    renderAt("/traces/root");
    fireEvent.keyDown(window, { key: "/" });
    const input = screen.getByTestId(
      "trace-filter-search"
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  it("j cycles to the next execution and k cycles back", () => {
    renderAt("/traces/root");
    // First press: j picks the first execution.
    fireEvent.keyDown(window, { key: "j" });
    let active = document.querySelector('[data-active="1"]');
    expect(active?.getAttribute("data-segment-execution-id")).toBe(
      "exec-root-1"
    );
    fireEvent.keyDown(window, { key: "j" });
    active = document.querySelector('[data-active="1"]');
    expect(active?.getAttribute("data-segment-execution-id")).toBe(
      "exec-root-2"
    );
    fireEvent.keyDown(window, { key: "k" });
    active = document.querySelector('[data-active="1"]');
    expect(active?.getAttribute("data-segment-execution-id")).toBe(
      "exec-root-1"
    );
  });

  it("typing inside the search input does not trigger j/k navigation", () => {
    renderAt("/traces/root");
    const input = screen.getByTestId(
      "trace-filter-search"
    ) as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "j" });
    const active = document.querySelector('[data-active="1"]');
    expect(active).toBeNull();
  });
});

describe("TracesPage corridor pin", () => {
  it("renders the corridor-detail-pin only after a node is clicked AND only in CORRIDOR mode", () => {
    renderAt("/traces/root");
    // No pin in the default THREAD mode.
    expect(screen.queryByTestId("corridor-detail-pin")).toBeNull();

    fireEvent.click(screen.getByTestId("trace-mode-option-corridor"));
    // Switching modes alone must not render the pin — needs a click first.
    expect(screen.queryByTestId("corridor-detail-pin")).toBeNull();

    const node = screen
      .queryAllByTestId("corridor-node")
      .find((n) => n.getAttribute("data-execution-id") === "exec-root-1");
    expect(node).toBeDefined();
    fireEvent.click(node!);
    const pin = screen.getByTestId("corridor-detail-pin");
    expect(pin.getAttribute("data-execution-id")).toBe("exec-root-1");

    // Switching back to THREAD must hide the pin even though it's still pinned.
    fireEvent.click(screen.getByTestId("trace-mode-option-thread"));
    expect(screen.queryByTestId("corridor-detail-pin")).toBeNull();

    // And re-entering CORRIDOR mode brings the pin back (state is preserved).
    fireEvent.click(screen.getByTestId("trace-mode-option-corridor"));
    expect(
      screen
        .getByTestId("corridor-detail-pin")
        .getAttribute("data-execution-id")
    ).toBe("exec-root-1");
  });
});

describe("TracesPage THREAD empty-state", () => {
  it("does not render the FlightStrip when THREAD mode has zero filtered executions", () => {
    // Filter to a step name that does not match any execution.
    renderAt("/traces/root?step=nonexistent-step");
    expect(screen.queryByTestId("unified-chat-event")).toBeNull();
    // FlightStrip is gated on filteredExecutions.length > 0; with zero matches
    // it must be absent.
    expect(screen.queryByTestId("flight-strip")).toBeNull();
    expect(
      screen.queryAllByTestId("flight-strip-marker-main")
    ).toHaveLength(0);
  });
});

describe("TracesPage filter bar updates URL and exposes test ids", () => {
  it("renders status/step/model selects with the right options", () => {
    renderAt("/traces/root");
    const status = screen.getByTestId("trace-filter-status");
    const opts = within(status).queryAllByRole("option");
    const labels = opts.map((o) => (o as HTMLOptionElement).value);
    expect(labels).toContain("completed");
    expect(labels).toContain("failed");
  });
});
