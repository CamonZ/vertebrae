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
});
