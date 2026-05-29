import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fireEvent,
  render,
  screen,
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
  userEvent,
  waitFor,
} from "../test/test-utils";
import { TasksPage } from "./TasksPage";
import { useShellStore } from "../stores/shellStore";
import type { Task, TaskFilterOptions } from "../bindings";

/**
 * The visible page title and status pills (active count, task counts, and the
 * selected-task short ID) live in the shell header now, surfaced via
 * useShellHeader. The shell chrome isn't mounted in this isolated render, so we
 * mount the stored header actions alongside the page to assert on them.
 */
function TasksPageWithHeader() {
  const headerActions = useShellStore((s) => s.headerActions);
  return (
    <>
      <TasksPage />
      <div data-testid="shell-header-actions">{headerActions}</div>
    </>
  );
}

let mockTasks: Task[] = [];
let lastFilters: TaskFilterOptions | undefined;

vi.mock("../hooks/useTasks", () => ({
  useTasks: (filters?: TaskFilterOptions) => {
    lastFilters = filters;
    return {
      tasks: mockTasks,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
  },
}));

vi.mock("../components/TaskDetail", () => ({
  TaskDetailPanel: ({ taskId }: { taskId: string | null }) =>
    taskId ? <div data-testid="task-detail-panel" /> : null,
}));

vi.mock("../utils", async () => {
  const actual = await vi.importActual<typeof import("../utils")>("../utils");
  return {
    ...actual,
    popOut: vi.fn(),
    stashTask: vi.fn(),
  };
});

describe("TasksPage", () => {
  beforeEach(() => {
    mockTasks = [];
    lastFilters = undefined;
    window.history.pushState({}, "", "/tasks");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("filters the live list by active scope while retaining ancestors", async () => {
    const user = userEvent.setup();
    const parent = createMockTask({
      id: "10000000-0000-0000-0000-000000000000",
      title: "Parent Epic",
      level: "epic",
    });
    const activeChild = createMockTask({
      id: "20000000-0000-0000-0000-000000000000",
      title: "Active Child",
      parent_id: parent.id,
      run_controls: createMockTaskRunControls(
        createMockTaskRun({ status: "executing" })
      ),
    });
    const idleTask = createMockTask({
      id: "30000000-0000-0000-0000-000000000000",
      title: "Idle Task",
    });
    mockTasks = [parent, activeChild, idleTask];

    render(<TasksPageWithHeader />);
    await user.click(screen.getByRole("button", { name: /active1/i }));

    expect(screen.getByText("Parent Epic")).toBeInTheDocument();
    expect(await screen.findByText("Active Child")).toBeInTheDocument();
    expect(screen.queryByText("Idle Task")).not.toBeInTheDocument();
  });

  it("keeps URL workflow filtering in the backend filter while using local scopes", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/tasks?workflowId=workflow-123");
    mockTasks = [
      createMockTask({
        title: "Queued Task",
        run_controls: createMockTaskRunControls(
          createMockTaskRun({ status: "queued" })
        ),
      }),
    ];

    render(<TasksPageWithHeader />);
    await waitFor(() => expect(lastFilters?.workflow_id).toBe("workflow-123"));
    await user.click(screen.getByRole("button", { name: /queued1/i }));

    expect(lastFilters?.workflow_id).toBe("workflow-123");
    expect(screen.getByText("Queued Task")).toBeInTheDocument();
  });

  it("moves selected row state with ArrowDown navigation", () => {
    const first = createMockTask({
      id: "11111111-0000-0000-0000-000000000000",
      title: "First task",
    });
    const second = createMockTask({
      id: "22222222-0000-0000-0000-000000000000",
      title: "Second task",
    });
    mockTasks = [first, second];

    render(<TasksPageWithHeader />);
    fireEvent.click(screen.getByText("First task"));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "ArrowDown" });

    expect(screen.getByTestId("tasks-page-selected-task-id")).toHaveTextContent(
      "22222222"
    );
  });

  it("keeps the detail rail populated with the first visible task", async () => {
    mockTasks = [
      createMockTask({
        id: "11111111-0000-0000-0000-000000000000",
        title: "First visible task",
      }),
    ];

    render(<TasksPageWithHeader />);

    expect(await screen.findByTestId("task-detail-panel")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-page-selected-task-id")).toHaveTextContent(
      "11111111"
    );
  });

  it("renders the selected task as an 8-digit short ID", () => {
    const taskId = "860cde1b-9093-42ff-a19d-7453f3b7891b";
    mockTasks = [
      createMockTask({
        id: taskId,
        title: "Standardize GUI entity ID primitives",
      }),
    ];

    render(<TasksPageWithHeader />);
    fireEvent.click(screen.getAllByRole("treeitem")[0]);

    expect(screen.getByTestId("tasks-page-selected-task-id")).toHaveTextContent(
      "860cde1b"
    );
    expect(screen.queryByText(taskId)).not.toBeInTheDocument();
  });

  it("copies the full selected task ID from the acceptance surface", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const taskId = "860cde1b-9093-42ff-a19d-7453f3b7891b";
    mockTasks = [
      createMockTask({
        id: taskId,
        title: "Standardize GUI entity ID primitives",
      }),
    ];

    render(<TasksPageWithHeader />);
    fireEvent.click(screen.getAllByRole("treeitem")[0]);

    const selectedTaskId = screen.getByTestId("tasks-page-selected-task-id");
    const copyButton = selectedTaskId.querySelector('[role="button"]');
    expect(copyButton).not.toBeNull();

    await user.click(copyButton!);

    expect(writeText).toHaveBeenCalledWith(taskId);
  });
});
