import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRef, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CorridorView } from "./CorridorView";
import type { StepExecution, Task } from "../../bindings";

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
  status: overrides.status ?? "completed",
  prompt: null,
  output: null,
  context: null,
  transition_result: null,
  model: "claude-opus-4",
  model_provider: "anthropic",
  input_tokens: null,
  output_tokens: null,
  cost: null,
  duration_ms: null,
  handoff: null,
  session_id: null,
});

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
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

interface HarnessProps {
  rootTaskId: string;
  executions: readonly StepExecution[];
  tasks: readonly Task[];
  onPinExecution?: (id: string) => void;
}

function Harness(props: HarnessProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div>
      <CorridorView
        rootTaskId={props.rootTaskId}
        executions={props.executions}
        tasks={props.tasks}
        threadScrollRef={ref}
        onPinExecution={props.onPinExecution}
      />
      <div ref={ref} data-testid="thread-scroll">
        {props.executions.map((e) => (
          <div
            key={e.id ?? ""}
            data-execution-id={e.id ?? ""}
            style={{ height: 100 }}
          >
            row-{e.id}
          </div>
        ))}
      </div>
    </div>
  );
}

describe("CorridorView", () => {
  it("renders a node per execution at the layout-computed position", () => {
    const tasks = [
      makeTask({ id: "root" }),
      makeTask({ id: "child", parent_id: "root" }),
    ];
    const executions = [
      makeExec({ id: "e1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
      makeExec({ id: "e2", task_id: "root", started_at: "2024-01-01T00:00:30Z" }),
      makeExec({ id: "e3", task_id: "child", started_at: "2024-01-01T00:01:00Z" }),
    ];

    render(
      <Harness rootTaskId="root" executions={executions} tasks={tasks} />
    );

    const nodes = screen.getAllByTestId("corridor-node");
    expect(nodes).toHaveLength(3);

    const e1 = nodes.find((n) => n.dataset.executionId === "e1");
    const e2 = nodes.find((n) => n.dataset.executionId === "e2");
    const e3 = nodes.find((n) => n.dataset.executionId === "e3");

    expect(e1?.dataset.column).toBe("0");
    expect(e1?.dataset.row).toBe("0");
    expect(e2?.dataset.column).toBe("0");
    expect(e2?.dataset.row).toBe("1");
    expect(e3?.dataset.column).toBe("1");
    expect(e3?.dataset.row).toBe("0");

    // Same column nodes share x; different columns differ in x.
    expect(e1?.dataset.x).toBe(e2?.dataset.x);
    expect(e1?.dataset.x).not.toBe(e3?.dataset.x);
  });

  it("renders transition edges between consecutive executions of a task", () => {
    const tasks = [makeTask({ id: "root" })];
    const executions = [
      makeExec({ id: "e1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
      makeExec({ id: "e2", task_id: "root", started_at: "2024-01-01T00:00:30Z" }),
    ];

    render(
      <Harness rootTaskId="root" executions={executions} tasks={tasks} />
    );

    const transitions = screen.getAllByTestId("corridor-edge-transition");
    expect(transitions).toHaveLength(1);
    expect(transitions[0].getAttribute("data-from-execution-id")).toBe("e1");
    expect(transitions[0].getAttribute("data-to-execution-id")).toBe("e2");
  });

  it("renders a delegation edge from parent's last execution to child's first", () => {
    const tasks = [
      makeTask({ id: "root" }),
      makeTask({ id: "child", parent_id: "root" }),
    ];
    const executions = [
      makeExec({ id: "p1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
      makeExec({ id: "p2", task_id: "root", started_at: "2024-01-01T00:00:20Z" }),
      makeExec({ id: "c1", task_id: "child", started_at: "2024-01-01T00:00:30Z" }),
    ];

    render(
      <Harness rootTaskId="root" executions={executions} tasks={tasks} />
    );

    const delegations = screen.getAllByTestId("corridor-edge-delegation");
    expect(delegations).toHaveLength(1);
    expect(delegations[0].getAttribute("data-from-execution-id")).toBe("p2");
    expect(delegations[0].getAttribute("data-to-execution-id")).toBe("c1");
  });

  it("applies failure border style to failed nodes and active styling to in_progress nodes", () => {
    const tasks = [makeTask({ id: "root" })];
    const executions = [
      makeExec({
        id: "e-failed",
        task_id: "root",
        started_at: "2024-01-01T00:00:00Z",
        status: "failed",
      }),
      makeExec({
        id: "e-active",
        task_id: "root",
        started_at: "2024-01-01T00:00:10Z",
        status: "in_progress",
      }),
      makeExec({
        id: "e-done",
        task_id: "root",
        started_at: "2024-01-01T00:00:20Z",
        status: "completed",
      }),
    ];

    render(
      <Harness rootTaskId="root" executions={executions} tasks={tasks} />
    );

    const failed = screen
      .getAllByTestId("corridor-node")
      .find((n) => n.dataset.executionId === "e-failed");
    const active = screen
      .getAllByTestId("corridor-node")
      .find((n) => n.dataset.executionId === "e-active");
    const done = screen
      .getAllByTestId("corridor-node")
      .find((n) => n.dataset.executionId === "e-done");

    expect(failed?.dataset.status).toBe("failed");
    expect(active?.dataset.status).toBe("active");
    expect(done?.dataset.status).toBe("done");

    const failedCircle = failed?.querySelector("circle");
    const activeCircle = active?.querySelector("circle");

    // Failed nodes carry the error stroke class and a thicker border.
    expect(failedCircle?.getAttribute("class")).toContain("stroke-error");
    expect(failedCircle?.getAttribute("stroke-width")).toBe("2.5");

    // Active nodes have the active fill (white-on-secondary) class.
    expect(activeCircle?.getAttribute("class")).toContain("fill-bg-primary");
  });

  it("clicking a node calls onPinExecution AND scrolls THREAD to that row", () => {
    const tasks = [makeTask({ id: "root" })];
    const executions = [
      makeExec({ id: "e1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
      makeExec({ id: "e2", task_id: "root", started_at: "2024-01-01T00:00:30Z" }),
    ];

    const onPin = vi.fn();
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    render(
      <Harness
        rootTaskId="root"
        executions={executions}
        tasks={tasks}
        onPinExecution={onPin}
      />
    );

    const node = screen
      .getAllByTestId("corridor-node")
      .find((n) => n.dataset.executionId === "e2");
    expect(node).toBeTruthy();
    fireEvent.click(node!);

    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith("e2");
    // scrollIntoView should be invoked on the matching THREAD row.
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("pan-on-drag updates the SVG transform offset", () => {
    const tasks = [makeTask({ id: "root" })];
    const executions = [
      makeExec({ id: "e1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
    ];

    const { container } = render(
      <Harness rootTaskId="root" executions={executions} tasks={tasks} />
    );

    const view = screen.getByTestId("corridor-view");
    const transformG = container.querySelector(
      '[data-testid="corridor-transform"]'
    );
    expect(transformG?.getAttribute("transform")).toContain("translate(0 0)");

    fireEvent.pointerDown(view, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(view, { pointerId: 1, clientX: 150, clientY: 130 });
    fireEvent.pointerUp(view, { pointerId: 1, clientX: 150, clientY: 130 });

    // After panning by (+50, +30) the transform should reflect that.
    expect(view.dataset.panX).toBe("50.00");
    expect(view.dataset.panY).toBe("30.00");
    const transformAfter = container
      .querySelector('[data-testid="corridor-transform"]')
      ?.getAttribute("transform");
    expect(transformAfter).toContain("translate(50 30)");
  });

  it("Ctrl+wheel zoom scales the canvas, clamped to allowed range", () => {
    const tasks = [makeTask({ id: "root" })];
    const executions = [
      makeExec({ id: "e1", task_id: "root", started_at: "2024-01-01T00:00:00Z" }),
    ];

    render(<Harness rootTaskId="root" executions={executions} tasks={tasks} />);
    const view = screen.getByTestId("corridor-view");

    expect(view.dataset.scale).toBe("1.000");

    // Negative deltaY = zoom in.
    fireEvent.wheel(view, { deltaY: -200, ctrlKey: true });
    expect(parseFloat(view.dataset.scale ?? "1")).toBeGreaterThan(1);

    // Heavy zoom out should clamp at MIN_SCALE = 0.25.
    for (let i = 0; i < 50; i += 1) {
      fireEvent.wheel(view, { deltaY: 1000, ctrlKey: true });
    }
    expect(parseFloat(view.dataset.scale ?? "1")).toBeCloseTo(0.25, 5);
  });

  it("renders an empty state when there are no executions", () => {
    render(
      <Harness rootTaskId="root" executions={[]} tasks={[makeTask({ id: "root" })]} />
    );
    expect(screen.getByTestId("corridor-empty")).toBeInTheDocument();
  });
});
