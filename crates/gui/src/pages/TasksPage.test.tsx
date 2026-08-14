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
import { queryClient, queryKeys } from "../query";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { useEntityPanelStore } from "../stores/entityPanelStore";

function seedTaskRuns(tasks: Task[]) {
  for (const task of tasks) {
    const activeRun = task.run_controls?.active_run;
    if (activeRun) {
      queryClient.setQueryData(
        queryKeys.taskRuns.byTask(getProjectScopeGeneration(), task.id),
        [activeRun]
      );
    }
  }
}

/**
 * The visible page title and activity readouts (the "N running" pulse and the
 * "N tasks · M roots" count) live in the shell header now, surfaced via
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

describe("TasksPage", () => {
  beforeEach(() => {
    mockTasks = [];
    lastFilters = undefined;
    useEntityPanelStore.getState().reset();
    window.history.pushState({}, "", "/tasks");
  });

  it("opens a task linked through the URL fallback", async () => {
    const taskId = "03111754-4769-47c1-a64c-078d73554af8";
    window.history.pushState({}, "", `/tasks?taskId=${taskId}`);

    render(<TasksPageWithHeader />);

    await waitFor(() =>
      expect(useEntityPanelStore.getState().selection).toEqual({
        type: "task",
        taskId,
      })
    );
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
    seedTaskRuns(mockTasks);

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
    seedTaskRuns(mockTasks);
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

    const rows = screen.getAllByRole("treeitem");
    expect(rows[0]).not.toHaveAttribute("aria-selected", "true");
    expect(rows[1]).toHaveAttribute("aria-selected", "true");
  });

  it("does not auto-select a task on load; the detail panel opens only on click", async () => {
    mockTasks = [
      createMockTask({
        id: "11111111-0000-0000-0000-000000000000",
        title: "First visible task",
      }),
    ];
    seedTaskRuns(mockTasks);

    render(<TasksPageWithHeader />);

    // The side panel starts closed — no task is selected by default.
    expect(screen.queryByTestId("task-detail-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem")).not.toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Picking a row opens the detail panel for that task.
    fireEvent.click(screen.getByText("First visible task"));

    expect(await screen.findByTestId("task-detail-panel")).toBeInTheDocument();
    expect(screen.getByRole("treeitem")).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("does not render a 'Selected <id>' chip in the header activity slot", () => {
    mockTasks = [
      createMockTask({
        id: "860cde1b-9093-42ff-a19d-7453f3b7891b",
        title: "Standardize GUI entity ID primitives",
      }),
    ];
    seedTaskRuns(mockTasks);

    render(<TasksPageWithHeader />);
    fireEvent.click(screen.getAllByRole("treeitem")[0]);

    expect(
      screen.queryByTestId("tasks-page-selected-task-id")
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Selected/)).not.toBeInTheDocument();
  });

  it("renders the 'N tasks · M roots' count readout (bold number, no parentheses)", () => {
    const parent = createMockTask({
      id: "10000000-0000-0000-0000-000000000000",
      title: "Root epic",
      level: "epic",
    });
    const child = createMockTask({
      id: "20000000-0000-0000-0000-000000000000",
      title: "Child task",
      parent_id: parent.id,
    });
    const otherRoot = createMockTask({
      id: "30000000-0000-0000-0000-000000000000",
      title: "Second root",
    });
    mockTasks = [parent, child, otherRoot];

    render(<TasksPageWithHeader />);

    const headerActions = screen.getByTestId("shell-header-actions");
    expect(headerActions).toHaveTextContent("3 tasks · 2 roots");
    expect(headerActions.textContent).not.toMatch(/\(2 roots\)/);
  });

  it("renders the accent 'N running' pulse readout when runs are active", () => {
    mockTasks = [
      createMockTask({
        id: "40000000-0000-0000-0000-000000000000",
        title: "Executing task",
        run_controls: createMockTaskRunControls(
          createMockTaskRun({ status: "executing" })
        ),
      }),
    ];
    seedTaskRuns(mockTasks);

    render(<TasksPageWithHeader />);

    const liveCount = screen.getByTestId("topbar-live-count");
    expect(liveCount).toHaveTextContent("1 running");
    expect(screen.queryByText(/\bactive\b/)).not.toBeInTheDocument();
  });

  it("omits the running readout entirely when nothing is active", () => {
    mockTasks = [
      createMockTask({
        id: "50000000-0000-0000-0000-000000000000",
        title: "Idle task",
      }),
    ];

    render(<TasksPageWithHeader />);

    expect(screen.queryByTestId("topbar-live-count")).not.toBeInTheDocument();
  });

  it("renders a hide-done toggle that flips its label and .on class", async () => {
    const user = userEvent.setup();
    mockTasks = [
      createMockTask({
        id: "60000000-0000-0000-0000-000000000000",
        title: "A task",
      }),
    ];

    render(<TasksPageWithHeader />);

    const toggle = screen.getByTestId("tasks-hide-done");
    expect(toggle).toHaveTextContent("Hide done");
    expect(toggle).not.toHaveClass("on");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(toggle).toHaveTextContent("Done hidden");
    expect(toggle).toHaveClass("on");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("hides completed leaf children once the toggle is on", async () => {
    const user = userEvent.setup();
    const parent = createMockTask({
      id: "70000000-0000-0000-0000-000000000000",
      title: "Parent epic",
      level: "epic",
    });
    const openChild = createMockTask({
      id: "71000000-0000-0000-0000-000000000000",
      title: "Open child",
      parent_id: parent.id,
    });
    const doneChild = createMockTask({
      id: "72000000-0000-0000-0000-000000000000",
      title: "Done child",
      parent_id: parent.id,
      completed_at: "2025-01-02T00:00:00Z",
    });
    mockTasks = [parent, openChild, doneChild];

    render(<TasksPageWithHeader />);

    // Expand the parent so its children render.
    await user.click(screen.getByRole("button", { name: /^expand$/i }));
    expect(screen.getByText("Done child")).toBeInTheDocument();

    await user.click(screen.getByTestId("tasks-hide-done"));

    expect(screen.getByText("Open child")).toBeInTheDocument();
    expect(screen.queryByText("Done child")).not.toBeInTheDocument();
  });

  it("does not hide done children while a scope filter is active (bypass)", async () => {
    const user = userEvent.setup();
    const parent = createMockTask({
      id: "80000000-0000-0000-0000-000000000000",
      title: "Parent epic",
      level: "epic",
    });
    const doneChild = createMockTask({
      id: "81000000-0000-0000-0000-000000000000",
      title: "Done child",
      parent_id: parent.id,
      completed_at: "2025-01-02T00:00:00Z",
    });
    mockTasks = [parent, doneChild];

    render(<TasksPageWithHeader />);

    // Turn hide-done on, then activate the "done" scope. Scoping force-expands
    // the tree, and filtering must bypass hide-done so the done child shows.
    await user.click(screen.getByTestId("tasks-hide-done"));
    await user.click(screen.getByRole("button", { name: /done1/i }));

    expect(await screen.findByText("Done child")).toBeInTheDocument();
  });

  it("focuses the search box when '/' is pressed outside a text field", async () => {
    mockTasks = [];
    render(<TasksPageWithHeader />);

    const input = screen.getByTestId("task-search-input");
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: "/" });

    expect(document.activeElement).toBe(input);
  });

  it("does not steal focus on '/' while typing in another field", async () => {
    mockTasks = [];
    render(
      <>
        <TasksPageWithHeader />
        <input data-testid="other-field" />
      </>
    );

    const other = screen.getByTestId("other-field") as HTMLInputElement;
    other.focus();
    expect(document.activeElement).toBe(other);

    fireEvent.keyDown(window, { key: "/" });

    // Focus stays in the field the user was already typing in.
    expect(document.activeElement).toBe(other);
  });
});
