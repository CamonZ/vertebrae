import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { AppShell } from "./components";
import { TasksPage, WorkflowsPage, WorkflowDetailPage } from "./pages";

function RootLayout() {
  return (
    <AppShell title="Vertebrae" subtitle="Task Management">
      <Outlet />
    </AppShell>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <Navigate to="/tasks" replace />,
      },
      {
        path: "tasks",
        element: <TasksPage />,
      },
      {
        path: "workflows",
        element: <WorkflowsPage />,
      },
      {
        path: "workflow/:id",
        element: <WorkflowDetailPage />,
      },
    ],
  },
]);
