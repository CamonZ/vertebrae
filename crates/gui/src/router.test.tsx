import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Navigate, RouterProvider } from "react-router-dom";
import * as React from "react";
import { queryClient } from "./query/queryClient";

// The Workflow Atlas (the /design page) lays out via async ELK and is covered
// in depth by its own suite; here we only assert route wiring, so stub it.
vi.mock("./components/WorkflowAtlas", () => ({
  WorkflowAtlas: () => <div data-testid="workflow-atlas">Workflow Atlas</div>,
}));

// Mock the bindings module
vi.mock("./bindings", () => ({
  commands: {
    hasProjectSelected: vi.fn(),
    listWorkflows: vi.fn(),
    getWorkflowWithTaskDetails: vi.fn(),
    getPipelineSummary: vi.fn(),
    getWebsocketStatus: vi.fn(() =>
      Promise.resolve({ status: "ok", data: "connected" })
    ),
    listTasks: vi.fn(),
    getTask: vi.fn(),
    listStepsForWorkflow: vi.fn(),
    listWorkflowTransitions: vi.fn(),
    getTaskExecutions: vi.fn(),
    installationStatus: vi.fn(),
  },
  events: {
    workflowChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    taskChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    taskRunChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    taskStepChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    taskRunStepChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepTransitionChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    stepExecutionChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
    workflowTransitionChangedEvent: {
      listen: vi.fn(() => Promise.resolve(() => {})),
    },
  },
}));

// Import after mocking
import { commands } from "./bindings";

// Import page components
import { WorkflowAtlas } from "./components/WorkflowAtlas";
import { TasksPage } from "./pages/TasksPage";
import { BoardPage } from "./pages/BoardPage";
import { TracesPage } from "./pages/TracesPage";
import { hasAllRequiredBinaries } from "./utils/installation";

/**
 * Helper to create a test router with the new route structure
 */
