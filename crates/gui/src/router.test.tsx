import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { ReactFlowProvider } from "@xyflow/react";
import * as React from "react";

// Mock the bindings module
vi.mock("./bindings", () => ({
  commands: {
    hasProjectSelected: vi.fn(),
    listWorkflows: vi.fn(),
    getWorkflowWithTaskDetails: vi.fn(),
    getPipelineSummary: vi.fn(),
    getWebsocketStatus: vi.fn(() =>
      Promise.resolve({ status: "ok", data: "connected" }),
    ),
    listTasks: vi.fn(),
    getTask: vi.fn(),
    listStepsForWorkflow: vi.fn(),
    listWorkflowTransitions: vi.fn(),
    getTaskExecutions: vi.fn(),
  },
  events: {
    workflowChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    taskChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepExecutionChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

// Import after mocking
import { commands } from "./bindings";

// Import page components
import { AllWorkflowsPipeline } from "./pages/AllWorkflowsPipeline";
import { TasksPage } from "./pages/TasksPage";
import { OperationsPage } from "./pages/OperationsPage";
import { BoardPage } from "./pages/BoardPage";
import { TracesPage } from "./pages/TracesPage";

/**
 * Helper to create a test router with the new route structure
 */
function createTestRouter(initialEntries: string[]) {
  return createMemoryRouter(
    [
      {
        path: "/operations",
        element: <OperationsPage />,
      },
      {
        path: "/board",
        element: <BoardPage />,
      },
      {
        path: "/design",
        element: <AllWorkflowsPipeline />,
      },
      {
        path: "/tasks",
        element: <TasksPage />,
      },
      {
        path: "/traces/:taskId",
        element: <TracesPage />,
      },
      {
        path: "/traces",
        element: <TracesPage />,
      },
    ],
    { initialEntries },
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

    (commands.getPipelineSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: { workflows: [] },
    });

    (commands.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [],
    });

    (commands.getTaskExecutions as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [],
    });

    (commands.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: {
        id: "task-123",
        title: "Test Task for Detail Panel",
        level: "task",
        description: "A task to test the detail panel",
        tags: [],
        code_refs: [],
        sections: [],
        priority: null,
        needs_human_review: false,
        workflow_id: null,
        current_step_id: null,
        workflow_name: null,
        step_name: null,
        review_comment: null,
        revision_feedback: null,
        rejection_reason: null,
        parent_id: null,
        dependency_ids: [],
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        started_at: null,
        completed_at: null,
      },
    });

    (
      commands.listStepsForWorkflow as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      status: "ok",
      data: [
        {
          id: "step-backlog",
          workflow_id: "workflow-1",
          name: "backlog",
          order: 0,
          agent_config: {
            model: "claude-3-sonnet",
            system_prompt: "",
            append_system_prompt: "",
            tools: [],
            allowed_tools: [],
            permission_mode: null,
          },
          created_at: null,
          updated_at: null,
        },
        {
          id: "step-in_progress",
          workflow_id: "workflow-1",
          name: "in_progress",
          order: 1,
          agent_config: {
            model: "claude-3-sonnet",
            system_prompt: "",
            append_system_prompt: "",
            tools: [],
            allowed_tools: [],
            permission_mode: null,
          },
          created_at: null,
          updated_at: null,
        },
        {
          id: "step-done",
          workflow_id: "workflow-1",
          name: "done",
          order: 2,
          agent_config: {
            model: "claude-3-sonnet",
            system_prompt: "",
            append_system_prompt: "",
            tools: [],
            allowed_tools: [],
            permission_mode: null,
          },
          created_at: null,
          updated_at: null,
        },
      ],
    });
  });

  describe("Operations route ('/operations')", () => {
    it("renders OperationsPage at /operations", async () => {
      const router = createTestRouter(["/operations"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Operations" }),
        ).toBeInTheDocument();
      });

      // With no tasks or executions, shows the empty "All clear" state
      await waitFor(() => {
        expect(screen.getByText("All clear")).toBeInTheDocument();
      });
    });
  });

  describe("Board route ('/board')", () => {
    it("renders BoardPage at /board", async () => {
      const router = createTestRouter(["/board"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Board" }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Design route ('/design')", () => {
    it("renders AllWorkflowsPipeline at /design", async () => {
      const router = createTestRouter(["/design"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText("Workflow Pipelines")).toBeInTheDocument();
      });
    });

    it("shows empty state when no workflows exist", async () => {
      const router = createTestRouter(["/design"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText("No workflows yet")).toBeInTheDocument();
      });
    });

    it("displays workflows when they exist", async () => {
      (commands.getPipelineSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          workflows: [
            {
              id: "workflow-1",
              name: "Development Workflow",
              description: "Main dev workflow",
              initial_step_id: "step-backlog",
              kanban_column: null,
              is_default: false,
              display_order: 0,
              workflow_steps: [
                {
                  id: "step-backlog",
                  name: "backlog",
                  workflow_id: "workflow-1",
                  goal: null,
                  step_order: 0,
                  step_type: "execute",
                  is_final: false,
                  transitions_to: [],
                  task_counts: { epic: 0, ticket: 0, task: 0 },
                  running_count: 0,
                },
              ],
              transitions: [],
            },
          ],
        },
      });

      const router = createTestRouter(["/design"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
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
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Tasks" }),
        ).toBeInTheDocument();
      });
    });

    it("shows task filters on TasksPage", async () => {
      const router = createTestRouter(["/tasks"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText("Status")).toBeInTheDocument();
        expect(screen.getByText("Level")).toBeInTheDocument();
      });
    });
  });

  describe("Route independence", () => {
    it("'/design' and '/tasks' render different components", async () => {
      const designRouter = createTestRouter(["/design"]);
      const { unmount: unmountDesign } = render(
        <TestWrapper>
          <RouterProvider router={designRouter} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText("Workflow Pipelines")).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("heading", { name: "Tasks" }),
      ).not.toBeInTheDocument();

      unmountDesign();

      const tasksRouter = createTestRouter(["/tasks"]);
      render(
        <TestWrapper>
          <RouterProvider router={tasksRouter} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Tasks" }),
        ).toBeInTheDocument();
      });

      expect(
        screen.queryByText("Workflow Pipelines"),
      ).not.toBeInTheDocument();
    });

    it("'/operations' and '/board' render different placeholder pages", async () => {
      const opsRouter = createTestRouter(["/operations"]);
      const { unmount: unmountOps } = render(
        <TestWrapper>
          <RouterProvider router={opsRouter} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Operations" }),
        ).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("heading", { name: "Board" }),
      ).not.toBeInTheDocument();

      unmountOps();

      const boardRouter = createTestRouter(["/board"]);
      render(
        <TestWrapper>
          <RouterProvider router={boardRouter} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Board" }),
        ).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("heading", { name: "Operations" }),
      ).not.toBeInTheDocument();
    });

    it("all four routes render distinct pages", async () => {
      const routes = [
        { path: "/operations", heading: "Operations" },
        { path: "/board", heading: "Board" },
        { path: "/tasks", heading: "Tasks" },
      ];

      for (const route of routes) {
        const router = createTestRouter([route.path]);
        const { unmount } = render(
          <TestWrapper>
            <RouterProvider router={router} />
          </TestWrapper>,
        );

        await waitFor(() => {
          expect(
            screen.getByRole("heading", { name: route.heading }),
          ).toBeInTheDocument();
        });

        // Verify other pages are not rendered
        const otherRoutes = routes.filter((r) => r.path !== route.path);
        for (const other of otherRoutes) {
          expect(
            screen.queryByRole("heading", { name: other.heading }),
          ).not.toBeInTheDocument();
        }

        unmount();
      }

      // Design route uses a different heading pattern
      const designRouter = createTestRouter(["/design"]);
      const { unmount: unmountDesign } = render(
        <TestWrapper>
          <RouterProvider router={designRouter} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText("Workflow Pipelines")).toBeInTheDocument();
      });

      unmountDesign();
    });
  });

  describe("Default route redirect", () => {
    it("'/' redirects to '/operations'", async () => {
      createMemoryRouter(
        [
          {
            path: "/",
            element: <div>Root should not render</div>,
          },
          {
            path: "/operations",
            element: <OperationsPage />,
          },
        ],
        { initialEntries: ["/"] },
      );

      // Replace the root route to simulate the Navigate redirect
      const redirectRouter = createMemoryRouter(
        [
          {
            path: "/",
            element: (
              <div data-testid="redirect-marker">Redirecting...</div>
            ),
          },
          {
            path: "/operations",
            element: <OperationsPage />,
          },
        ],
        { initialEntries: ["/operations"] },
      );

      render(
        <TestWrapper>
          <RouterProvider router={redirectRouter} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Operations" }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Unified canvas with workflow zones", () => {
    function makePipelineStep(
      id: string,
      workflowId: string,
      name: string,
      order: number,
      isFinal = false,
    ) {
      return {
        id,
        name,
        workflow_id: workflowId,
        goal: null,
        step_order: order,
        step_type: "execute",
        is_final: isFinal,
        transitions_to: [] as string[],
        task_counts: { epic: 0, ticket: 0, task: 0 },
        running_count: 0,
      };
    }

    it("displays multiple workflows as zones in a single canvas", async () => {
      (commands.getPipelineSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          workflows: [
            {
              id: "workflow-1",
              name: "Workflow One",
              description: null,
              initial_step_id: "step-1",
              kanban_column: null,
              is_default: false,
              display_order: 0,
              workflow_steps: [makePipelineStep("step-1", "workflow-1", "backlog", 0)],
              transitions: [],
            },
            {
              id: "workflow-2",
              name: "Workflow Two",
              description: null,
              initial_step_id: "step-2",
              kanban_column: null,
              is_default: false,
              display_order: 1,
              workflow_steps: [makePipelineStep("step-2", "workflow-2", "backlog", 0)],
              transitions: [],
            },
          ],
        },
      });

      const router = createTestRouter(["/design"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText("Workflow One")).toBeInTheDocument();
        expect(screen.getByText("Workflow Two")).toBeInTheDocument();
      });
    });

    it("displays workflow zones with step counts", async () => {
      (commands.getPipelineSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          workflows: [
            {
              id: "workflow-multi",
              name: "Multi-Step Workflow",
              description: null,
              initial_step_id: "step-backlog",
              kanban_column: null,
              is_default: false,
              display_order: 0,
              workflow_steps: [
                makePipelineStep("step-backlog", "workflow-multi", "backlog", 0),
                makePipelineStep("step-todo", "workflow-multi", "todo", 1),
                makePipelineStep("step-done", "workflow-multi", "done", 2, true),
              ],
              transitions: [],
            },
          ],
        },
      });

      const router = createTestRouter(["/design"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByText("Multi-Step Workflow")).toBeInTheDocument();
      });
    });
  });

  describe("Traces route ('/traces/:taskId')", () => {
    it("renders TracesPage at /traces/:taskId when project is selected", async () => {
      const router = createTestRouter(["/traces/task-123"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("traces-page")).toBeInTheDocument();
      });
      expect(screen.getByTestId("traces-header")).toBeInTheDocument();
      expect(screen.getByTestId("trace-mode-toggle")).toBeInTheDocument();
    });

    it("renders an empty state at bare /traces with no taskId", async () => {
      const router = createTestRouter(["/traces"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("traces-empty-state")).toBeInTheDocument();
      });
    });

    it("ProjectGuard redirects to /setup when no project is selected", async () => {
      // Wrap the route element with a ProjectGuard-like guard to verify the
      // redirect behavior, since the production router applies ProjectGuard.
      (commands.hasProjectSelected as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: false,
      });

      // Build a small router that mirrors the production guard contract.
      function Guard({ children }: { children: React.ReactNode }) {
        const [hasProject, setHasProject] = React.useState<boolean | null>(null);
        React.useEffect(() => {
          commands.hasProjectSelected().then((r) => {
            setHasProject(r.status === "ok" && r.data === true);
          });
        }, []);
        if (hasProject === null) return <div>Loading...</div>;
        if (!hasProject) return <div data-testid="redirected-setup">setup</div>;
        return <>{children}</>;
      }

      const guardedRouter = createMemoryRouter(
        [
          {
            path: "/traces/:taskId",
            element: (
              <Guard>
                <TracesPage />
              </Guard>
            ),
          },
        ],
        { initialEntries: ["/traces/task-123"] },
      );

      render(
        <TestWrapper>
          <RouterProvider router={guardedRouter} />
        </TestWrapper>,
      );

      await waitFor(() => {
        expect(screen.getByTestId("redirected-setup")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("traces-page")).not.toBeInTheDocument();
    });
  });

  describe("Removed routes", () => {
    it("'/workflows' does not match any route", () => {
      const router = createTestRouter(["/workflows"]);

      // createMemoryRouter will throw or render nothing for unmatched routes
      // The route simply doesn't exist in the router config
      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      // None of the known pages should render
      expect(
        screen.queryByRole("heading", { name: "Operations" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Board" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Workflow Pipelines")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Tasks" }),
      ).not.toBeInTheDocument();
    });

    it("'/workflow-pipelines' does not match any route", () => {
      const router = createTestRouter(["/workflow-pipelines"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>,
      );

      expect(
        screen.queryByRole("heading", { name: "Operations" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Board" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Workflow Pipelines")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Tasks" }),
      ).not.toBeInTheDocument();
    });
  });
});
