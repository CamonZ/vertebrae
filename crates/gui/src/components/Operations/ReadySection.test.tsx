import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  createMockTask,
} from "../../test/test-utils";
import { ReadySection } from "./ReadySection";

vi.mock("../../bindings", () => ({
  commands: {
    orchestrateTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

import { commands } from "../../bindings";

describe("ReadySection", () => {
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
    expect(screen.getByText("Development")).toBeInTheDocument();
    expect(screen.getByText("todo")).toBeInTheDocument();
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

  it("calls orchestrateTask when Start is clicked", () => {
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
    expect(commands.orchestrateTask).toHaveBeenCalledWith("t-1");
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
