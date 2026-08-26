import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  createMockTask,
  createMockWorkflow,
  waitFor,
} from "../test/test-utils";
import { BoardPage, topologicalColumnSort } from "./BoardPage";
import { GlobalEntityPanelHost } from "../components/GlobalEntityPanelHost";
import { useShellStore } from "../stores/shellStore";
import { useEntityPanelStore } from "../stores/entityPanelStore";
import type { Task, Workflow, WorkflowTransition } from "../bindings";

/**
 * The page title ("Board") and the task-count readout live in the shell header
 * now, surfaced via useShellHeader. The shell chrome isn't mounted in this
 * isolated render, so we mount the stored header actions alongside the page to
 * assert on them.
 */
function BoardPageWithHeader() {
  const headerActions = useShellStore((s) => s.headerActions);
  return (
    <>
      <BoardPage />
      <div data-testid="shell-header-actions">{headerActions}</div>
    </>
  );
}

function BoardPageWithEntityHost() {
  return (
    <>
      <BoardPage />
      <GlobalEntityPanelHost />
    </>
  );
}

// Track the mock return values so tests can override them
let mockTasks: Task[] = [];
let mockWorkflows: Workflow[] = [];
let mockTransitions: WorkflowTransition[] = [];
let mockTasksLoading = false;
let mockWorkflowsLoading = false;
let mockTasksError: string | null = null;
let mockWorkflowsError: string | null = null;

vi.mock("../hooks/useTasks", () => ({
  useTasks: () => ({
    tasks: mockTasks,
    isLoading: mockTasksLoading,
    error: mockTasksError,
    refetch: vi.fn(),
  }),
}));

vi.mock("../hooks/useWorkflows", () => ({
  useWorkflows: () => ({
    workflows: mockWorkflows,
    isLoading: mockWorkflowsLoading,
    error: mockWorkflowsError,
    refetch: vi.fn(),
  }),
}));