function createTestRouter(initialEntries: string[]) {
  return createMemoryRouter(
    [
      {
        path: "/",
        element: <Navigate to="/tasks" replace />,
      },
      {
        path: "/board",
        element: <BoardPage />,
      },
      {
        path: "/design",
        element: <WorkflowAtlas />,
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
    { initialEntries }
  );
}

/**
 * Wrapper component for tests
 */
function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("Router Acceptance Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    (commands.hasProjectSelected as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        status: "ok",
        data: true,
      }
    );

    (commands.listWorkflows as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [],
    });

    (commands.getPipelineSummary as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        status: "ok",
        data: { workflows: [] },
      }
    );

    (commands.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [],
    });

    (commands.getTaskExecutions as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      data: [],
    });

    // Default: components already on PATH so the InstallationGuard never
    // redirects to /welcome in the bulk of the routing tests.
    (commands.installationStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        status: "ok",
        data: {
          cli: {
            installed_at_symlink: true,
            symlink_path: "/home/user/.local/bin/vtb",
            on_path: true,
          },
          daemon: {
            installed_at_symlink: true,
            symlink_path: "/home/user/.local/bin/vtb-daemon",
            on_path: true,
          },
          gate: {
            installed_at_symlink: true,
            symlink_path: "/home/user/.local/bin/vtb-gate",
            on_path: true,
          },
          service: { kind: "not_loaded" },
        },
      }
    );

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
        workflow_id: null,
        current_step_id: null,
        workflow_name: null,
        step_name: null,
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

  describe("Board route ('/board')", () => {
    it("renders BoardPage at /board", async () => {
      const router = createTestRouter(["/board"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Board" })
        ).toBeInTheDocument();
      });
    });
  });

  describe("Design route ('/design')", () => {
    it("renders the Workflow Atlas at /design", async () => {
      const router = createTestRouter(["/design"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("workflow-atlas")).toBeInTheDocument();
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

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Tasks" })
        ).toBeInTheDocument();
      });
    });

    it("shows supported task filters and scope chips on TasksPage without status controls", async () => {
      const router = createTestRouter(["/tasks"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByLabelText("Filter by level")).toBeInTheDocument();
      });
      expect(
        screen.getByLabelText("Search tasks by title, id, or tag")
      ).toBeInTheDocument();
      expect(screen.queryByText("Status")).not.toBeInTheDocument();
      // The "Done" scope chip is a pressable button; disambiguate from the
      // "Hide done" list control (which also matches /done/i) via its class.
      const doneChip = screen
        .getAllByRole("button", { name: /done/i })
        .find((el) => el.classList.contains("scope-chip"));
      expect(doneChip).toBeInTheDocument();
    });

    it("updates search and level filters on TasksPage without status or done filter overrides", async () => {
      const router = createTestRouter(["/tasks"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(commands.listTasks).toHaveBeenCalledWith(
          expect.objectContaining({
            step_names: null,
          })
        );
      });
      expect(commands.listTasks).toHaveBeenLastCalledWith(
        expect.not.objectContaining({
          include_done: expect.anything(),
        })
      );

      fireEvent.change(
        screen.getByLabelText("Search tasks by title, id, or tag"),
        {
          target: { value: "release" },
        }
      );

      await waitFor(() => {
        expect(commands.listTasks).toHaveBeenCalledWith(
          expect.objectContaining({
            search: "release",
            step_names: null,
          })
        );
      });
      expect(commands.listTasks).toHaveBeenLastCalledWith(
        expect.not.objectContaining({
          include_done: expect.anything(),
        })
      );

      fireEvent.change(screen.getByLabelText("Filter by level"), {
        target: { value: "ticket" },
      });

      await waitFor(() => {
        expect(commands.listTasks).toHaveBeenCalledWith(
          expect.objectContaining({
            search: "release",
            levels: ["ticket"],
            step_names: null,
          })
        );
      });
      expect(commands.listTasks).toHaveBeenLastCalledWith(
        expect.not.objectContaining({
          include_done: expect.anything(),
        })
      );
    });

    it("renders task IDs as eight-character short IDs in TasksPage", async () => {
      (commands.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: "ok",
        data: [
          {
            id: "feedface-3456-7890-abcd-ef1234567890",
            title: "Short ID task",
            level: "task",
            description: null,
            tags: [],
            code_refs: [],
            sections: [],
            priority: null,
            workflow_id: null,
            current_step_id: null,
            workflow_name: null,
            step_name: null,
            rejection_reason: null,
            parent_id: null,
            dependency_ids: [],
            run_controls: null,
            archived: false,
            worktree: null,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
            started_at: null,
            completed_at: null,
          },
        ],
      });
      const router = createTestRouter(["/tasks"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("task-tree-node-id")).toHaveTextContent(
          "feedface"
        );
      });
      expect(
        screen.queryByText("feedface-3456-7890-abcd-ef1234567890")
      ).not.toBeInTheDocument();
    });
  });

  describe("Route independence", () => {
    it("'/design' and '/tasks' render different components", async () => {
      const designRouter = createTestRouter(["/design"]);
      const { unmount: unmountDesign } = render(
        <TestWrapper>
          <RouterProvider router={designRouter} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("workflow-atlas")).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("heading", { name: "Tasks" })
      ).not.toBeInTheDocument();

      unmountDesign();

      const tasksRouter = createTestRouter(["/tasks"]);
      render(
        <TestWrapper>
          <RouterProvider router={tasksRouter} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Tasks" })
        ).toBeInTheDocument();
      });

      expect(screen.queryByTestId("workflow-atlas")).not.toBeInTheDocument();
    });

    it("primary routes render distinct pages", async () => {
      const routes = [
        { path: "/board", heading: "Board" },
        { path: "/tasks", heading: "Tasks" },
      ];

      for (const route of routes) {
        const router = createTestRouter([route.path]);
        const { unmount } = render(
          <TestWrapper>
            <RouterProvider router={router} />
          </TestWrapper>
        );

        await waitFor(() => {
          expect(
            screen.getByRole("heading", { name: route.heading })
          ).toBeInTheDocument();
        });

        // Verify other pages are not rendered
        const otherRoutes = routes.filter((r) => r.path !== route.path);
        for (const other of otherRoutes) {
          expect(
            screen.queryByRole("heading", { name: other.heading })
          ).not.toBeInTheDocument();
        }

        unmount();
      }

      // Design route renders the Workflow Atlas (no page heading)
      const designRouter = createTestRouter(["/design"]);
      const { unmount: unmountDesign } = render(
        <TestWrapper>
          <RouterProvider router={designRouter} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("workflow-atlas")).toBeInTheDocument();
      });

      unmountDesign();
    });
  });

  describe("Default route redirect", () => {
    it("'/' redirects to '/tasks'", async () => {
      const router = createTestRouter(["/"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Tasks" })
        ).toBeInTheDocument();
      });
    });
  });

  describe("Traces route ('/traces/:taskId')", () => {
    it("renders TracesPage at /traces/:taskId when project is selected", async () => {
      const router = createTestRouter(["/traces/task-123"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("traces-page")).toBeInTheDocument();
      });
      expect(screen.getByTestId("traces-header")).toBeInTheDocument();
    });

    it("renders the picker rail at bare /traces with no taskId", async () => {
      const router = createTestRouter(["/traces"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId("traces-picker-rail")).toBeInTheDocument();
        expect(screen.getByTestId("traces-no-task-hint")).toBeInTheDocument();
      });
    });

    it("ProjectGuard redirects to /setup when no project is selected", async () => {
      // Wrap the route element with a ProjectGuard-like guard to verify the
      // redirect behavior, since the production router applies ProjectGuard.
      (
        commands.hasProjectSelected as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        status: "ok",
        data: false,
      });

      // Build a small router that mirrors the production guard contract.
      function Guard({ children }: { children: React.ReactNode }) {
        const [hasProject, setHasProject] = React.useState<boolean | null>(
          null
        );
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
        { initialEntries: ["/traces/task-123"] }
      );

      render(
        <TestWrapper>
          <RouterProvider router={guardedRouter} />
        </TestWrapper>
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
        </TestWrapper>
      );

      // None of the known pages should render
      expect(
        screen.queryByRole("heading", { name: "Operations" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Board" })
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("workflow-atlas")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Tasks" })
      ).not.toBeInTheDocument();
    });

    it("'/workflow-pipelines' does not match any route", () => {
      const router = createTestRouter(["/workflow-pipelines"]);

      render(
        <TestWrapper>
          <RouterProvider router={router} />
        </TestWrapper>
      );

      expect(
        screen.queryByRole("heading", { name: "Operations" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Board" })
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("workflow-atlas")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "Tasks" })
      ).not.toBeInTheDocument();
    });
  });

  describe("InstallationGuard required binary predicate", () => {
    type Comp = { installed_at_symlink: boolean; on_path: boolean };
    const comp = (installed: boolean, onPath: boolean): Comp => ({
      installed_at_symlink: installed,
      on_path: onPath,
    });

    it("returns false when nothing is installed or on-path", () => {
      expect(
        hasAllRequiredBinaries({
          cli: comp(false, false),
          daemon: comp(false, false),
          gate: comp(false, false),
        })
      ).toBe(false);
    });

    it("returns false when only vtb-gate is missing", () => {
      expect(
        hasAllRequiredBinaries({
          cli: comp(true, true),
          daemon: comp(true, true),
          gate: comp(false, false),
        })
      ).toBe(false);
    });

    it("returns true when each component is installed or on PATH", () => {
      expect(
        hasAllRequiredBinaries({
          cli: comp(false, true),
          daemon: comp(true, false),
          gate: comp(false, true),
        })
      ).toBe(true);
    });

    it("returns true when all components are symlinked", () => {
      expect(
        hasAllRequiredBinaries({
          cli: comp(true, false),
          daemon: comp(true, false),
          gate: comp(true, false),
        })
      ).toBe(true);
    });
  });
});
