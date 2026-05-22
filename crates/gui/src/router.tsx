import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useNavigate,
} from "react-router-dom";
import { useState, useEffect } from "react";
import { AppShell } from "./components";
import { StyleguideShortcut } from "./components/StyleguideShortcut";
import { useTheme } from "./hooks";
import {
  ProjectSetupPage,
  TasksPage,
  AllWorkflowsPipeline,
  OperationsPage,
  BoardPage,
  TracesPage,
  StyleguidePage,
  TaskDetailPage,
  StandaloneChatWindow,
  StandaloneLiveChatWindow,
  StandaloneTracesPage,
} from "./pages";
import { commands } from "./bindings";

function RootLayout() {
  // Initialize theme management at the app root
  useTheme();

  return (
    <AppShell title="Vertebrae" subtitle="Agent Orchestrator">
      <StyleguideShortcut />
      <Outlet />
    </AppShell>
  );
}

/**
 * Guard component that checks if a project is selected before rendering children.
 * If no project is selected, redirects to the project setup page.
 */
function ProjectGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [isChecking, setIsChecking] = useState(true);
  const [hasProject, setHasProject] = useState(false);

  useEffect(() => {
    async function checkProject() {
      try {
        const result = await commands.hasProjectSelected();
        if (result.status === "ok") {
          if (result.data) {
            setHasProject(true);
          } else {
            navigate("/setup", { replace: true });
          }
        } else {
          // On error, redirect to setup
          navigate("/setup", { replace: true });
        }
      } catch {
        navigate("/setup", { replace: true });
      } finally {
        setIsChecking(false);
      }
    }
    checkProject();
  }, [navigate]);

  if (isChecking) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">
        Loading...
      </div>
    );
  }

  if (!hasProject) {
    return null;
  }

  return <>{children}</>;
}

export const router = createBrowserRouter([
  {
    path: "/setup",
    element: <ProjectSetupPage />,
  },
  {
    path: "/task/:taskId",
    element: <TaskDetailPage />,
  },
  {
    path: "/chat",
    element: <StandaloneChatWindow />,
  },
  {
    path: "/live-chat",
    element: <StandaloneLiveChatWindow />,
  },
  {
    path: "/traces-window/:taskId",
    element: <StandaloneTracesPage />,
  },
  {
    path: "/",
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <Navigate to="/operations" replace />,
      },
      {
        path: "operations",
        element: (
          <ProjectGuard>
            <OperationsPage />
          </ProjectGuard>
        ),
      },
      {
        path: "board",
        element: (
          <ProjectGuard>
            <BoardPage />
          </ProjectGuard>
        ),
      },
      {
        path: "design",
        element: (
          <ProjectGuard>
            <AllWorkflowsPipeline />
          </ProjectGuard>
        ),
      },
      {
        path: "tasks",
        element: (
          <ProjectGuard>
            <TasksPage />
          </ProjectGuard>
        ),
      },
      {
        path: "traces/:taskId",
        element: (
          <ProjectGuard>
            <TracesPage />
          </ProjectGuard>
        ),
      },
      {
        path: "traces",
        element: (
          <ProjectGuard>
            <TracesPage />
          </ProjectGuard>
        ),
      },
      {
        path: "styleguide",
        element: (
          <ProjectGuard>
            <StyleguidePage />
          </ProjectGuard>
        ),
      },
    ],
  },
]);