vi.mock("../hooks/useWorkflowTransitions", () => ({
  useWorkflowTransitions: () => ({
    transitions: mockTransitions,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

// Mock TaskDetailPanel to keep tests focused on the board logic
vi.mock("../components/TaskDetail", () => ({
  TaskDetailPanel: ({
    taskId,
    onClose,
  }: {
    taskId: string | null;
    onClose?: () => void;
  }) =>
    taskId ? (
      <div data-testid="task-detail-panel">
        <span data-testid="detail-task-id">{taskId}</span>
        <button onClick={onClose} data-testid="close-panel">
          Close
        </button>
      </div>
    ) : null,
}));

describe("BoardPage", () => {
  beforeEach(() => {
    mockTasks = [];
    mockWorkflows = [];
    mockTransitions = [];
    mockTasksLoading = false;
    mockWorkflowsLoading = false;
    mockTasksError = null;
    mockWorkflowsError = null;
    useEntityPanelStore.getState().reset();
  });

  describe("loading state", () => {
    it("shows loading spinner when tasks are loading", () => {
      mockTasksLoading = true;
      render(<BoardPage />);

      expect(screen.getByText("Loading board...")).toBeInTheDocument();
    });

    it("shows loading spinner when workflows are loading", () => {
      mockWorkflowsLoading = true;
      render(<BoardPage />);

      expect(screen.getByText("Loading board...")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message from tasks fetch", () => {
      mockTasksError = "Failed to fetch tasks";
      render(<BoardPage />);

      expect(screen.getByText("Failed to fetch tasks")).toBeInTheDocument();
    });

    it("shows error message from workflows fetch", () => {
      mockWorkflowsError = "Failed to load workflows";
      render(<BoardPage />);

      expect(screen.getByText("Failed to load workflows")).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("shows empty state when there are no tasks at all", () => {
      mockTasks = [];
      mockWorkflows = [];
      render(<BoardPage />);

      expect(
        screen.getByText("No tasks with kanban columns assigned")
      ).toBeInTheDocument();
    });
  });

  describe("column rendering from kanban_column values", () => {
    it("creates columns from distinct kanban_column values across workflows", () => {
      mockWorkflows = [
        createMockWorkflow({
          id: "wf-1",
          name: "Backlog WF",
          kanban_column: "Backlog",
        }),
        createMockWorkflow({
          id: "wf-2",
          name: "Active WF",
          kanban_column: "Active",
        }),
        createMockWorkflow({
          id: "wf-3",
          name: "Done WF",
          kanban_column: "Done",
        }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-1",
          title: "Task A",
          workflow_id: "wf-1",
          workflow_name: "Backlog WF",
        }),
        createMockTask({
          id: "t-2",
          title: "Task B",
          workflow_id: "wf-2",
          workflow_name: "Active WF",
        }),
        createMockTask({
          id: "t-3",
          title: "Task C",
          workflow_id: "wf-3",
          workflow_name: "Done WF",
        }),
      ];
      render(<BoardPage />);

      expect(screen.getByText("Backlog")).toBeInTheDocument();
      expect(screen.getByText("Active")).toBeInTheDocument();
      expect(screen.getByText("Done")).toBeInTheDocument();
    });

    it("groups tasks into column matching their workflow's kanban_column", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Todo" }),
        createMockWorkflow({ id: "wf-2", kanban_column: "In Progress" }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-1",
          title: "Todo Task 1",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "t-2",
          title: "Todo Task 2",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "t-3",
          title: "Active Task",
          workflow_id: "wf-2",
        }),
      ];
      render(<BoardPage />);

      // Check that Todo column has 2 tasks and In Progress has 1
      const todoRegion = screen.getByRole("region", {
        name: /Todo column, 2 tasks/i,
      });
      expect(todoRegion).toBeInTheDocument();

      const activeRegion = screen.getByRole("region", {
        name: /In Progress column, 1 tasks/i,
      });
      expect(activeRegion).toBeInTheDocument();
    });

    it("places tasks with no kanban_column workflow in Unassigned column", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Active" }),
        createMockWorkflow({ id: "wf-2", kanban_column: null }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-1",
          title: "Active Task",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "t-2",
          title: "Unassigned Task",
          workflow_id: "wf-2",
        }),
      ];
      render(<BoardPage />);

      expect(
        screen.getByRole("region", { name: /Unassigned column, 1 tasks/i })
      ).toBeInTheDocument();
      expect(screen.getByText("Unassigned Task")).toBeInTheDocument();
    });

    it("places tasks with no workflow in Unassigned column", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Active" }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-1",
          title: "Has Workflow",
          workflow_id: "wf-1",
        }),
        createMockTask({ id: "t-2", title: "No Workflow", workflow_id: null }),
      ];
      render(<BoardPage />);

      expect(
        screen.getByRole("region", { name: /Unassigned column, 1 tasks/i })
      ).toBeInTheDocument();
      expect(screen.getByText("No Workflow")).toBeInTheDocument();
    });

    it("orders columns alphabetically when no transitions exist, with Unassigned at the end", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Zebra" }),
        createMockWorkflow({ id: "wf-2", kanban_column: "Alpha" }),
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "Z Task", workflow_id: "wf-1" }),
        createMockTask({ id: "t-2", title: "A Task", workflow_id: "wf-2" }),
        createMockTask({ id: "t-3", title: "Orphan", workflow_id: null }),
      ];
      render(<BoardPage />);

      const regions = screen.getAllByRole("region");
      const regionNames = regions.map((r) => r.getAttribute("aria-label"));

      expect(regionNames[0]).toContain("Alpha");
      expect(regionNames[1]).toContain("Zebra");
      expect(regionNames[2]).toContain("Unassigned");
    });

    it("orders columns by workflow transitions when available", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-done", kanban_column: "Done" }),
        createMockWorkflow({ id: "wf-active", kanban_column: "Active" }),
        createMockWorkflow({ id: "wf-backlog", kanban_column: "Backlog" }),
      ];
      mockTransitions = [
        {
          id: "t1",
          from_workflow_id: "wf-backlog",
          from_workflow_name: "Backlog WF",
          to_workflow_id: "wf-active",
          to_workflow_name: "Active WF",
          label: "start",
          target_step_id: null,
        },
        {
          id: "t2",
          from_workflow_id: "wf-active",
          from_workflow_name: "Active WF",
          to_workflow_id: "wf-done",
          to_workflow_name: "Done WF",
          label: "finish",
          target_step_id: null,
        },
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "Task A", workflow_id: "wf-done" }),
        createMockTask({
          id: "t-2",
          title: "Task B",
          workflow_id: "wf-active",
        }),
        createMockTask({
          id: "t-3",
          title: "Task C",
          workflow_id: "wf-backlog",
        }),
      ];
      render(<BoardPage />);

      const regions = screen.getAllByRole("region");
      const regionNames = regions.map((r) => r.getAttribute("aria-label"));

      // Transition order: Backlog → Active → Done
      expect(regionNames[0]).toContain("Backlog");
      expect(regionNames[1]).toContain("Active");
      expect(regionNames[2]).toContain("Done");
    });
  });

  describe("filtering by level", () => {
    it("shows only matching tasks when level filter is applied", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Active" }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-1",
          title: "My Epic",
          level: "epic",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "t-2",
          title: "My Ticket",
          level: "ticket",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "t-3",
          title: "My Task",
          level: "task",
          workflow_id: "wf-1",
        }),
      ];
      render(<BoardPage />);

      // All 3 visible initially
      expect(screen.getByText("My Epic")).toBeInTheDocument();
      expect(screen.getByText("My Ticket")).toBeInTheDocument();
      expect(screen.getByText("My Task")).toBeInTheDocument();

      // Filter to epic only
      const levelSelect = screen.getByLabelText("Filter by level");
      fireEvent.change(levelSelect, { target: { value: "epic" } });

      expect(screen.getByText("My Epic")).toBeInTheDocument();
      expect(screen.queryByText("My Ticket")).not.toBeInTheDocument();
      expect(screen.queryByText("My Task")).not.toBeInTheDocument();
    });
  });

  describe("filtering by factory", () => {
    it("shows only tasks and columns belonging to the exact factory", () => {
      mockWorkflows = [
        createMockWorkflow({
          id: "wf-a",
          factory_name: "Factory A",
          kanban_column: "Factory A column",
        }),
        createMockWorkflow({
          id: "wf-b",
          factory_name: "Factory B",
          kanban_column: "Factory B column",
        }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-a",
          title: "Factory A task",
          workflow_id: "wf-a",
        }),
        createMockTask({
          id: "t-b",
          title: "Factory B task",
          workflow_id: "wf-b",
        }),
        createMockTask({
          id: "t-none",
          title: "Unassigned task",
          workflow_id: null,
        }),
      ];
      render(<BoardPage />);

      fireEvent.change(screen.getByLabelText("Filter by factory"), {
        target: { value: "Factory A" },
      });

      expect(screen.getByText("Factory A task")).toBeInTheDocument();
      expect(screen.queryByText("Factory B task")).not.toBeInTheDocument();
      expect(screen.queryByText("Unassigned task")).not.toBeInTheDocument();
      expect(screen.getByText("Factory A column")).toBeInTheDocument();
      expect(screen.queryByText("Factory B column")).not.toBeInTheDocument();
    });

    it("keeps empty columns for the selected factory", () => {
      mockWorkflows = [
        createMockWorkflow({
          id: "wf-a",
          factory_name: "Factory A",
          kanban_column: "Factory A column",
        }),
        createMockWorkflow({
          id: "wf-b",
          factory_name: "Factory B",
          kanban_column: "Factory B column",
        }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-b",
          title: "Factory B task",
          workflow_id: "wf-b",
        }),
      ];
      render(<BoardPage />);

      fireEvent.change(screen.getByLabelText("Filter by factory"), {
        target: { value: "Factory A" },
      });

      expect(
        screen.getByRole("region", {
          name: /Factory A column column, 0 tasks/i,
        })
      ).toBeInTheDocument();
      expect(screen.queryByText("Factory B column")).not.toBeInTheDocument();
      expect(screen.queryByText("Factory B task")).not.toBeInTheDocument();
    });
  });

  describe("search filtering", () => {
    it("filters cards by task title across all columns", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col A" }),
        createMockWorkflow({ id: "wf-2", kanban_column: "Col B" }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-1",
          title: "Login feature",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "t-2",
          title: "Signup feature",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "t-3",
          title: "Dashboard widget",
          workflow_id: "wf-2",
        }),
      ];
      render(<BoardPage />);

      const searchInput = screen.getByLabelText("Search tasks by title or ID");
      fireEvent.change(searchInput, { target: { value: "feature" } });

      expect(screen.getByText("Login feature")).toBeInTheDocument();
      expect(screen.getByText("Signup feature")).toBeInTheDocument();
      expect(screen.queryByText("Dashboard widget")).not.toBeInTheDocument();
    });

    it("search is case insensitive", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col" }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-1",
          title: "Login Feature",
          workflow_id: "wf-1",
        }),
      ];
      render(<BoardPage />);

      const searchInput = screen.getByLabelText("Search tasks by title or ID");
      fireEvent.change(searchInput, { target: { value: "login" } });

      expect(screen.getByText("Login Feature")).toBeInTheDocument();
    });

    it("filters cards by task description", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col" }),
      ];
      mockTasks = [
        createMockTask({
          id: "t-1",
          title: "Description match",
          description: "Contains backend search needle",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "t-2",
          title: "Description miss",
          description: "Unrelated content",
          workflow_id: "wf-1",
        }),
      ];
      render(<BoardPage />);

      const searchInput = screen.getByLabelText("Search tasks by title or ID");
      fireEvent.change(searchInput, { target: { value: "search needle" } });

      expect(screen.getByText("Description match")).toBeInTheDocument();
      expect(screen.queryByText("Description miss")).not.toBeInTheDocument();
    });

    it("filters cards by full task ID", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col" }),
      ];
      mockTasks = [
        createMockTask({
          id: "5d7658d4-1b54-4fc4-b2e6-f3df7894fa0c",
          title: "Matching ID task",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "11111111-2222-4333-8444-555555555555",
          title: "Other task",
          workflow_id: "wf-1",
        }),
      ];
      render(<BoardPage />);

      const searchInput = screen.getByLabelText("Search tasks by title or ID");
      fireEvent.change(searchInput, {
        target: { value: "5d7658d4-1b54-4fc4-b2e6-f3df7894fa0c" },
      });

      expect(screen.getByText("Matching ID task")).toBeInTheDocument();
      expect(screen.queryByText("Other task")).not.toBeInTheDocument();
    });

    it("filters cards by 8-character short task ID", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col" }),
      ];
      mockTasks = [
        createMockTask({
          id: "5d7658d4-1b54-4fc4-b2e6-f3df7894fa0c",
          title: "Matching short ID task",
          workflow_id: "wf-1",
        }),
        createMockTask({
          id: "11111111-2222-4333-8444-555555555555",
          title: "Other task",
          workflow_id: "wf-1",
        }),
      ];
      render(<BoardPage />);

      const searchInput = screen.getByLabelText("Search tasks by title or ID");
      fireEvent.change(searchInput, { target: { value: "5d7658d4" } });

      expect(screen.getByText("Matching short ID task")).toBeInTheDocument();
      expect(screen.queryByText("Other task")).not.toBeInTheDocument();
    });
  });

  describe("clear filters", () => {
    it("shows clear button only when filters are active", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col" }),
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "Task", workflow_id: "wf-1" }),
      ];
      render(<BoardPage />);

      // No clear button initially
      expect(screen.queryByText("Clear")).not.toBeInTheDocument();

      // Apply a search filter
      const searchInput = screen.getByLabelText("Search tasks by title or ID");
      fireEvent.change(searchInput, { target: { value: "something" } });

      // Now clear button appears
      expect(screen.getByText("Clear")).toBeInTheDocument();
    });

    it("clears all filters when clear button is clicked", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col" }),
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "Find Me", workflow_id: "wf-1" }),
        createMockTask({ id: "t-2", title: "Hidden", workflow_id: "wf-1" }),
      ];
      render(<BoardPage />);

      // Apply search
      const searchInput = screen.getByLabelText("Search tasks by title or ID");
      fireEvent.change(searchInput, { target: { value: "Find" } });
      expect(screen.queryByText("Hidden")).not.toBeInTheDocument();

      // Click clear
      fireEvent.click(screen.getByText("Clear"));

      // Both tasks visible again
      expect(screen.getByText("Find Me")).toBeInTheDocument();
      expect(screen.getByText("Hidden")).toBeInTheDocument();
    });
  });

  describe("card click opens TaskDetailPanel", () => {
    it("opens TaskDetailPanel when a card is clicked", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Active" }),
      ];
      mockTasks = [
        createMockTask({
          id: "task-abc123",
          title: "Click Me",
          workflow_id: "wf-1",
        }),
      ];
      render(<BoardPageWithEntityHost />);

      // Panel not visible initially
      expect(screen.queryByTestId("task-detail-panel")).not.toBeInTheDocument();

      // Click the card
      fireEvent.click(screen.getByText("Click Me"));

      // Panel appears with correct task ID
      expect(screen.getByTestId("task-detail-panel")).toBeInTheDocument();
      expect(screen.getByTestId("detail-task-id")).toHaveTextContent(
        "task-abc123"
      );
    });

    it("closes TaskDetailPanel when close is clicked", async () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Active" }),
      ];
      mockTasks = [
        createMockTask({
          id: "task-abc123",
          title: "Open Me",
          workflow_id: "wf-1",
        }),
      ];
      render(<BoardPageWithEntityHost />);

      // Open panel
      fireEvent.click(screen.getByText("Open Me"));
      expect(screen.getByTestId("task-detail-panel")).toBeInTheDocument();

      // Close panel
      fireEvent.click(screen.getByTestId("close-panel"));
      await waitFor(() =>
        expect(
          screen.queryByTestId("task-detail-panel")
        ).not.toBeInTheDocument()
      );
    });

    it("replaces the board detail owner when a chat link opens another task", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Active" }),
      ];
      mockTasks = [
        createMockTask({
          id: "task-abc123",
          title: "Open Me",
          workflow_id: "wf-1",
        }),
      ];
      render(<BoardPageWithEntityHost />);

      fireEvent.click(screen.getByText("Open Me"));
      act(() => useEntityPanelStore.getState().openTask("task-linked"));

      expect(screen.getAllByTestId("task-detail-panel")).toHaveLength(1);
      expect(screen.getByTestId("detail-task-id")).toHaveTextContent(
        "task-linked"
      );
    });
  });

  describe("header", () => {
    it("sets the Board page title in the shell header", () => {
      render(<BoardPageWithHeader />);

      expect(useShellStore.getState().pageTitle).toBe("Board");
    });

    it("shows total task count", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col" }),
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "Task 1", workflow_id: "wf-1" }),
        createMockTask({ id: "t-2", title: "Task 2", workflow_id: "wf-1" }),
      ];
      render(<BoardPageWithHeader />);

      expect(screen.getByTestId("shell-header-actions")).toHaveTextContent(
        "2 tasks"
      );
    });

    it("shows singular 'task' for one task", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Col" }),
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "Only One", workflow_id: "wf-1" }),
      ];
      render(<BoardPageWithHeader />);

      expect(screen.getByTestId("shell-header-actions")).toHaveTextContent(
        "1 task"
      );
    });
  });

  describe("empty columns from workflows", () => {
    it("shows columns for all workflow kanban_column values even when no tasks are in them", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Backlog" }),
        createMockWorkflow({ id: "wf-2", kanban_column: "In Progress" }),
        createMockWorkflow({ id: "wf-3", kanban_column: "Done" }),
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "Only Task", workflow_id: "wf-1" }),
      ];
      render(<BoardPage />);

      // All three columns appear, even though only Backlog has a task
      expect(
        screen.getByRole("region", { name: /Backlog column, 1 tasks/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: /In Progress column, 0 tasks/i })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("region", { name: /Done column, 0 tasks/i })
      ).toBeInTheDocument();
    });

    it("does not show Unassigned column when no tasks lack a kanban_column", () => {
      mockWorkflows = [
        createMockWorkflow({ id: "wf-1", kanban_column: "Active" }),
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "Task", workflow_id: "wf-1" }),
      ];
      render(<BoardPage />);

      const regions = screen.getAllByRole("region");
      const regionNames = regions.map((r) => r.getAttribute("aria-label"));
      expect(regionNames.every((name) => !name?.includes("Unassigned"))).toBe(
        true
      );
    });
  });

  describe("multiple workflows same kanban_column", () => {
    it("groups tasks from different workflows into the same column if they share kanban_column", () => {
      mockWorkflows = [
        createMockWorkflow({
          id: "wf-1",
          name: "WF One",
          kanban_column: "Review",
        }),
        createMockWorkflow({
          id: "wf-2",
          name: "WF Two",
          kanban_column: "Review",
        }),
      ];
      mockTasks = [
        createMockTask({ id: "t-1", title: "From WF1", workflow_id: "wf-1" }),
        createMockTask({ id: "t-2", title: "From WF2", workflow_id: "wf-2" }),
      ];
      render(<BoardPage />);

      // Single Review column with 2 tasks
      const region = screen.getByRole("region", {
        name: /Review column, 2 tasks/i,
      });
      expect(region).toBeInTheDocument();
      expect(screen.getByText("From WF1")).toBeInTheDocument();
      expect(screen.getByText("From WF2")).toBeInTheDocument();
    });
  });
});

