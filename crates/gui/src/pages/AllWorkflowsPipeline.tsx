import { useState, useEffect, useMemo } from "react";
import { commands, type TaskWithRelations } from "../bindings";
import { useWorkflows } from "../hooks/useWorkflows";
import { useWorkflowChangeListener } from "../hooks/useWorkflowChangeListener";
import { useTaskChangeListener } from "../hooks/useTaskChangeListener";
import { useToastStore } from "../stores";
import { WorkflowPipeline } from "../components/WorkflowPipeline";

/**
 * AllWorkflowsPipeline displays all workflows as distinct visual zones.
 * Each workflow zone contains its own WorkflowPipeline component.
 * Features neural-pathway-inspired design with real-time updates.
 */
export function AllWorkflowsPipeline() {
  const { workflows, isLoading, error, refetch } = useWorkflows();
  const addToast = useToastStore((state) => state.addToast);

  // State for fetched task relationships per workflow
  const [workflowTasksMap, setWorkflowTasksMap] = useState<
    Map<string, TaskWithRelations[]>
  >(new Map());

  // Fetch task details for all workflows
  useEffect(() => {
    const fetchAllWorkflowTasks = async () => {
      if (workflows.length === 0) {
        setWorkflowTasksMap(new Map());
        return;
      }

      const tasksMap = new Map<string, TaskWithRelations[]>();

      try {
        for (const workflow of workflows) {
          try {
            const result = await commands.getWorkflowWithTaskDetails(
              workflow.id
            );
            if (result.status === "ok") {
              tasksMap.set(workflow.id, result.data.tasks);
            } else {
              console.warn(
                `Failed to load tasks for workflow ${workflow.id}:`,
                result.error.message
              );
              tasksMap.set(workflow.id, []);
            }
          } catch (err) {
            console.warn(
              `Failed to load tasks for workflow ${workflow.id}:`,
              String(err)
            );
            tasksMap.set(workflow.id, []);
          }
        }
      } catch (err) {
        addToast(`Failed to load workflow tasks: ${String(err)}`, "error");
      }

      setWorkflowTasksMap(tasksMap);
    };

    fetchAllWorkflowTasks();
  }, [workflows, addToast]);

  // Subscribe to workflow change events for automatic list refresh
  useWorkflowChangeListener({
    onWorkflowListChange: refetch,
  });

  // Subscribe to task change events - reload all workflow tasks when any task changes
  useTaskChangeListener({
    onTaskListChange: () => {
      // Refetch all workflows to get updated task lists
      refetch();
    },
  });

  // Handle loading state
  if (isLoading && workflows.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
            <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
          </div>
          <p className="text-sm text-text-muted">Loading workflows...</p>
        </div>
      </div>
    );
  }

  // Handle error state
  if (error && workflows.length === 0) {
    return (
      <div className="m-6 rounded-xl border border-error/30 bg-error/5 p-6">
        <h2 className="mb-2 text-lg font-semibold text-text-primary">
          Error Loading Workflows
        </h2>
        <p className="mb-4 font-mono text-sm text-error">{error}</p>
        <button
          onClick={refetch}
          className="rounded-lg bg-error px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-error/90"
        >
          Try Again
        </button>
      </div>
    );
  }

  // Handle empty state
  if (workflows.length === 0) {
    return (
      <div className="relative flex-1 overflow-auto p-6">
        {/* Neural grid background */}
        <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

        <div className="relative">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-text-primary">
              Workflow Pipelines
            </h1>
            <p className="mt-2 text-sm text-text-muted">
              All workflows visualized as connected pipelines
            </p>
          </div>

          <div className="flex h-96 items-center justify-center rounded-xl border border-border bg-bg-secondary">
            {/* Neural grid background */}
            <div className="neural-grid pointer-events-none absolute inset-0 rounded-xl opacity-30" />

            <div className="relative text-center">
              <svg
                className="mx-auto h-12 w-12 text-text-muted"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              <p className="mt-3 text-sm font-medium text-text-primary">
                No workflows yet
              </p>
              <p className="mt-1 text-xs text-text-muted">
                Create a workflow to get started
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex-1 space-y-6 overflow-auto p-6">
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

      <div className="relative">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary">
            Workflow Pipelines
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            All workflows visualized as connected pipelines
          </p>
        </div>

        {/* Grid layout for workflow zones */}
        <div className="grid gap-6 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
          {workflows.map((workflow) => {
            const workflowTasks = workflowTasksMap.get(workflow.id) || [];

            return (
              <div
                key={workflow.id}
                className="relative rounded-xl border border-border bg-bg-secondary/50 overflow-hidden"
              >
                {/* Neural grid background for zone */}
                <div className="neural-grid pointer-events-none absolute inset-0 opacity-10" />

                {/* Workflow header */}
                <div className="relative border-b border-border px-6 py-4">
                  <h2 className="text-lg font-semibold text-text-primary truncate">
                    {workflow.name}
                  </h2>
                  <p className="mt-1 text-xs text-text-muted font-mono">
                    {workflow.id.slice(0, 8)}
                  </p>
                  {workflow.description && (
                    <p className="mt-2 text-sm text-text-secondary line-clamp-2">
                      {workflow.description}
                    </p>
                  )}
                </div>

                {/* Pipeline component */}
                <div className="relative p-4 overflow-hidden">
                  <WorkflowPipeline
                    workflow={workflow}
                    tasksWithRelations={workflowTasks}
                  />
                </div>

                {/* Task count footer */}
                <div className="relative border-t border-border px-6 py-3 flex items-center justify-between text-xs text-text-muted">
                  <span className="flex items-center gap-2">
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                      />
                    </svg>
                    {workflowTasks.length} task{workflowTasks.length !== 1 ? "s" : ""}
                  </span>
                  <span className="flex items-center gap-2">
                    <svg
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 12h16M4 18h7"
                      />
                    </svg>
                    {workflow.steps.length} step
                    {workflow.steps.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
