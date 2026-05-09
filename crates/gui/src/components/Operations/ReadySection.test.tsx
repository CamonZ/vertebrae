import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  createMockTask,
  createMockTaskRun,
} from "../../test/test-utils";
import { ReadySection } from "./ReadySection";

vi.mock("../../bindings", () => ({
  commands: {
    runWorkflow: vi.fn(),
  },
}));

import { commands } from "../../bindings";

describe("ReadySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.runWorkflow).mockResolvedValue({
      status: "ok",
      data: createMockTaskRun(),
    });
  });

  it("renders nothing when tasks array is empty", () => {
    const { container } = render(<ReadySection tasks={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders section heading with task count", () => {
    const tasks = [
      createMockTask({ id: "t-1", title: "Ready Task" }),
    ];
    render(<ReadySection tasks={tasks} />);

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("displays task title and workflow info", () => {
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Implement Feature",
        workflow_name: "Development",
        step_name: "todo",
        workflow_id: "wf-1",
        current_step_id: "step-1",
      }),
    ];
    render(<ReadySection tasks={tasks} />);

    expect(screen.getByText("Implement Feature")).toBeInTheDocument();
    expect(screen.getByText("Implement Feature").closest("p")?.textContent).toBe(
      "Implement Feature \u2014 all blockers resolved",
    );
    expect(screen.getByText(/all blockers resolved/)).toBeInTheDocument();
    expect(screen.queryByText("No workflow assigned")).not.toBeInTheDocument();
    expect(screen.getByText("Development")).toBeInTheDocument();
    expect(screen.getByText("todo")).toBeInTheDocument();
    expect(screen.getByText("Development").closest("p")?.textContent).toBe(
      "Development \u00b7 todo",
    );
  });

  it("shows Start button when task has workflow_id and current_step_id", () => {
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Task",
        workflow_id: "wf-1",
        current_step_id: "step-1",
      }),
    ];
    render(<ReadySection tasks={tasks} />);

    expect(screen.getByText("Start")).toBeInTheDocument();
  });

  it("does not show Start button when task has no workflow", () => {
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "No Workflow Task",
        workflow_id: null,
        current_step_id: null,
      }),
    ];
    render(<ReadySection tasks={tasks} />);

    expect(screen.queryByText("Start")).not.toBeInTheDocument();
  });

  it("does not show Start when only part of workflow state is present", () => {
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Workflow only",
        workflow_id: "wf-1",
        current_step_id: null,
      }),
      createMockTask({
        id: "t-2",
        title: "Step only",
        workflow_id: null,
        current_step_id: "step-1",
      }),
    ];
    render(<ReadySection tasks={tasks} />);

    expect(screen.queryByText("Start")).not.toBeInTheDocument();
  });

  it("calls runWorkflow when Start is clicked", async () => {
    const onTaskStarted = vi.fn();
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Start Me",
        workflow_id: "wf-1",
        current_step_id: "step-1",
      }),
    ];
    render(<ReadySection tasks={tasks} onTaskStarted={onTaskStarted} />);

    fireEvent.click(screen.getByText("Start"));
    expect(commands.runWorkflow).toHaveBeenCalledWith("t-1");
    await waitFor(() => {
      expect(onTaskStarted).toHaveBeenCalledWith("t-1");
    });
  });

  it("does not notify start when runWorkflow returns an error", async () => {
    vi.mocked(commands.runWorkflow).mockResolvedValue({
      status: "error",
      error: { message: "cannot start" },
    });
    const onTaskStarted = vi.fn();
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Start Me",
        workflow_id: "wf-1",
        current_step_id: "step-1",
      }),
    ];
    render(<ReadySection tasks={tasks} onTaskStarted={onTaskStarted} />);

    fireEvent.click(screen.getByText("Start"));

    await waitFor(() => {
      expect(commands.runWorkflow).toHaveBeenCalledWith("t-1");
    });
    expect(onTaskStarted).not.toHaveBeenCalled();
  });

  it("uses the latest start callback after rerendering", async () => {
    const initialOnTaskStarted = vi.fn();
    const latestOnTaskStarted = vi.fn();
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Start Me",
        workflow_id: "wf-1",
        current_step_id: "step-1",
      }),
    ];
    const { rerender } = render(
      <ReadySection tasks={tasks} onTaskStarted={initialOnTaskStarted} />,
    );

    rerender(<ReadySection tasks={tasks} onTaskStarted={latestOnTaskStarted} />);
    fireEvent.click(screen.getByText("Start"));

    await waitFor(() => {
      expect(latestOnTaskStarted).toHaveBeenCalledWith("t-1");
    });
    expect(initialOnTaskStarted).not.toHaveBeenCalled();
  });

  it("disables Start while runWorkflow is in flight", async () => {
    const run = createMockTaskRun({ task_id: "t-1" });
    let resolveRun!: (value: { status: "ok"; data: typeof run }) => void;
    vi.mocked(commands.runWorkflow).mockReturnValue(
      new Promise<{ status: "ok"; data: typeof run }>((resolve) => {
        resolveRun = resolve;
      }),
    );
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Start Me",
        workflow_id: "wf-1",
        current_step_id: "step-1",
      }),
    ];
    render(<ReadySection tasks={tasks} />);

    const start = screen.getByText("Start");
    fireEvent.click(start);
    fireEvent.click(start);

    expect(commands.runWorkflow).toHaveBeenCalledTimes(1);
    expect(start).toBeDisabled();

    resolveRun({ status: "ok", data: run });
    await waitFor(() => {
      expect(start).not.toBeDisabled();
    });
  });

  it("shows 'No workflow assigned' when task has no workflow or step", () => {
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Plain Task",
        workflow_id: null,
        workflow_name: null,
        step_name: null,
        current_step_id: null,
      }),
    ];
    render(<ReadySection tasks={tasks} />);

    expect(screen.getByText("No workflow assigned")).toBeInTheDocument();
    expect(screen.getByText(/ready to start/)).toBeInTheDocument();
  });

  it("does not show 'No workflow assigned' when only workflow metadata is partial", () => {
    const tasks = [
      createMockTask({
        id: "t-1",
        title: "Workflow Named Task",
        workflow_id: null,
        workflow_name: "Development",
        step_name: null,
        current_step_id: null,
      }),
    ];
    render(<ReadySection tasks={tasks} />);

    expect(screen.getByText("Development")).toBeInTheDocument();
    expect(screen.queryByText("No workflow assigned")).not.toBeInTheDocument();
  });

  it("renders multiple ready tasks", () => {
    const tasks = [
      createMockTask({ id: "t-1", title: "Task One", workflow_id: "wf-1", current_step_id: "s-1" }),
      createMockTask({ id: "t-2", title: "Task Two", workflow_id: "wf-1", current_step_id: "s-1" }),
      createMockTask({ id: "t-3", title: "Task Three", workflow_id: null, current_step_id: null }),
    ];
    render(<ReadySection tasks={tasks} />);

    expect(screen.getByText("3")).toBeInTheDocument();
    const readyItems = screen.getAllByTestId("ready-item");
    expect(readyItems).toHaveLength(3);
    expect(screen.getByText("Task One")).toBeInTheDocument();
    expect(screen.getByText("Task Two")).toBeInTheDocument();
    expect(screen.getByText("Task Three")).toBeInTheDocument();
  });
});