function makeTransition(fromId: string, toId: string): WorkflowTransition {
  return {
    id: `${fromId}-${toId}`,
    from_workflow_id: fromId,
    from_workflow_name: fromId,
    to_workflow_id: toId,
    to_workflow_name: toId,
    label: "next",
    target_step_id: null,
  };
}

describe("topologicalColumnSort", () => {
  it("returns empty array for empty input", () => {
    expect(topologicalColumnSort(new Set(), [], new Map())).toEqual([]);
  });

  it("sorts alphabetically when no transitions exist", () => {
    const columns = new Set(["Zebra", "Alpha", "Middle"]);
    const result = topologicalColumnSort(columns, [], new Map());
    expect(result).toEqual(["Alpha", "Middle", "Zebra"]);
  });

  it("sorts by transition order: linear chain", () => {
    const columns = new Set(["Done", "Active", "Backlog"]);
    const wfMap = new Map([
      ["wf-b", "Backlog"],
      ["wf-a", "Active"],
      ["wf-d", "Done"],
    ]);
    const transitions = [
      makeTransition("wf-b", "wf-a"),
      makeTransition("wf-a", "wf-d"),
    ];
    const result = topologicalColumnSort(columns, transitions, wfMap);
    expect(result).toEqual(["Backlog", "Active", "Done"]);
  });

  it("breaks ties alphabetically among columns with equal in-degree", () => {
    // Backlog → Active, Backlog → Review (Active and Review are tied)
    const columns = new Set(["Review", "Active", "Backlog"]);
    const wfMap = new Map([
      ["wf-b", "Backlog"],
      ["wf-a", "Active"],
      ["wf-r", "Review"],
    ]);
    const transitions = [
      makeTransition("wf-b", "wf-a"),
      makeTransition("wf-b", "wf-r"),
    ];
    const result = topologicalColumnSort(columns, transitions, wfMap);
    expect(result).toEqual(["Backlog", "Active", "Review"]);
  });

  it("ignores self-transitions (same column)", () => {
    const columns = new Set(["Alpha", "Beta"]);
    const wfMap = new Map([
      ["wf-a1", "Alpha"],
      ["wf-a2", "Alpha"],
      ["wf-b", "Beta"],
    ]);
    const transitions = [
      makeTransition("wf-a1", "wf-a2"), // same column, should be ignored
      makeTransition("wf-a1", "wf-b"),
    ];
    const result = topologicalColumnSort(columns, transitions, wfMap);
    expect(result).toEqual(["Alpha", "Beta"]);
  });

  it("drops backward edges that would create cycles", () => {
    const columns = new Set(["A", "B", "C"]);
    const wfMap = new Map([
      ["wf-a", "A"],
      ["wf-b", "B"],
      ["wf-c", "C"],
    ]);
    const transitions = [
      makeTransition("wf-a", "wf-b"),
      makeTransition("wf-b", "wf-c"),
      makeTransition("wf-c", "wf-a"), // backward — would create cycle, dropped
    ];
    const result = topologicalColumnSort(columns, transitions, wfMap);
    // C→A is dropped, so we get the forward chain A→B→C
    // C is terminal (no outgoing edges after dropping), placed last
    expect(result).toEqual(["A", "B", "C"]);
  });

  it("handles diamond DAG with terminal column last", () => {
    // Backlog → Active, Backlog → Review, Active → Done, Review → Done
    const columns = new Set(["Done", "Review", "Active", "Backlog"]);
    const wfMap = new Map([
      ["wf-b", "Backlog"],
      ["wf-a", "Active"],
      ["wf-r", "Review"],
      ["wf-d", "Done"],
    ]);
    const transitions = [
      makeTransition("wf-b", "wf-a"),
      makeTransition("wf-b", "wf-r"),
      makeTransition("wf-a", "wf-d"),
      makeTransition("wf-r", "wf-d"),
    ];
    const result = topologicalColumnSort(columns, transitions, wfMap);
    // Done is terminal — placed after Active and Review
    expect(result).toEqual(["Backlog", "Active", "Review", "Done"]);
  });

  it("places terminal columns after non-terminal even with alphabetical tiebreaking", () => {
    // A → C, B → C. A and B are roots, C is terminal.
    // Without terminal-last, alphabetical would interleave.
    const columns = new Set(["C", "B", "A"]);
    const wfMap = new Map([
      ["wf-a", "A"],
      ["wf-b", "B"],
      ["wf-c", "C"],
    ]);
    const transitions = [
      makeTransition("wf-a", "wf-c"),
      makeTransition("wf-b", "wf-c"),
    ];
    const result = topologicalColumnSort(columns, transitions, wfMap);
    expect(result).toEqual(["A", "B", "C"]);
  });

  it("handles rework transitions (real-world: Review → In Progress)", () => {
    // Backlog → Research → In Progress → Review → Done
    // Backlog → In Progress (skip research)
    // Review → In Progress (rework — backward edge)
    const columns = new Set([
      "Backlog",
      "Research",
      "In Progress",
      "Review",
      "Done",
    ]);
    const wfMap = new Map([
      ["wf-backlog", "Backlog"],
      ["wf-research", "Research"],
      ["wf-impl", "In Progress"],
      ["wf-review", "Review"],
      ["wf-pr", "Review"], // PR_creation shares Review column
      ["wf-done", "Done"],
    ]);
    const transitions = [
      makeTransition("wf-backlog", "wf-research"), // Backlog → Research
      makeTransition("wf-backlog", "wf-impl"), // Backlog → In Progress
      makeTransition("wf-research", "wf-impl"), // Research → In Progress
      makeTransition("wf-impl", "wf-review"), // In Progress → Review
      makeTransition("wf-review", "wf-pr"), // Review → Review (same col, ignored)
      makeTransition("wf-review", "wf-impl"), // Review → In Progress (rework, dropped)
      makeTransition("wf-pr", "wf-done"), // Review → Done
    ];
    const result = topologicalColumnSort(columns, transitions, wfMap);
    expect(result).toEqual([
      "Backlog",
      "Research",
      "In Progress",
      "Review",
      "Done",
    ]);
  });

  it("terminal columns without transitions sort alphabetically among themselves at the end", () => {
    const columns = new Set(["Active", "Done", "Archived"]);
    const wfMap = new Map([
      ["wf-a", "Active"],
      ["wf-d", "Done"],
      ["wf-ar", "Archived"],
    ]);
    const transitions = [
      makeTransition("wf-a", "wf-d"),
      makeTransition("wf-a", "wf-ar"),
    ];
    const result = topologicalColumnSort(columns, transitions, wfMap);
    // Both Done and Archived are terminal, alphabetical among them
    expect(result).toEqual(["Active", "Archived", "Done"]);
  });
});
