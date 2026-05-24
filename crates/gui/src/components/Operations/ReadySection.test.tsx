import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  createMockTask,
  createMockTaskRun,
} from "../../test/test-utils";
import type { Task, TaskRunControls } from "../../bindings";
import { ReadySection } from "./ReadySection";

vi.mock("../../bindings", () => ({
  commands: {
    runWorkflow: vi.fn(),
  },
}));

import { commands } from "../../bindings";

function runnableControls(): TaskRunControls {
  return {
    runnable: true,
    stoppable: false,
    disabled_reason_code: null,
    disabled_reason: null,
    active_run: null,
  };
}

function notRunnableControls(reason: string): TaskRunControls {
  return {
    runnable: false,
    stoppable: false,
    disabled_reason_code: "blocked",
    disabled_reason: reason,
    active_run: null,
  };
}

function activeControls(): TaskRunControls {
  return {
    runnable: false,
    stoppable: true,
    disabled_reason_code: "active_run",
    disabled_reason: "A TaskRun is already active",
    active_run: createMockTaskRun({
      id: "run-active",
      task_id: "t-1",
      status: "executing",
    }),
  };
}

function readyTask(overrides?: Partial<Task>): Task {
  return createMockTask({
    id: "t-1",
    title: "Ready Task",
    workflow_id: "wf-1",
    current_step_id: "step-1",
    workflow_name: "Development",
    step_name: "todo",
    run_controls: runnableControls(),
    ...overrides,
  });
}

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
    render(<ReadySection tasks={[readyTask()]} />);

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("displays task title and workflow info", () => {
    render(
      <ReadySection
        tasks={[
          readyTask({
            title: "Implement Feature",
            workflow_name: "Development",
            step_name: "todo",
          }),
        ]}
      />
    );

    expect(screen.getByText("Implement Feature")).toBeInTheDocument();
    expect(screen.queryByText("No workflow assigned")).not.toBeInTheDocument();
    expect(screen.getByText("Development")).toBeInTheDocument();
    expect(screen.getByText("todo")).toBeInTheDocument();
  });

  it("shows Start button enabled when runControls.runnable is true and current_step_id is set", () => {
    render(<ReadySection tasks={[readyTask()]} />);

    const start = screen.getByTestId("ready-start-button");
    expect(start).toBeInTheDocument();
    expect(start).not.toBeDisabled();
  });

  it("disables Start when runControls.runnable is false", () => {
    render(
      <ReadySection
        tasks={[
          readyTask({
            run_controls: notRunnableControls("Workflow missing"),
          }),
        ]}
      />
    );

    const start = screen.getByTestId("ready-start-button");
    expect(start).toBeDisabled();
  });

  it("disables Start when an active run is already in flight", () => {
    render(<ReadySection tasks={[readyTask({ run_controls: activeControls() })]} />);

    const start = screen.getByTestId("ready-start-button");
    expect(start).toBeDisabled();
  });

  it("does not show Start button when task has no workflow", () => {
    render(
      <ReadySection
        tasks={[
          readyTask({
            workflow_id: null,
            current_step_id: null,
            workflow_name: null,
            step_name: null,
            run_controls: null,
          }),
        ]}
      />
    );

    expect(screen.queryByTestId("ready-start-button")).not.toBeInTheDocument();
  });

  it("calls runWorkflow when Start is clicked", async () => {
    const onTaskStarted = vi.fn();
    render(
      <ReadySection
        tasks={[readyTask({ id: "t-1", title: "Start Me" })]}
        onTaskStarted={onTaskStarted}
      />
    );

    fireEvent.click(screen.getByTestId("ready-start-button"));
    expect(commands.runWorkflow).toHaveBeenCalledWith("t-1");
    await waitFor(() => {
      expect(onTaskStarted).toHaveBeenCalledWith("t-1");
    });
  });

  it("does not invoke runWorkflow when Start is disabled by run_controls", async () => {
    const onTaskStarted = vi.fn();
    render(
      <ReadySection
        tasks={[
          readyTask({
            id: "t-1",
            run_controls: notRunnableControls("Blocked by deps"),
          }),
        ]}
        onTaskStarted={onTaskStarted}
      />
    );

    const start = screen.getByTestId("ready-start-button");
    fireEvent.click(start);

    expect(commands.runWorkflow).not.toHaveBeenCalled();
    expect(onTaskStarted).not.toHaveBeenCalled();
  });

  it("does not notify start when runWorkflow returns an error", async () => {
    vi.mocked(commands.runWorkflow).mockResolvedValue({
      status: "error",
      error: { message: "cannot start" },
    });
    const onTaskStarted = vi.fn();
    render(
      <ReadySection
        tasks={[readyTask({ id: "t-1", title: "Start Me" })]}
        onTaskStarted={onTaskStarted}
      />
    );

    fireEvent.click(screen.getByTestId("ready-start-button"));

    await waitFor(() => {
      expect(commands.runWorkflow).toHaveBeenCalledWith("t-1");
    });
    expect(onTaskStarted).not.toHaveBeenCalled();
  });

  it("disables Start while runWorkflow is in flight", async () => {
    const run = createMockTaskRun({ task_id: "t-1" });
    let resolveRun!: (value: { status: "ok"; data: typeof run }) => void;
    vi.mocked(commands.runWorkflow).mockReturnValue(
      new Promise<{ status: "ok"; data: typeof run }>((resolve) => {
        resolveRun = resolve;
      })
    );
    render(<ReadySection tasks={[readyTask({ id: "t-1" })]} />);

    const start = screen.getByTestId("ready-start-button");
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
    render(
      <ReadySection
        tasks={[
          createMockTask({
            id: "t-1",
            title: "Plain Task",
            workflow_id: null,
            workflow_name: null,
            step_name: null,
            current_step_id: null,
            run_controls: null,
          }),
        ]}
      />
    );

    expect(screen.getByText("No workflow assigned")).toBeInTheDocument();
    expect(screen.getByTestId("ready-item-backlog-chip")).toBeInTheDocument();
  });

  it("renders multiple ready tasks", () => {
    render(
      <ReadySection
        tasks={[
          readyTask({ id: "t-1", title: "Task One" }),
          readyTask({ id: "t-2", title: "Task Two" }),
          createMockTask({
            id: "t-3",
            title: "Task Three",
            workflow_id: null,
            current_step_id: null,
            run_controls: null,
          }),
        ]}
      />
    );

    expect(screen.getByText("3")).toBeInTheDocument();
    const readyItems = screen.getAllByTestId("ready-item");
    expect(readyItems).toHaveLength(3);
    expect(screen.getByText("Task One")).toBeInTheDocument();
    expect(screen.getByText("Task Two")).toBeInTheDocument();
    expect(screen.getByText("Task Three")).toBeInTheDocument();
  });
});
