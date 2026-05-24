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
  WelcomeInstallPage,
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
import { SplashScreen } from "./components";

function RootLayout() {
  // Initialize theme management at the app root
  useTheme();

  return (
    <AppShell>
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

/**
 * Guard component that decides whether the first-run welcome/consent screen
 * should be shown. On mount it queries `installationStatus()` and redirects
 * to `/welcome` only when ALL of these hold:
 *
 *   - neither component is installed at the symlink path we manage, AND
 *   - neither component is resolvable on `$PATH` (so users who already have
 *     `vtb`/`vtb-daemon` from e.g. `cargo install` are never blocked), AND
 *   - the user has not previously clicked "Skip" (`skipped === false`).
 *
 * Otherwise it renders its children. It sits ABOVE `ProjectGuard` in the tree
 * so the welcome screen comes before `/setup`.
 *
 * While the status query is in flight we render the `SplashScreen` so the
 * first paint on app boot does not flash an empty screen.
 */
function InstallationGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [isChecking, setIsChecking] = useState(true);
  const [needsWelcome, setNeedsWelcome] = useState(false);

  useEffect(() => {
    // Dev-only escape hatch: launch with VITE_FORCE_WELCOME=1 to always see
    // the first-run screen, even when vtb is already installed/on PATH.
    if (import.meta.env.DEV && import.meta.env.VITE_FORCE_WELCOME === "1") {
      setNeedsWelcome(true);
      setIsChecking(false);
      navigate("/welcome", { replace: true });
      return;
    }

    async function checkInstallation() {
      try {
        const result = await commands.installationStatus();
        if (result.status === "ok") {
          const s = result.data;
          const firstRun =
            !s.cli.installed_at_symlink &&
            !s.daemon.installed_at_symlink &&
            !s.cli.on_path &&
            !s.daemon.on_path &&
            !s.skipped;
          if (firstRun) {
            setNeedsWelcome(true);
            navigate("/welcome", { replace: true });
          }
        }
        // On error we intentionally do NOT route to /welcome — a failed
        // status probe should never block an already-working install.
      } catch {
        // Same rationale: fall through to children on failure.
      } finally {
        setIsChecking(false);
      }
    }
    checkInstallation();
  }, [navigate]);

  if (isChecking) {
    return <SplashScreen status="Checking installation..." />;
  }

  if (needsWelcome) {
    return null;
  }

  return <>{children}</>;
}

/**
 * Composes the two guards in the required order: installation check first
 * (may redirect to `/welcome`), then project selection (may redirect to
 * `/setup`).
 */
function GuardedRoute({ children }: { children: React.ReactNode }) {
  return (
    <InstallationGuard>
      <ProjectGuard>{children}</ProjectGuard>
    </InstallationGuard>
  );
}

export const router = createBrowserRouter([
  {
    path: "/welcome",
    element: <WelcomeInstallPage />,
  },
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
          <GuardedRoute>
            <OperationsPage />
          </GuardedRoute>
        ),
      },
      {
        path: "board",
        element: (
          <GuardedRoute>
            <BoardPage />
          </GuardedRoute>
        ),
      },
      {
        path: "design",
        element: (
          <GuardedRoute>
            <AllWorkflowsPipeline />
          </GuardedRoute>
        ),
      },
      {
        path: "tasks",
        element: (
          <GuardedRoute>
            <TasksPage />
          </GuardedRoute>
        ),
      },
      {
        path: "traces/:taskId",
        element: (
          <GuardedRoute>
            <TracesPage />
          </GuardedRoute>
        ),
      },
      {
        path: "traces",
        element: (
          <GuardedRoute>
            <TracesPage />
          </GuardedRoute>
        ),
      },
      {
        path: "styleguide",
        element: (
          <GuardedRoute>
            <StyleguidePage />
          </GuardedRoute>
        ),
      },
    ],
  },
]);
