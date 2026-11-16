import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
  userEvent,
  waitFor,
  within,
} from "../test/test-utils";
import { TasksPage } from "./TasksPage";
import { GlobalEntityPanelHost } from "../components/GlobalEntityPanelHost";
import { useShellStore } from "../stores/shellStore";
import type { Task, TaskFilterOptions } from "../bindings";
import { queryClient, queryKeys } from "../query";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import { useEntityPanelStore } from "../stores/entityPanelStore";
import { useCommandPaletteStore } from "../stores/commandPaletteStore";

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
      <GlobalEntityPanelHost />
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
    taskId ? <div data-testid="task-detail-panel">{taskId}</div> : null,
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

  it("uses the server blocked state instead of dependency presence", async () => {
    const user = userEvent.setup();
    const blockedTask = createMockTask({
      title: "Blocked Task",
      dependency_ids: [],
      run_controls: {
        runnable: false,
        stoppable: false,
        disabled_reason_code: "blocked",
        disabled_reason: "Task has incomplete blockers",
        active_run: null,
      },
    });
    const completedDependencyTask = createMockTask({
      title: "Completed Dependency Task",
      dependency_ids: ["completed-blocker"],
      run_controls: {
        runnable: true,
        stoppable: false,
        disabled_reason_code: null,
        disabled_reason: null,
        active_run: null,
      },
    });
    const unblockedTask = createMockTask({ title: "Unblocked Task" });
    mockTasks = [blockedTask, completedDependencyTask, unblockedTask];

    render(<TasksPageWithHeader />);
    await user.click(screen.getByRole("button", { name: /blocked1/i }));

    expect(screen.getByText("Blocked Task")).toBeInTheDocument();
    expect(
      screen.queryByText("Completed Dependency Task")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Unblocked Task")).not.toBeInTheDocument();
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

  it("replaces the page selection in the canonical panel when a chat link opens another task", async () => {
    const first = createMockTask({
      id: "11111111-0000-0000-0000-000000000000",
      title: "First visible task",
    });
    const linked = "22222222-0000-0000-0000-000000000000";
    mockTasks = [first];

    render(<TasksPageWithHeader />);
    fireEvent.click(screen.getByText("First visible task"));
    expect(screen.getByTestId("task-detail-panel")).toHaveTextContent(first.id);

    act(() => useEntityPanelStore.getState().openTask(linked));

    expect(screen.getAllByTestId("task-detail-panel")).toHaveLength(1);
    expect(screen.getByTestId("task-detail-panel")).toHaveTextContent(linked);
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

  it("shows the task total on the All filter instead of a header readout", () => {
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

    const statuses = screen.getByRole("group", {
      name: "Filter tasks by status",
    });
    expect(
      within(statuses).getByRole("button", { name: "All3" })
    ).toBeInTheDocument();
    const headerActions = screen.getByTestId("shell-header-actions");
    expect(headerActions.textContent).not.toMatch(/tasks|roots/);
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

  it("keeps Hide done as a checkbox in the View menu", async () => {
    const user = userEvent.setup();
    mockTasks = [
      createMockTask({
        id: "60000000-0000-0000-0000-000000000000",
        title: "A task",
      }),
    ];

    render(<TasksPageWithHeader />);

    const trigger = screen.getByTestId("tasks-view-menu");
    await user.click(trigger);
    expect(screen.getByTestId("tasks-hide-done")).toHaveAttribute(
      "aria-checked",
      "false"
    );

    await user.click(screen.getByTestId("tasks-hide-done"));
    expect(trigger).toHaveClass("on");

    await user.click(trigger);
    expect(screen.getByTestId("tasks-hide-done")).toHaveAttribute(
      "aria-checked",
      "true"
    );
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

    await user.click(screen.getByTestId("tasks-view-menu"));
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
    await user.click(screen.getByTestId("tasks-view-menu"));
    await user.click(screen.getByTestId("tasks-hide-done"));
    await user.click(screen.getByRole("button", { name: /done1/i }));

    expect(await screen.findByText("Done child")).toBeInTheDocument();
  });

  it("offers All plus statuses, and Updated in last 24h combines with a status", async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();
    mockTasks = [
      createMockTask({
        id: "90000000-0000-0000-0000-000000000000",
        title: "Fresh done",
        completed_at: now,
        updated_at: now,
      }),
      createMockTask({
        id: "91000000-0000-0000-0000-000000000000",
        title: "Old done",
        completed_at: "2024-01-02T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      }),
    ];
    render(<TasksPageWithHeader />);

    const statuses = screen.getByRole("group", {
      name: "Filter tasks by status",
    });
    expect(
      within(statuses).getByRole("button", { name: /^All/ })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(statuses).queryByRole("button", { name: /recent/i })
    ).toBeNull();

    await user.click(within(statuses).getByRole("button", { name: /done/i }));
    await user.click(screen.getByTestId("tasks-view-menu"));
    await user.click(screen.getByTestId("tasks-recent-only"));

    expect(await screen.findByText("Fresh done")).toBeInTheDocument();
    expect(screen.queryByText("Old done")).not.toBeInTheDocument();
  });

  it("opens the command palette scoped to tasks from the search button", () => {
    mockTasks = [];
    useCommandPaletteStore.setState({ open: false, scope: "all" });
    render(<TasksPageWithHeader />);

    fireEvent.click(screen.getByRole("button", { name: "Search tasks" }));

    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: true,
      scope: "tasks",
    });
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
