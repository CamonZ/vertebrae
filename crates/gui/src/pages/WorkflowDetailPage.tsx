import { useParams, Link } from "react-router-dom";
import { useState, useCallback, useMemo, useEffect } from "react";
import { commands, type TaskWithRelations, type Step } from "../bindings";
import { useWorkflow } from "../hooks/useWorkflow";
import { useWorkflowChangeListener } from "../hooks/useWorkflowChangeListener";
import { useTaskChangeListener } from "../hooks/useTaskChangeListener";
import { useWorkflowExecutionListener } from "../hooks/useWorkflowExecutionListener";
import { useToastStore } from "../stores";
import { WorkflowPipeline } from "../components/WorkflowPipeline";

/**
 * Truncate workflow ID for display (show first 6 characters)
 */
function truncateId(id: string): string {
  return id.slice(0, 6);
}

/**
 * WorkflowDetailPage displays a workflow's pipeline view.
 * Features neural-pathway-inspired design with animated connections.
 * Automatically refreshes when workflow or task change events are received.
 */
export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const {
    workflow: workflowWithTasks,
    isLoading,
    error,
    refetch,
  } = useWorkflow(id);

  const addToast = useToastStore((state) => state.addToast);

  // State for fetched task relationships
  const [tasksWithRelations, setTasksWithRelations] = useState<
    TaskWithRelations[]
  >([]);

  // State for first-class steps (used to resolve current_step_id to step name)
  const [steps, setSteps] = useState<Step[]>([]);

  // Map from step ID to step name for quick lookup
  const stepIdToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const step of steps) {
      if (step.id) {
        map.set(step.id, step.name);
      }
    }
    return map;
  }, [steps]);

  // Fetch workflow with all task details in a single call
  useEffect(() => {
    const fetchWorkflowWithTaskDetails = async () => {
      if (!id) {
        setTasksWithRelations([]);
        return;
      }

      try {
        const result = await commands.getWorkflowWithTaskDetails(id);
        if (result.status === "ok") {
          setTasksWithRelations(result.data.tasks);
        } else {
          addToast(`Failed to load workflow tasks: ${result.error.message}`, "error");
          setTasksWithRelations([]);
        }
      } catch (err) {
        addToast(`Failed to load workflow tasks: ${String(err)}`, "error");
        setTasksWithRelations([]);
      }
    };

    fetchWorkflowWithTaskDetails();
  }, [id, addToast]);

  // Fetch first-class steps for the workflow
  useEffect(() => {
    const fetchSteps = async () => {
      if (!id) {
        setSteps([]);
        return;
      }

      try {
        const result = await commands.listStepsForWorkflow(id);
        if (result.status === "ok") {
          setSteps(result.data);
        } else {
          // Steps may not exist for all workflows, so just log
          console.debug(`No first-class steps for workflow: ${result.error.message}`);
          setSteps([]);
        }
      } catch (err) {
        console.debug(`Failed to fetch steps: ${String(err)}`);
        setSteps([]);
      }
    };

    fetchSteps();
  }, [id]);

  // Execution state: Map of taskId -> { currentStep, status, error }
  // Initialize with all tasks in "waiting" status
  const initialExecutionState = useMemo(() => {
    const state = new Map<
      string,
      { currentStep: string | number; status: string; error?: string }
    >();
    if (tasksWithRelations.length > 0) {
      for (const tr of tasksWithRelations) {
        state.set(tr.task.id!, { currentStep: "queue", status: "waiting" });
      }
    }
    return state;
  }, [tasksWithRelations]);

  const [executionState, setExecutionState] = useState(initialExecutionState);
  const [isExecuting, setIsExecuting] = useState(false);

  // Update execution state when tasks load
  useEffect(() => {
    setExecutionState(initialExecutionState);
  }, [initialExecutionState]);

  // Subscribe to workflow change events for this workflow
  useWorkflowChangeListener({
    onWorkflowChange: refetch,
  });

  // Subscribe to task change events - workflow shows associated tasks
  useTaskChangeListener({
    onTaskListChange: refetch,
  });

  // Subscribe to workflow execution events for this workflow
  const workflowData = workflowWithTasks?.workflow;
  useWorkflowExecutionListener(workflowData?.id || "", {
    onStarted: (taskId) => {
      setExecutionState((prev) => {
        const next = new Map(prev);
        const state = next.get(taskId);
        if (state) {
          next.set(taskId, { ...state, currentStep: 0, status: "in_progress" });
        }
        return next;
      });
    },
    onStepStarted: (taskId, stepName) => {
      setExecutionState((prev) => {
        const next = new Map(prev);
        const state = next.get(taskId);
        if (state) {
          next.set(taskId, {
            ...state,
            currentStep: stepName,
            status: "in_progress",
          });
        }
        return next;
      });
    },
    onStepFailed: (_executionId, error) => {
      setExecutionState((prev) => {
        const next = new Map(prev);
        for (const [taskId, state] of next.entries()) {
          if (state.status === "in_progress") {
            next.set(taskId, { ...state, status: "failed", error });
            break;
          }
        }
        return next;
      });
      addToast(`Step failed: ${error}`, "error");
    },
    onCompleted: (taskId) => {
      setExecutionState((prev) => {
        const next = new Map(prev);
        next.set(taskId, { currentStep: "completed", status: "completed" });
        return next;
      });
      setIsExecuting(false);
      addToast(`Task ${taskId.slice(0, 6)} completed`, "success");
    },
    onFailed: (taskId, error) => {
      setExecutionState((prev) => {
        const next = new Map(prev);
        next.set(taskId, { currentStep: "failed", status: "failed", error });
        return next;
      });
      setIsExecuting(false);
      addToast(`Task failed: ${error}`, "error");
    },
  });

  // Get all waiting tasks (only active tasks, not done/rejected)
  const waitingTasks = useMemo(() => {
    return tasksWithRelations.filter((tr) => {
      const isActive =
        tr.task.status !== "done" && tr.task.status !== "rejected";
      const state = executionState.get(tr.task.id!);
      return isActive && state?.status === "waiting";
    });
  }, [tasksWithRelations, executionState]);

  // Execute all waiting tasks
  const handlePlayClick = useCallback(async () => {
    if (waitingTasks.length === 0) return;

    try {
      setIsExecuting(true);
      for (const tr of waitingTasks) {
        // Reset execution state for this task
        setExecutionState((prev) => {
          const next = new Map(prev);
          next.set(tr.task.id!, { currentStep: "queue", status: "waiting" });
          return next;
        });
        // Start execution
        await commands.runWorkflow(tr.task.id!);
      }
      addToast(
        `Workflow started for ${waitingTasks.length} task${waitingTasks.length !== 1 ? "s" : ""}`,
        "success"
      );
    } catch (err) {
      setIsExecuting(false);
      addToast(`Failed to start workflow: ${String(err)}`, "error");
    }
  }, [waitingTasks, addToast]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
            <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
          </div>
          <p className="text-sm text-text-muted">Loading workflow...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="m-6 rounded-xl border border-error/30 bg-error/5 p-6">
        <h2 className="mb-2 text-lg font-semibold text-text-primary">
          Error Loading Workflow
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

  if (!workflowWithTasks) {
    return (
      <div className="m-6 rounded-xl border border-border bg-bg-secondary p-6">
        <p className="text-text-muted">Workflow not found</p>
        <Link
          to="/workflows"
          className="mt-4 inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          Back to Workflows
        </Link>
      </div>
    );
  }

  const { tasks } = workflowWithTasks;
  const workflowId = workflowData?.id ?? "";

  if (!workflowData) {
    return (
      <div className="m-6 rounded-xl border border-border bg-bg-secondary p-6">
        <p className="text-text-muted">Workflow data not found</p>
        <Link
          to="/workflows"
          className="mt-4 inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          Back to Workflows
        </Link>
      </div>
    );
  }

  return (
    <div className="relative flex-1 space-y-6 overflow-auto p-6">
      {/* Neural grid background */}
      <div className="neural-grid pointer-events-none absolute inset-0 opacity-20" />

      {/* Header */}
      <div className="relative rounded-xl border border-border bg-bg-secondary p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="mb-2 flex items-center gap-3">
              <Link
                to="/workflows"
                className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary flex-shrink-0"
                aria-label="Back to workflows"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M10 19l-7-7m0 0l7-7m-7 7h18"
                  />
                </svg>
              </Link>
              <h1 className="text-xl font-bold text-text-primary whitespace-nowrap">
                {workflowData.name}
              </h1>
            </div>
            <code className="rounded bg-bg-tertiary px-2 py-1 font-mono text-xs text-text-muted">
              {truncateId(workflowId)}
            </code>
          </div>

          <div className="flex items-center gap-4 text-sm text-text-secondary">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5">
              <svg
                className="h-4 w-4 text-primary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 6h16M4 12h16M4 18h7"
                />
              </svg>
              <span className="font-mono text-xs">
                {steps.length} step
                {steps.length !== 1 ? "s" : ""}
              </span>
            </div>

            {tasks.length > 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5">
                <svg
                  className="h-4 w-4 text-info"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
                <span className="font-mono text-xs">
                  {tasks.length} task{tasks.length !== 1 ? "s" : ""}
                </span>
              </div>
            )}
          </div>
        </div>

        {workflowData.description && (
          <p className="mt-4 text-sm text-text-secondary">
            {workflowData.description}
          </p>
        )}

        {/* Chain indicators */}
        {(workflowData.on_done_workflow || workflowData.on_reject_workflow) && (
          <div className="mt-4 flex gap-4">
            {workflowData.on_done_workflow && (
              <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-medium text-success">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M13 7l5 5m0 0l-5 5m5-5H6"
                  />
                </svg>
                <span>
                  On done: {truncateId(workflowData.on_done_workflow)}
                </span>
              </div>
            )}
            {workflowData.on_reject_workflow && (
              <div className="flex items-center gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-1.5 text-xs font-medium text-error">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
                <span>
                  On reject: {truncateId(workflowData.on_reject_workflow)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pipeline View with Execution */}
      <div className="relative">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Workflow Pipeline
          </h2>
          {waitingTasks.length > 0 && (
            <button
              onClick={handlePlayClick}
              disabled={isExecuting}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Execute ${waitingTasks.length} waiting task${waitingTasks.length !== 1 ? "s" : ""}`}
            >
              <span>▶</span>
              <span>Execute ({waitingTasks.length})</span>
            </button>
          )}
        </div>
        <WorkflowPipeline
          workflow={workflowData}
          steps={steps}
          executionState={executionState}
          tasksWithRelations={tasksWithRelations}
          stepIdToName={stepIdToName}
          isExecuting={isExecuting}
        />
      </div>

    </div>
  );
}
