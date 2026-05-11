import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  createMockTask,
  createMockWorkflow,
} from "../test/test-utils";
import { useTaskStore } from "../stores";
import { resetProjectScopedStores } from "../stores/projectScopedStores";

const mockListTasks = vi.fn();
const mockListWorkflows = vi.fn();
const mockListWorkflowTransitions = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    listTasks: (...args: unknown[]) => mockListTasks(...args),
    listWorkflows: (...args: unknown[]) => mockListWorkflows(...args),
    listWorkflowTransitions: (...args: unknown[]) =>
      mockListWorkflowTransitions(...args),
  },
}));

import { BoardPage } from "./BoardPage";

describe("BoardPage project switch state hygiene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
  });

  it("does not render stale pre-existing task store entries after the new project fetch completes", async () => {
    const oldProjectTask = createMockTask({
      id: "old-project-task",
      title: "Old Project Task",
      workflow_id: null,
    });
    useTaskStore.setState({ tasks: [oldProjectTask] });

    const newWorkflow = createMockWorkflow({
      id: "new-project-workflow",
      name: "New Project Workflow",
      kanban_column: "Todo",
    });
    const newProjectTask = createMockTask({
      id: "new-project-task",
      title: "New Project Task",
      workflow_id: newWorkflow.id,
    });

    mockListTasks.mockResolvedValue({ status: "ok", data: [newProjectTask] });
    mockListWorkflows.mockResolvedValue({ status: "ok", data: [newWorkflow] });
    mockListWorkflowTransitions.mockResolvedValue({ status: "ok", data: [] });

    render(<BoardPage />);

    await screen.findByText("New Project Task");
    await waitFor(() => {
      expect(screen.queryByText("Old Project Task")).not.toBeInTheDocument();
    });

    expect(
      screen.getByRole("region", { name: /Todo column, 1 tasks/i })
    ).toBeInTheDocument();
    expect(useTaskStore.getState().tasks.map((task) => task.id)).toEqual([
      "new-project-task",
    ]);
  });
});
