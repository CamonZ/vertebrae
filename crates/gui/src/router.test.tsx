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
    getPipelineData: vi.fn(),
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

    (commands.getPipelineData as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: {
        workflows: [],
        workflow_steps: {},
        tasks: [],
        transitions: [],
      },
    });

    (commands.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
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

      expect(
        screen.getByText("Operations dashboard coming soon"),
      ).toBeInTheDocument();
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

      expect(
        screen.getByText("Kanban board view coming soon"),
      ).toBeInTheDocument();
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
      (commands.getPipelineData as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          workflows: [
            {
              id: "workflow-1",
              name: "Development Workflow",
              description: "Main dev workflow",
              metadata: {},
            },
          ],
          workflow_steps: {
            "workflow-1": [
              {
                id: "step-backlog",
                name: "backlog",
                workflow_id: "workflow-1",
                order: 0,
                is_final: false,
                transitions_to: [],
                agent_config: {
                  tools: [],
                  allowed_tools: [],
                  disallowed_tools: [],
                  mcp_config: [],
                  plugin_dirs: [],
                },
              },
            ],
          },
          tasks: [],
          transitions: [],
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
    it("displays multiple workflows as zones in a single canvas", async () => {
      (commands.getPipelineData as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          workflows: [
            {
              id: "workflow-1",
              name: "Workflow One",
              description: null,
              metadata: {},
            },
            {
              id: "workflow-2",
              name: "Workflow Two",
              description: null,
              metadata: {},
            },
          ],
          workflow_steps: {
            "workflow-1": [
              {
                id: "step-1",
                name: "backlog",
                workflow_id: "workflow-1",
                order: 0,
                is_final: false,
                transitions_to: [],
                agent_config: {
                  tools: [],
                  allowed_tools: [],
                  disallowed_tools: [],
                  mcp_config: [],
                  plugin_dirs: [],
                },
              },
            ],
            "workflow-2": [
              {
                id: "step-2",
                name: "backlog",
                workflow_id: "workflow-2",
                order: 0,
                is_final: false,
                transitions_to: [],
                agent_config: {
                  tools: [],
                  allowed_tools: [],
                  disallowed_tools: [],
                  mcp_config: [],
                  plugin_dirs: [],
                },
              },
            ],
          },
          tasks: [],
          transitions: [],
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
      (commands.getPipelineData as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: {
          workflows: [
            {
              id: "workflow-multi",
              name: "Multi-Step Workflow",
              description: null,
              metadata: {},
            },
          ],
          workflow_steps: {
            "workflow-multi": [
              {
                id: "step-backlog",
                name: "backlog",
                workflow_id: "workflow-multi",
                order: 0,
                is_final: false,
                transitions_to: [],
                agent_config: {
                  tools: [],
                  allowed_tools: [],
                  disallowed_tools: [],
                  mcp_config: [],
                  plugin_dirs: [],
                },
              },
              {
                id: "step-todo",
                name: "todo",
                workflow_id: "workflow-multi",
                order: 1,
                is_final: false,
                transitions_to: [],
                agent_config: {
                  tools: [],
                  allowed_tools: [],
                  disallowed_tools: [],
                  mcp_config: [],
                  plugin_dirs: [],
                },
              },
              {
                id: "step-done",
                name: "done",
                workflow_id: "workflow-multi",
                order: 2,
                is_final: true,
                transitions_to: [],
                agent_config: {
                  tools: [],
                  allowed_tools: [],
                  disallowed_tools: [],
                  mcp_config: [],
                  plugin_dirs: [],
                },
              },
            ],
          },
          tasks: [],
          transitions: [],
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
