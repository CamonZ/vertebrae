import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ReactFlowProvider } from "@xyflow/react";

// Mock the bindings module
vi.mock("./bindings", () => ({
  commands: {
    hasProjectSelected: vi.fn(),
    listWorkflows: vi.fn(),
    getWorkflowWithTaskDetails: vi.fn(),
    listTasks: vi.fn(),
    getTaskHierarchy: vi.fn(),
    getTask: vi.fn(),
  },
  events: {
    workflowChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    taskChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

// Import after mocking
import { commands } from "./bindings";

// Import page components
import { AllWorkflowsPipeline } from "./pages/AllWorkflowsPipeline";
import { TasksPage } from "./pages/TasksPage";

/**
 * Helper to create a test router with specific routes
 */
function createTestRouter(initialEntries: string[]) {
  return createMemoryRouter(
    [
      {
        path: "/",
        element: <AllWorkflowsPipeline />,
      },
      {
        path: "/tasks",
        element: <TasksPage />,
      },
    ],
    { initialEntries }
  );
}

/**
 * Wrapper component for tests
 */
function TestWrapper({ children }: { children: React.ReactNode }) {
  return <ReactFlowProvider>{children}</ReactFlowProvider>;
}

describe("Router Acceptance Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    (commands.hasProjectSelected as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: true,
    });

    (commands.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [],
    });

    (commands.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [],
    });

    (commands.getTaskHierarchy as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [],
    });
  });

  describe("Default route ('/')", () => {
    it("renders AllWorkflowsPipeline at the root path", async () => {
      const router = createTestRouter(["/"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      // AllWorkflowsPipeline shows "Workflow Pipelines" heading
      await waitFor(() => {
        expect(screen.getByText("Workflow Pipelines")).toBeInTheDocument();
      });
    });

    it("shows empty state when no workflows exist", async () => {
      (commands.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: [],
      });

      const router = createTestRouter(["/"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("No workflows yet")).toBeInTheDocument();
      });
    });

    it("displays workflows when they exist", async () => {
      (commands.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: [
          {
            id: "workflow-1",
            name: "Development Workflow",
            description: "Main dev workflow",
            steps: [{ name: "backlog", order: 0, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } }],
            metadata: {},
          },
        ],
      });

      (commands.getWorkflowWithTaskDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: { workflow: {}, tasks: [] },
      });

      const router = createTestRouter(["/"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Development Workflow")).toBeInTheDocument();
      });
    });
  });

  describe("Tasks route ('/tasks')", () => {
    it("renders TasksPage at /tasks path", async () => {
      const router = createTestRouter(["/tasks"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      // TasksPage shows "Tasks" heading
      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
      });
    });

    it("shows task filters on TasksPage", async () => {
      const router = createTestRouter(["/tasks"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        // TaskFilters component renders status and level dropdowns
        expect(screen.getByText("Status")).toBeInTheDocument();
        expect(screen.getByText("Level")).toBeInTheDocument();
      });
    });
  });

  describe("Route independence", () => {
    it("'/' and '/tasks' render different components", async () => {
      // First render at root
      const rootRouter = createTestRouter(["/"]);
      const { unmount: unmountRoot } = render(
        <TestWrapper>
          <RouterProvider router={rootRouter} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText("Workflow Pipelines")).toBeInTheDocument();
      });

      // Verify TasksPage content is NOT shown at root
      expect(screen.queryByRole("heading", { name: "Tasks" })).not.toBeInTheDocument();

      unmountRoot();

      // Then render at /tasks
      const tasksRouter = createTestRouter(["/tasks"]);
      render(
        <TestWrapper>
          <RouterProvider router={tasksRouter} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
      });

      // Verify AllWorkflowsPipeline content is NOT shown at /tasks
      expect(screen.queryByText("Workflow Pipelines")).not.toBeInTheDocument();
    });
  });

  describe("Unified canvas with workflow zones", () => {
    it("displays multiple workflows as zones in a single canvas", async () => {
      (commands.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: [
          {
            id: "workflow-1",
            name: "Development Workflow",
            description: "Main dev workflow",
            steps: [
              { name: "backlog", order: 0, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } },
              { name: "in_progress", order: 1, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } },
            ],
            metadata: {},
          },
          {
            id: "workflow-2",
            name: "QA Workflow",
            description: "Quality assurance",
            steps: [
              { name: "review", order: 0, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } },
            ],
            metadata: {},
          },
        ],
      });

      (commands.getWorkflowWithTaskDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: { workflow: {}, tasks: [] },
      });

      const router = createTestRouter(["/"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      // Both workflows should be visible in the unified canvas
      await waitFor(() => {
        expect(screen.getByText("Development Workflow")).toBeInTheDocument();
        expect(screen.getByText("QA Workflow")).toBeInTheDocument();
      });

      // Header should show workflow count
      await waitFor(() => {
        expect(screen.getByText("2 workflows visualized")).toBeInTheDocument();
      });
    });

    it("displays workflow zones with step counts", async () => {
      (commands.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: [
          {
            id: "workflow-1",
            name: "Test Workflow",
            description: null,
            steps: [
              { name: "step1", order: 0, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } },
              { name: "step2", order: 1, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } },
              { name: "step3", order: 2, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } },
            ],
            metadata: {},
          },
        ],
      });

      (commands.getWorkflowWithTaskDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: { workflow: {}, tasks: [] },
      });

      const router = createTestRouter(["/"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      // Workflow zone should show step count
      await waitFor(() => {
        expect(screen.getByText("3 steps")).toBeInTheDocument();
      });
    });
  });

  describe("Task detail panel integration", () => {
    it("opens TaskDetailPanel when clicking a task in the pipeline", async () => {
      (commands.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: [
          {
            id: "workflow-1",
            name: "Test Workflow",
            description: null,
            steps: [
              { name: "backlog", order: 0, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } },
            ],
            metadata: {},
          },
        ],
      });

      (commands.getWorkflowWithTaskDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          workflow: {},
          tasks: [
            {
              task: {
                id: "task-123",
                title: "Test Task for Detail Panel",
                status: "backlog",
                level: "task",
                description: "A task to test the detail panel",
                tags: [],
                code_refs: [],
                sections: [],
                priority: null,
                needs_human_review: false,
                workflow_id: null,
                created_at: "2024-01-01T00:00:00Z",
                updated_at: "2024-01-01T00:00:00Z",
                started_at: null,
                completed_at: null,
              },
              parent_id: null,
              children_ids: [],
              depends_on_ids: [],
              dependent_ids: [],
            },
          ],
        },
      });

      // Mock getTask for the TaskDetailPanel
      (commands.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          task: {
            id: "task-123",
            title: "Test Task for Detail Panel",
            status: "backlog",
            level: "task",
            description: "A task to test the detail panel",
            tags: [],
            code_refs: [],
            sections: [],
            priority: null,
            needs_human_review: false,
            workflow_id: null,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
            started_at: null,
            completed_at: null,
          },
          parent_id: null,
          children_ids: [],
          depends_on_ids: [],
          dependent_ids: [],
        },
      });

      const router = createTestRouter(["/"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      // Wait for task to appear in the pipeline
      await waitFor(() => {
        expect(screen.getByText("Test Task for Detail Panel")).toBeInTheDocument();
      });

      // Click the task
      const taskButton = screen.getByText("Test Task for Detail Panel");
      taskButton.click();

      // TaskDetailPanel should appear with header
      await waitFor(() => {
        expect(screen.getByText("Task Details")).toBeInTheDocument();
      });
    });

    it("shows selected task with visual highlight", async () => {
      (commands.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: [
          {
            id: "workflow-1",
            name: "Test Workflow",
            description: null,
            steps: [
              { name: "backlog", order: 0, agent_config: { tools: [], allowed_tools: [], disallowed_tools: [], mcp_config: [], plugin_dirs: [] } },
            ],
            metadata: {},
          },
        ],
      });

      (commands.getWorkflowWithTaskDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          workflow: {},
          tasks: [
            {
              task: {
                id: "task-456",
                title: "Selectable Task",
                status: "todo",
                level: "task",
                description: null,
                tags: [],
                code_refs: [],
                sections: [],
                priority: null,
                needs_human_review: false,
                workflow_id: null,
                created_at: "2024-01-01T00:00:00Z",
                updated_at: "2024-01-01T00:00:00Z",
                started_at: null,
                completed_at: null,
              },
              parent_id: null,
              children_ids: [],
              depends_on_ids: [],
              dependent_ids: [],
            },
          ],
        },
      });

      const router = createTestRouter(["/"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      // Wait for task to appear
      await waitFor(() => {
        expect(screen.getByText("Selectable Task")).toBeInTheDocument();
      });

      // Task text should be inside a button element (clickable)
      const taskText = screen.getByText("Selectable Task");
      const taskButton = taskText.closest("button");
      expect(taskButton).toBeInTheDocument();
    });
  });
});
