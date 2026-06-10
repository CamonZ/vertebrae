import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  createMockTask,
  createMockWorkflow,
} from "../test/test-utils";
import type { TaskFilterOptions } from "../bindings";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { queryClient, queryKeys } from "../query";

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

const TASK_FILTER: TaskFilterOptions = {
  step_names: null,
  levels: null,
  tags: null,
  root_only: null,
  children_of: null,
  search: null,
  workflow_id: null,
  step_id: null,
};

describe("BoardPage project switch state hygiene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
  });

  it("does not render stale pre-existing task query entries after the new project fetch completes", async () => {
    const oldProjectTask = createMockTask({
      id: "old-project-task",
      title: "Old Project Task",
      workflow_id: null,
    });
    queryClient.setQueryData(
      queryKeys.tasks.list(getProjectScopeGeneration(), TASK_FILTER),
      [oldProjectTask]
    );
    await queryClient.invalidateQueries({
      queryKey: queryKeys.tasks.lists(getProjectScopeGeneration()),
    });

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
  });
});
