import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef, type ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlightStrip } from "./FlightStrip";
import type { SessionLog, StepExecution, Task } from "../../bindings";

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
  workflow_id: "wf-1",
  current_step_id: null,
  workflow_name: "Implementation",
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
  workflow_id: "wf-1",
  step_name: overrides.step_name ?? "implement",
  started_at: overrides.started_at,
  completed_at: overrides.completed_at ?? null,
  status: "completed",
  prompt: null,
  output: null,
  context: null,
  transition_result: null,
  model: overrides.model ?? "claude-opus-4",
  model_provider: "anthropic",
  input_tokens: null,
  output_tokens: null,
  cost: null,
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

const toolUse = (id: string, name: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
});

const toolResult = (toolUseId: string) => ({
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: toolUseId, content: "ok" },
    ],
  },
});

/**
 * Renders FlightStrip with a sibling scroll element so click/scrub can
 * write to a real scrollTop. Returns refs we need for assertions.
 */
function FlightStripHarness({
  scrollHeight = 1000,
  clientHeight = 200,
  ...props
}: {
  rootTaskId: string;
  executions: readonly StepExecution[];
  tasks: readonly Task[];
  logsByExecutionId: Record<string, SessionLog[]>;
  scrollHeight?: number;
  clientHeight?: number;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  // Stub a scroll element with explicit dimensions for predictable scrub math.
  return (
    <div>
      <FlightStrip {...props} threadScrollRef={ref} />
      <div
        ref={(el) => {
          if (el) {
            Object.defineProperty(el, "scrollHeight", {
              configurable: true,
              value: scrollHeight,
            });
            Object.defineProperty(el, "clientHeight", {
              configurable: true,
              value: clientHeight,
            });
          }
          ref.current = el;
        }}
        data-testid="thread-scroll"
        style={{ height: clientHeight, overflowY: "auto" }}
      >
        {props.executions.map((e) => (
          <div
            key={e.id ?? ""}
            data-execution-id={e.id ?? ""}
            style={{ height: 200 }}
          >
            row-{e.id}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// rAF / DOMRect mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1 as unknown as number;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  // jsdom returns a zero-sized rect; supply a sane width for x→ratio math.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 50,
    width: 1000,
    height: 50,
    toJSON: () => ({}),
  } as DOMRect);
  // jsdom doesn't implement scrollIntoView
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  } else {
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  }
  // pointer capture is a no-op in jsdom
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {};
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlightStrip", () => {
  it("renders all four lanes (THRESHOLD, TOOL, MAIN per task, DELEGATION) for a multi-task subtree", () => {
    const tasks = [
      makeTask({ id: "t-root", title: "Root" }),
      makeTask({ id: "t-child", title: "Child", parent_id: "t-root" }),
    ];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      step_name: "plan",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const e2 = makeExec({
      id: "e2",
      task_id: "t-child",
      step_name: "implement",
      started_at: "2024-01-01T10:05:00.000Z",
    });
    const logs = {
      e1: [
        makeLog("e1", thinking("planning"), "2024-01-01T10:00:10.000Z", 0),
        makeLog("e1", toolUse("tu1", "Bash"), "2024-01-01T10:00:20.000Z", 1),
        makeLog("e1", toolResult("tu1"), "2024-01-01T10:00:30.000Z", 2),
      ],
      e2: [makeLog("e2", thinking("doing"), "2024-01-01T10:05:30.000Z", 0)],
    };
    render(
      <FlightStripHarness
        rootTaskId="t-root"
        executions={[e1, e2]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );

    expect(screen.getByTestId("flight-strip")).toBeInTheDocument();
    expect(screen.getByTestId("flight-strip-lane-threshold")).toBeInTheDocument();
    expect(screen.getByTestId("flight-strip-lane-tool")).toBeInTheDocument();
    const mainLane = screen.getByTestId("flight-strip-lane-main");
    const rows = within(mainLane).getAllByTestId("flight-strip-main-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-task-id", "t-root");
    expect(rows[1]).toHaveAttribute("data-task-id", "t-child");

    // Threshold markers exist (start + transition)
    const thresholds = screen.getAllByTestId("flight-strip-marker-threshold");
    expect(thresholds.length).toBeGreaterThanOrEqual(2);

    // Tool markers exist
    expect(screen.getAllByTestId("flight-strip-marker-tool").length).toBe(2);

    // Delegation edge exists
    expect(
      screen.getAllByTestId("flight-strip-delegation-edge")
    ).toHaveLength(1);
  });

  it("click on a threshold marker scrolls the THREAD pane to the matching execution row", async () => {
    const tasks = [makeTask({ id: "t-root" })];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      step_name: "plan",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const e2 = makeExec({
      id: "e2",
      task_id: "t-root",
      step_name: "implement",
      started_at: "2024-01-01T10:05:00.000Z",
    });
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    render(
      <FlightStripHarness
        rootTaskId="t-root"
        executions={[e1, e2]}
        tasks={tasks}
        logsByExecutionId={{}}
      />
    );

    const transition = screen
      .getAllByTestId("flight-strip-marker-threshold")
      .find((el) => el.getAttribute("data-execution-id") === "e2");
    expect(transition).toBeDefined();

    await userEvent.click(transition!);
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("drag-to-scrub updates the viewport indicator as scrollTop changes", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const e2 = makeExec({
      id: "e2",
      task_id: "t-root",
      step_name: "next",
      started_at: "2024-01-01T11:00:00.000Z",
    });
    render(
      <FlightStripHarness
        rootTaskId="t-root"
        executions={[e1, e2]}
        tasks={tasks}
        logsByExecutionId={{}}
        scrollHeight={1000}
        clientHeight={200}
      />
    );

    const canvas = screen.getByTestId("flight-strip-canvas");
    const viewport = screen.getByTestId("flight-strip-viewport");
    const initialStart = Number(viewport.getAttribute("data-start"));
    expect(initialStart).toBeCloseTo(0, 3);

    // Pointer down near the middle of the 1000px-wide canvas (with 8px
    // padding on each side, inner width ≈ 984). scrollTop should land
    // somewhere near 50% of (scrollHeight - clientHeight) = 800 → ~400.
    act(() => {
      fireEvent.pointerDown(canvas, { clientX: 500, pointerId: 1 });
    });
    const scrollEl = screen.getByTestId("thread-scroll");
    const downScrollTop = scrollEl.scrollTop;
    expect(downScrollTop).toBeGreaterThan(380);
    expect(downScrollTop).toBeLessThan(420);

    // Fire scroll so viewport indicator recomputes
    act(() => {
      fireEvent.scroll(scrollEl);
    });
    const newStart = Number(
      screen.getByTestId("flight-strip-viewport").getAttribute("data-start")
    );
    expect(newStart).toBeGreaterThan(0);

    // Drag further to 80% → scrollTop should increase well past 600
    act(() => {
      fireEvent.pointerMove(canvas, { clientX: 800, pointerId: 1 });
    });
    expect(scrollEl.scrollTop).toBeGreaterThan(downScrollTop + 200);

    act(() => {
      fireEvent.pointerUp(canvas, { clientX: 800, pointerId: 1 });
    });
  });

  it("'Thresholds only' toggle hides TOOL and MAIN lanes but keeps THRESHOLD visible", async () => {
    const tasks = [makeTask({ id: "t-root" })];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    const logs = {
      e1: [
        makeLog("e1", thinking("planning"), "2024-01-01T10:00:10.000Z", 0),
        makeLog("e1", toolUse("tu1", "Bash"), "2024-01-01T10:00:20.000Z", 1),
      ],
    };
    render(
      <FlightStripHarness
        rootTaskId="t-root"
        executions={[e1]}
        tasks={tasks}
        logsByExecutionId={logs}
      />
    );
    // Pre-toggle: both visible
    expect(screen.getByTestId("flight-strip-lane-tool")).toBeInTheDocument();
    expect(screen.getByTestId("flight-strip-lane-main")).toBeInTheDocument();
    expect(
      screen.getAllByTestId("flight-strip-marker-tool").length
    ).toBeGreaterThan(0);

    const toggle = screen.getByTestId(
      "flight-strip-thresholds-only"
    ) as HTMLInputElement;
    await userEvent.click(toggle);
    expect(toggle.checked).toBe(true);

    // THRESHOLD remains
    expect(screen.getByTestId("flight-strip-lane-threshold")).toBeInTheDocument();
    expect(
      screen.getAllByTestId("flight-strip-marker-threshold").length
    ).toBeGreaterThan(0);

    // TOOL + MAIN gone
    expect(screen.queryByTestId("flight-strip-lane-tool")).toBeNull();
    expect(screen.queryByTestId("flight-strip-lane-main")).toBeNull();
    expect(screen.queryAllByTestId("flight-strip-marker-tool")).toHaveLength(0);
    expect(screen.queryAllByTestId("flight-strip-marker-main")).toHaveLength(0);
  });

  it("updates viewport indicator from hidden/full-width to the correct slice when scrollHeight grows after mount (async content load)", async () => {
    // ResizeObserver poly-mock — observe() should fire once immediately with
    // current size, then again whenever we manually call .trigger().
    const observers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> =
      [];
    class FakeRO {
      cb: ResizeObserverCallback;
      targets: Element[] = [];
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        observers.push(this);
      }
      observe(t: Element): void {
        this.targets.push(t);
        this.cb(
          [{ target: t } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver
        );
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    const originalRO = (globalThis as unknown as { ResizeObserver: unknown })
      .ResizeObserver;
    (globalThis as unknown as { ResizeObserver: typeof FakeRO }).ResizeObserver =
      FakeRO;

    const tasks = [makeTask({ id: "t-root" })];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      started_at: "2024-01-01T10:00:00.000Z",
    });

    // Mount with scrollHeight === clientHeight → max <= 0, not measurable.
    render(
      <FlightStripHarness
        rootTaskId="t-root"
        executions={[e1]}
        tasks={tasks}
        logsByExecutionId={{}}
        scrollHeight={200}
        clientHeight={200}
      />
    );

    // Before content has laid out: viewport must NOT be marked measured,
    // i.e. it must not be displayed full-width (the bug).
    const viewportEl = screen.getByTestId("flight-strip-viewport");
    expect(viewportEl.getAttribute("data-measured")).toBe("false");

    // Now simulate content loading: scrollHeight grows much larger than
    // clientHeight, then a ResizeObserver entry fires.
    const scrollEl = screen.getByTestId("thread-scroll");
    Object.defineProperty(scrollEl, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollEl, "clientHeight", {
      configurable: true,
      value: 200,
    });

    act(() => {
      // Re-fire all live observers' callbacks against their first target.
      for (const o of observers) {
        if (o.targets.length > 0) {
          o.cb(
            [{ target: o.targets[0] } as unknown as ResizeObserverEntry],
            o as unknown as ResizeObserver
          );
        }
      }
    });

    const after = screen.getByTestId("flight-strip-viewport");
    expect(after.getAttribute("data-measured")).toBe("true");
    // visible fraction = 200/1000 = 0.2 → end - start ≈ 0.2.
    const start = Number(after.getAttribute("data-start"));
    const end = Number(after.getAttribute("data-end"));
    expect(end - start).toBeCloseTo(0.2, 2);
    expect(start).toBeCloseTo(0, 2);

    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      originalRO;
  });

  it("seeds viewport once threadScrollRef.current is attached on a later tick (ref starts null)", () => {
    // Component that delays attaching the ref via state flip on next tick.
    function DelayedRefHarness(): ReactNode {
      const ref = useRef<HTMLElement | null>(null);
      const tasks = [makeTask({ id: "t-root" })];
      const e1 = makeExec({
        id: "e1",
        task_id: "t-root",
        started_at: "2024-01-01T10:00:00.000Z",
      });
      return (
        <div>
          <FlightStrip
            rootTaskId="t-root"
            executions={[e1]}
            tasks={tasks}
            logsByExecutionId={{}}
            threadScrollRef={ref}
          />
          <div
            data-testid="thread-scroll"
            ref={(el) => {
              if (el) {
                Object.defineProperty(el, "scrollHeight", {
                  configurable: true,
                  value: 1000,
                });
                Object.defineProperty(el, "clientHeight", {
                  configurable: true,
                  value: 250,
                });
              }
              // Simulate ref being wired on the next tick by deferring.
              setTimeout(() => {
                ref.current = el;
              }, 0);
            }}
            style={{ height: 250, overflowY: "auto" }}
          />
        </div>
      );
    }

    // requestAnimationFrame is synchronously stubbed in beforeEach. The
    // effect's poll loop will keep recursing until ref.current is non-null;
    // we therefore replace it with a one-shot stub that schedules via real
    // setTimeout(0) so the ref can land first.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0) as unknown as number
    );

    vi.useFakeTimers();
    try {
      render(<DelayedRefHarness />);

      // Before timers run: ref still null, viewport not measured.
      const before = screen.getByTestId("flight-strip-viewport");
      expect(before.getAttribute("data-measured")).toBe("false");

      // Advance: ref attach setTimeout(0) fires, then poll-rAF setTimeout(0)
      // notices ref.current is set and measures.
      act(() => {
        vi.runAllTimers();
      });

      const after = screen.getByTestId("flight-strip-viewport");
      expect(after.getAttribute("data-measured")).toBe("true");
      const start = Number(after.getAttribute("data-start"));
      const end = Number(after.getAttribute("data-end"));
      // visible = 250/1000 = 0.25
      expect(end - start).toBeCloseTo(0.25, 2);
      expect(start).toBeCloseTo(0, 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders nothing-but-thresholds when there are no tools or thinking events", () => {
    const tasks = [makeTask({ id: "t-root" })];
    const e1 = makeExec({
      id: "e1",
      task_id: "t-root",
      started_at: "2024-01-01T10:00:00.000Z",
    });
    render(
      <FlightStripHarness
        rootTaskId="t-root"
        executions={[e1]}
        tasks={tasks}
        logsByExecutionId={{}}
      />
    );
    expect(screen.queryAllByTestId("flight-strip-marker-tool")).toHaveLength(0);
    expect(screen.queryAllByTestId("flight-strip-marker-main")).toHaveLength(0);
    expect(
      screen.getAllByTestId("flight-strip-marker-threshold").length
    ).toBeGreaterThan(0);
  });
});
