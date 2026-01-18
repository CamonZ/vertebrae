import { createBrowserRouter, Navigate, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { AppShell } from "./components";
import { useTheme } from "./hooks";
import { ProjectSetupPage, TasksPage, WorkflowsPage, WorkflowDetailPage, AllWorkflowsPipeline, ChatPage } from "./pages";
import { commands } from "./bindings";

function RootLayout() {
  // Initialize theme management at the app root
  useTheme();

  return (
    <AppShell title="Vertebrae" subtitle="Task Management">
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
      } catch (e) {
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
    path: "/",
    element: <RootLayout />,
    children: [
      {
        index: true,
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
        path: "workflows",
        element: (
          <ProjectGuard>
            <WorkflowsPage />
          </ProjectGuard>
        ),
      },
      {
        path: "workflow-pipelines",
        element: (
          <ProjectGuard>
            <AllWorkflowsPipeline />
          </ProjectGuard>
        ),
      },
      {
        path: "workflow/:id",
        element: (
          <ProjectGuard>
            <WorkflowDetailPage />
          </ProjectGuard>
        ),
      },
      {
        path: "chat",
        element: (
          <ProjectGuard>
            <ChatPage />
          </ProjectGuard>
        ),
      },
    ],
  },
]);
