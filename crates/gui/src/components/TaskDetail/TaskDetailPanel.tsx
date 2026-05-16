import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { TaskLevel, TaskPriority, TaskChangedEvent } from "../../bindings";
import { commands, events } from "../../bindings";
import { useTask } from "../../hooks/useTask";
import { useTaskExecutions } from "../../hooks/useTaskExecutions";
import { useDeleteTask } from "../../hooks/useDeleteTask";
import { useTaskStore } from "../../stores";
import { TraceMiniView } from "./TraceMiniView";
import { DeleteConfirmation } from "../DeleteConfirmation";
import { ResizablePanel } from "../ResizablePanel";
import { Spinner } from "../Spinner";
import { InlineEditField } from "./InlineEditField";
import { Toggle } from "../Toggle";
import { AcceptanceCriteria } from "./AcceptanceCriteria";
import { CollapsibleSection } from "./CollapsibleSection";
import { SpineRule } from "../SpineRule";
import { DependenciesSummary } from "./DependenciesSummary";
import { CodeRefsSummary } from "./CodeRefsSummary";
import { SpecSection } from "./SpecSection";
import { OpenChatButton } from "../OpenChatButton";
import { deriveRunControlsState, deriveRunStateChip, getRunChipStyles } from "../../utils/runState";
import { resolveHumanInputGate } from "../../utils/humanInputGate";
import { HumanInputGate } from "../Traces/HumanInputGate";

/** Debounce delay in milliseconds for batching rapid events */
const DEBOUNCE_MS = 100;

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose?: () => void;
  onTaskSelect?: (taskId: string) => void;
  onBack?: () => void;
  /** When omitted, the Detach button is hidden (e.g. inside the pop-out itself). */
  onDetach?: () => void;
  /** Skip the ResizablePanel wrapper and fill the area — used by the pop-out window. */
  standalone?: boolean;
}

/**
 * Get status styling.
 * Status is now a string that can be either:
 * - A step name (e.g., 'backlog', 'in_progress', 'done')
 * - A workflow:step format (e.g., 'default:in_progress')
 */
function getStatusStyles(status: string): {
  bg: string;
  text: string;
  glow?: string;
} {
  // Extract step name from potential workflow:step format
  const stepName = status.includes(":")
    ? (status.split(":").pop() ?? status)
    : status;

  switch (stepName) {
    case "backlog":
      return { bg: "bg-bg-tertiary", text: "text-text-muted" };
    case "todo":
      return { bg: "bg-primary/10", text: "text-primary" };
    case "in_progress":
      return {
        bg: "bg-warning/10",
        text: "text-warning",
        glow: "animate-pulse-glow",
      };
    case "pending_review":
      return { bg: "bg-info/10", text: "text-info" };
    case "done":
      return { bg: "bg-success/10", text: "text-success" };
    case "rejected":
      return { bg: "bg-error/10", text: "text-error" };
    default:
      return { bg: "bg-bg-tertiary", text: "text-text-muted" };
  }
}

/**
 * Get level styling
 */
function getLevelStyles(level: TaskLevel | null): {
  bg: string;
  text: string;
  border: string;
} {
  switch (level) {
    case "epic":
      return { bg: "bg-info/10", text: "text-info", border: "border-info/30" };
    case "ticket":
      return {
        bg: "bg-primary/10",
        text: "text-primary",
        border: "border-primary/30",
      };
    case "task":
      return {
        bg: "bg-bg-tertiary",
        text: "text-text-secondary",
        border: "border-border",
      };
    default:
      return {
        bg: "bg-bg-tertiary",
        text: "text-text-muted",
        border: "border-border",
      };
  }
}

/**
 * Get priority styling
 */
function getPriorityStyles(
  priority: TaskPriority | null
): { indicator: string; color: string } | null {
  if (!priority) return null;

  switch (priority) {
    case "critical":
      return { indicator: "!!!", color: "text-error" };
    case "high":
      return { indicator: "!!", color: "text-warning" };
    case "medium":
      return { indicator: "!", color: "text-text-secondary" };
    case "low":
      return { indicator: "-", color: "text-text-muted" };
    default:
      return null;
  }
}

/**
 * Format datetime for display
 */
function formatDateTime(isoString: string | null): string {
  if (!isoString) return "-";

  try {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

/**
 * Detail row component
 */
function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="text-sm text-text-primary">{children}</span>
    </div>
  );
}

/**
 * TaskDetailPanel displays comprehensive task information in a side panel.
 * Uses an operator-first single-scroll layout with acceptance criteria
 * as the most prominent section, followed by execution progress.
 */
export function TaskDetailPanel({
  taskId,
  onClose,
  onTaskSelect,
  onBack,
  onDetach,
  standalone = false,
}: TaskDetailPanelProps) {
  const [editingField, setEditingField] = useState<
    "title" | "priority" | "level" | null
  >(null);
  const [editValues, setEditValues] = useState<{
    title: string;
    priority: string | null;
    level: string;
  }>({
    title: "",
    priority: null,
    level: "task",
  });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRunningStep, setIsRunningStep] = useState(false);
  const [isRunningWorkflow, setIsRunningWorkflow] = useState(false);
  const [isStoppingWorkflow, setIsStoppingWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const { task: taskData, isLoading, error, refetch } = useTask(taskId);
  const { executions: taskExecutions } = useTaskExecutions(taskId);
  const allTasks = useTaskStore((s) => s.tasks);
  const {
    isDeleteDialogOpen,
    openDeleteDialog,
    closeDeleteDialog,
    cascade,
    setCascade,
    isDeleting,
    deleteError,
    confirmDelete,
  } = useDeleteTask(taskData?.id, { onDeleted: onClose });

  // Derive children and dependents from the already-loaded task list
  const children = useMemo(() => {
    if (!taskId || allTasks.length === 0) return [];
    return allTasks.filter((t) => t.parent_id === taskId);
  }, [taskId, allTasks]);

  const childrenIds = useMemo(() => children.map((t) => t.id), [children]);

  const dependentIds = useMemo(() => {
    if (!taskId || allTasks.length === 0) return [];
    return allTasks
      .filter((t) => t.dependency_ids?.includes(taskId))
      .map((t) => t.id);
  }, [taskId, allTasks]);

  // Extract sections by type
  const acceptanceCriteria = useMemo(
    () =>
      (taskData?.sections ?? []).filter((s) => s.type === "testing_criterion"),
    [taskData?.sections]
  );

  const checklistItems = useMemo(
    () => (taskData?.sections ?? []).filter((s) => s.type === "checklist_item"),
    [taskData?.sections]
  );

  const activeRun = taskData?.run_controls?.active_run ?? null;
  const humanInputGate = useMemo(() => {
    if (!activeRun) return null;
    const runExecs = taskExecutions.filter(
      (e) => e.task_run_id === activeRun.id
    );
    return resolveHumanInputGate(activeRun, runExecs);
  }, [activeRun, taskExecutions]);

  // Track pending refetch for debouncing
  const pendingRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  // Handle task change events for this specific task
  const handleTaskChanged = useCallback(
    (event: { payload: TaskChangedEvent }) => {
      const { task_id, change_type } = event.payload;

      // Only respond to events for the currently displayed task
      if (task_id !== taskId) {
        return;
      }

      console.debug(
        `[TaskDetailPanel] Received ${change_type} event for task ${task_id.slice(0, 6)}`
      );

      // For deletions, refetch immediately (will show error state)
      if (change_type === "Deleted") {
        refetchRef.current();
        return;
      }

      // Debounce updates to batch rapid changes
      if (pendingRefetch.current) {
        clearTimeout(pendingRefetch.current);
      }
      pendingRefetch.current = setTimeout(() => {
        refetchRef.current();
        pendingRefetch.current = null;
      }, DEBOUNCE_MS);
    },
    [taskId]
  );

  // Subscribe to task change events
  useEffect(() => {
    if (!taskId) {
      return;
    }

    const unlistenPromise = events.taskChangedEvent.listen(handleTaskChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());

      // Clear pending timeout on cleanup
      if (pendingRefetch.current) {
        clearTimeout(pendingRefetch.current);
      }
    };
  }, [taskId, handleTaskChanged]);

  // Click-to-edit handlers
  const handleFieldClick = useCallback(
    (fieldName: "title" | "priority" | "level") => {
      if (!taskData) return;

      const fieldMap = {
        title: taskData.title,
        priority: taskData.priority || "",
        level: taskData.level,
      };

      setEditValues((prev) => ({ ...prev, [fieldName]: fieldMap[fieldName] }));
      setEditingField(fieldName);
      setFieldError(null);
    },
    [taskData]
  );

  const handleFieldChange = useCallback(
    (fieldName: "title" | "priority" | "level", value: string) => {
      setEditValues((prev) => ({ ...prev, [fieldName]: value }));
    },
    []
  );

  const handleFieldSave = useCallback(
    async (fieldName: "title" | "priority" | "level") => {
      if (!taskData?.id) return;

      setIsSubmitting(true);
      setFieldError(null);

      try {
        // Validate input
        if (fieldName === "title" && !editValues.title.trim()) {
          setFieldError("Title cannot be empty");
          setIsSubmitting(false);
          return;
        }

        // Build options object with only the changed field
        const options = {
          title: fieldName === "title" ? editValues.title : taskData.title,
          description: taskData.description,
          priority:
            fieldName === "priority"
              ? (editValues.priority as string | null)
              : taskData.priority,
          add_tags: [],
          remove_tags: [],
          level: fieldName === "level" ? editValues.level : taskData.level,
          needs_human_review: taskData.needs_human_review,
          archived: null as boolean | null,
          worktree: null as string | null,
          revision_feedback: taskData.revision_feedback,
        };

        // Call updateTask command
        const result = await commands.updateTask(taskData.id, options);

        if (result.status === "error") {
          setFieldError(result.error.message);
        } else {
          setEditingField(null);
          refetch();
        }
      } catch (err) {
        setFieldError(
          err instanceof Error ? err.message : "Failed to save field"
        );
      } finally {
        setIsSubmitting(false);
      }
    },
    [taskData, editValues, refetch]
  );

  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
      fieldName: "title" | "priority" | "level"
    ) => {
      if (e.key === "Escape") {
        setEditingField(null);
        setFieldError(null);
      } else if (e.key === "Enter" && e.ctrlKey) {
        handleFieldSave(fieldName);
      }
    },
    [handleFieldSave]
  );

  // Generic field update handler for InlineEditField components
  const onUpdateField = useCallback(
    async (field: string, value: string | boolean | string[]) => {
      if (!taskData?.id) return;

      // Build update options based on the field being updated
      const options: {
        title: string;
        description: string | null;
        priority: string | null;
        add_tags: string[];
        remove_tags: string[];
        level: string | null;
        needs_human_review: boolean;
        archived: boolean | null;
        worktree: string | null;
        revision_feedback: string | null;
      } = {
        title: taskData.title,
        description: taskData.description,
        priority: taskData.priority,
        add_tags: [],
        remove_tags: [],
        level: taskData.level,
        needs_human_review: taskData.needs_human_review ?? false,
        archived: null,
        worktree: null,
        revision_feedback: taskData.revision_feedback,
      };

      switch (field) {
        case "description":
          options.description = (value as string) || null;
          break;
        case "tags": {
          // For tags, we need to compute the difference
          const newTags = value as string[];
          const currentTags = taskData.tags ?? [];
          options.add_tags = newTags.filter((t) => !currentTags.includes(t));
          options.remove_tags = currentTags.filter((t) => !newTags.includes(t));
          break;
        }
        case "needs_human_review":
          options.needs_human_review = value as boolean;
          break;
        case "revision_feedback":
          options.revision_feedback = (value as string) || null;
          break;
      }

      const result = await commands.updateTask(taskData.id, options);
      if (result.status === "error") {
        throw new Error(result.error.message);
      }
      refetch();
    },
    [taskData, refetch]
  );

  const handleRunStep = useCallback(async () => {
    if (!taskData?.id || !taskData.current_step_id) return;
    setIsRunningStep(true);
    setWorkflowError(null);
    try {
      const result = await commands.runStep(
        taskData.id,
        taskData.current_step_id
      );
      if (result.status === "error") {
        setWorkflowError(result.error.message);
      }
    } catch (err) {
      setWorkflowError(
        err instanceof Error ? err.message : "Failed to run step"
      );
    } finally {
      setIsRunningStep(false);
    }
  }, [taskData?.id, taskData?.current_step_id]);

  const handleRunWorkflow = useCallback(async () => {
    if (!taskData?.id) return;
    setIsRunningWorkflow(true);
    setWorkflowError(null);
    try {
      const result = await commands.runWorkflow(taskData.id);
      if (result.status === "error") {
        setWorkflowError(result.error.message);
      }
    } catch (err) {
      setWorkflowError(
        err instanceof Error ? err.message : "Failed to start workflow"
      );
    } finally {
      setIsRunningWorkflow(false);
    }
  }, [taskData?.id]);

  const handleStopWorkflow = useCallback(async () => {
    if (!taskData?.id) return;
    setIsStoppingWorkflow(true);
    setWorkflowError(null);
    try {
      const activeRunId = taskData.run_controls?.active_run?.id || null;
      const result = await commands.stopRun({
        task_run_id: activeRunId,
        task_id: activeRunId ? null : taskData.id,
      });
      if (result.status === "error") {
        setWorkflowError(result.error.message);
      }
    } catch (err) {
      setWorkflowError(
        err instanceof Error ? err.message : "Failed to stop workflow"
      );
    } finally {
      setIsStoppingWorkflow(false);
    }
  }, [taskData?.id, taskData?.run_controls?.active_run?.id]);

  if (!taskId) {
    return null;
  }

  const statusStyles = taskData
    ? getStatusStyles(taskData.step_name ?? "unassigned")
    : null;
  const levelStyles = taskData ? getLevelStyles(taskData.level) : null;
  const priorityStyles = taskData ? getPriorityStyles(taskData.priority) : null;
  const runControlsState = deriveRunControlsState(
    taskData?.run_controls ?? null,
    { hasWorkflow: Boolean(taskData?.workflow_id) }
  );
  const runChip = taskData
    ? deriveRunStateChip(taskData, { includeTerminal: false })
    : null;
  const runChipStyles = runChip ? getRunChipStyles(runChip) : null;
  const isExecuting = runControlsState.hasActiveRun;
  const runWorkflowDisabled =
    isRunningStep || isRunningWorkflow || runControlsState.runDisabled;
  const shouldShowStopWorkflow = runControlsState.showStop;
  const stopWorkflowDisabled =
    isStoppingWorkflow || runControlsState.stopDisabled;
  const deleteConfirmation =
    taskData && isDeleteDialogOpen ? (
      <DeleteConfirmation
        itemType="Task"
        itemName={taskData.title}
        isDeleting={isDeleting}
        error={deleteError}
        onConfirm={confirmDelete}
        onCancel={closeDeleteDialog}
        testId="task-delete-confirmation"
      >
        {childrenIds.length > 0 && (
          <div className="rounded border border-warning/20 bg-warning/5 p-2.5">
            <p className="text-xs text-warning font-medium mb-2">
              This task has {childrenIds.length} child task
              {childrenIds.length !== 1 ? "s" : ""}
            </p>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
                disabled={isDeleting}
                className="rounded border border-border"
              />
              <span className="text-xs text-text-secondary">
                Delete all child tasks
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer mt-1.5">
              <input
                type="checkbox"
                checked={!cascade}
                onChange={(e) => setCascade(!e.target.checked)}
                disabled={isDeleting}
                className="rounded border border-border"
              />
              <span className="text-xs text-text-secondary">
                Keep child tasks without parent
              </span>
            </label>
          </div>
        )}
      </DeleteConfirmation>
    ) : null;

  const content = (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Go back"
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
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          )}
          {/* Workflow -> Step breadcrumb */}
          {taskData?.workflow_name ? (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="font-medium text-text-secondary">
                {taskData.workflow_name}
              </span>
              {taskData.step_name && (
                <>
                  <svg
                    className="h-3 w-3 text-text-muted"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusStyles?.bg ?? ""} ${statusStyles?.text ?? ""} ${isExecuting ? "animate-pulse-glow" : ""}`}
                    data-testid="status-badge"
                  >
                    {taskData.step_name.replace("_", " ")}
                  </span>
                </>
              )}
              {runChip && runChipStyles && (
                <span
                  data-testid="task-detail-run-chip"
                  data-run-status={runChip.status}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${runChipStyles.bg} ${runChipStyles.text}`}
                  aria-label={`Run state: ${runChip.label}`}
                >
                  {runChip.label}
                </span>
              )}
            </div>
          ) : (
            <h2 className="font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
              Task Details
            </h2>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Run Step Button */}
          {taskData?.workflow_id && taskData?.current_step_id && !runControlsState.hasActiveRun && (
            <button
              type="button"
              onClick={handleRunStep}
              disabled={isRunningStep || isRunningWorkflow}
              className="cursor-pointer flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-medium text-text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Run current step"
              title="Run the current workflow step"
            >
              {isRunningStep ? (
                <Spinner />
              ) : (
                <svg
                  className="h-3.5 w-3.5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
              <span>{isRunningStep ? "Running..." : "Run Step"}</span>
            </button>
          )}
          {/* Run Workflow Button */}
          {taskData?.workflow_id && !runControlsState.hasActiveRun && (
            <button
              type="button"
              data-testid="task-detail-run-button"
              onClick={handleRunWorkflow}
              disabled={runWorkflowDisabled}
              className="cursor-pointer flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary bg-primary text-bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Run entire workflow"
              title="Run the entire workflow for this task"
            >
              {isRunningWorkflow ? (
                <Spinner />
              ) : (
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              )}
              <span>{isRunningWorkflow ? "Running..." : "Run Workflow"}</span>
            </button>
          )}
          {shouldShowStopWorkflow && (
            <button
              type="button"
              data-testid="task-detail-stop-button"
              onClick={handleStopWorkflow}
              disabled={stopWorkflowDisabled}
              className="cursor-pointer flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-error bg-error text-white hover:bg-error/90 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Stop running workflow"
              title={
                runControlsState.isStopping
                  ? "Cancel the in-flight stop request"
                  : "Stop the running orchestrator for this task"
              }
            >
              {isStoppingWorkflow ? (
                <Spinner />
              ) : (
                <svg
                  className="h-3.5 w-3.5"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              )}
              <span>
                {isStoppingWorkflow
                  ? "Stopping..."
                  : runControlsState.isStopping
                    ? "Cancel orchestration"
                    : "Stop"}
              </span>
            </button>
          )}
          {/* Open Chat Button */}
          {taskData?.id && (
            <OpenChatButton
              scope="task"
              entityId={taskData.id}
              label={taskData.title}
            />
          )}
          {/* Delete Button */}
          {taskData && (
            <button
              type="button"
              onClick={openDeleteDialog}
              className="cursor-pointer flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-error hover:bg-error/10 hover:text-error"
              aria-label="Delete task"
              title="Delete this task"
              data-testid="task-detail-delete-button"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A1 1 0 0016.138 21H7.862a1 1 0 00-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              <span>Delete</span>
            </button>
          )}
          {onDetach && (
            <button
              type="button"
              onClick={onDetach}
              className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Detach into pop-out window"
              title="Open in a new window"
              data-testid="detach-button"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M14 3h7v7m0-7L10 14m-4-7H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-1"
                />
              </svg>
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Close panel"
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {deleteConfirmation}

      {/* Workflow error banner */}
      {workflowError && (
        <div className="mx-4 mt-2 rounded-lg border border-error/30 bg-error/5 px-3 py-2 text-xs text-error">
          {workflowError}
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" />
              <div className="absolute inset-0 animate-pulse rounded-full bg-primary/10" />
            </div>
            <p className="text-xs text-text-muted">Loading task...</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="text-center">
            <div className="relative mx-auto mb-3 inline-block">
              <div className="absolute inset-0 rounded-full bg-error/20 blur-lg" />
              <svg
                className="relative h-10 w-10 text-error"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <p className="mb-2 text-sm font-medium text-text-primary">
              Failed to load task
            </p>
            <p className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 font-mono text-xs text-error">
              {error}
            </p>
          </div>
        </div>
      )}

      {/* Content - single scroll layout */}
      {taskData && !isLoading && !error && (
        <div className="flex-1 overflow-auto">
          {/* Title + badges row */}
          <div className="px-4 pt-4 pb-3">
            {editingField === "title" ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={editValues.title}
                  onChange={(e) => handleFieldChange("title", e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, "title")}
                  onBlur={() => handleFieldSave("title")}
                  autoFocus
                  disabled={isSubmitting}
                  className="w-full rounded border border-primary/30 bg-bg-secondary px-2 py-1.5 text-sm font-medium text-text-primary placeholder-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                  placeholder="Enter title"
                />
                {fieldError && (
                  <p className="text-xs text-error">{fieldError}</p>
                )}
              </div>
            ) : (
              <h3
                onClick={() => handleFieldClick("title")}
                className="text-sm font-medium leading-snug text-text-primary cursor-pointer hover:bg-bg-hover p-2 rounded"
              >
                {taskData.title}
              </h3>
            )}
            {/* Compact badges */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${levelStyles?.bg} ${levelStyles?.text} ${levelStyles?.border}`}
              >
                {taskData.level ?? "unknown"}
              </span>
              {!taskData.workflow_name && (
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusStyles?.bg} ${statusStyles?.text} ${isExecuting ? "animate-pulse-glow" : ""}`}
                >
                  {(taskData.step_name ?? "unassigned").replace("_", " ")}
                </span>
              )}
              {priorityStyles && (
                <span
                  className={`font-mono text-xs font-bold ${priorityStyles.color}`}
                >
                  {priorityStyles.indicator}
                </span>
              )}
              <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                {taskData.id?.slice(0, 8) ?? "-"}
              </code>
            </div>
          </div>
          <div className="px-4 py-3">
            <SpineRule />
          </div>

          {/* Rejection Reason Banner */}
          {taskData.rejection_reason && (
            <div className="mx-4 mt-3 rounded-lg border border-error/30 bg-error/10 p-3">
              <div className="flex items-start gap-2">
                <svg
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-error"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <div className="min-w-0">
                  <h4 className="text-xs font-semibold text-error">
                    Rejection Reason
                  </h4>
                  <p className="mt-0.5 whitespace-pre-wrap text-xs text-text-secondary">
                    {taskData.rejection_reason}
                  </p>
                </div>
              </div>
            </div>
          )}

          {humanInputGate && (
            <div className="mx-4 mt-3">
              <HumanInputGate
                context={humanInputGate}
                stoppable={runControlsState.stoppable}
                isStopping={isStoppingWorkflow || runControlsState.isStopping}
                onStop={handleStopWorkflow}
              />
            </div>
          )}

          {/* === ACCEPTANCE CRITERIA (most prominent) === */}
          <div>
            <div className="flex items-center justify-between px-4 pt-4 pb-2">
              <div className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-success"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-primary">
                  Acceptance Criteria
                </h3>
              </div>
            </div>
            <AcceptanceCriteria
              criteria={acceptanceCriteria}
              taskId={taskData.id}
              onSectionsChanged={refetch}
            />
            <div className="px-4 py-3">
              <SpineRule />
            </div>
          </div>

          {/* === PROGRESS / EXECUTION TIMELINE === */}
          <CollapsibleSection
            title="Progress"
            defaultOpen={true}
            testId="progress-section"
            icon={
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            }
            badge={
              checklistItems.length > 0 ? (
                <span className="font-mono text-[10px] text-text-muted">
                  {checklistItems.filter((c) => c.done).length}/
                  {checklistItems.length}
                </span>
              ) : undefined
            }
          >
            {/* Checklist items */}
            {checklistItems.length > 0 && (
              <div className="space-y-1 px-4 pb-2">
                {[...checklistItems]
                  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                  .map((item, i) => (
                    <div
                      key={`checklist-${item.order ?? i}`}
                      className="flex items-start gap-2 py-1"
                    >
                      <span
                        className={`mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[10px] ${
                          item.done
                            ? "bg-success/20 text-success"
                            : "bg-bg-tertiary text-text-muted"
                        }`}
                      >
                        {item.done ? (
                          <svg
                            className="h-2.5 w-2.5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={3}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                        ) : (
                          <span className="font-mono">
                            {(item.order ?? i) + 1}
                          </span>
                        )}
                      </span>
                      <span
                        className={`text-xs leading-relaxed ${
                          item.done
                            ? "text-text-muted line-through"
                            : "text-text-secondary"
                        }`}
                      >
                        {item.content}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {/* Trace mini-view (entry into dedicated /traces explorer) */}
            {taskData.id && (
              <TraceMiniView
                taskId={taskData.id}
                workflowName={taskData.workflow_name}
                stepName={taskData.step_name}
              />
            )}
          </CollapsibleSection>

          {/* === SPEC (description, goal, constraints) === */}
          <CollapsibleSection
            title="Spec"
            defaultOpen={true}
            testId="spec-section-wrapper"
            icon={
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            }
          >
            <SpecSection
              description={taskData.description}
              sections={taskData.sections ?? []}
              onDescriptionChange={async (value) => {
                await onUpdateField("description", value);
              }}
            />
          </CollapsibleSection>

          {/* === CHILDREN (child tasks) === */}
          {children.length > 0 && (
            <CollapsibleSection
              title="Children"
              defaultOpen={true}
              testId="children-section"
              icon={
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                  />
                </svg>
              }
              badge={
                <span className="font-mono text-[10px] text-text-muted">
                  {children.length}
                </span>
              }
            >
              <div className="space-y-1 px-4 py-2">
                {children.map((child) => {
                  const childLevelStyles = getLevelStyles(child.level);
                  const childStepName =
                    child.step_name?.replace("_", " ") ?? null;

                  return (
                    <button
                      key={child.id}
                      type="button"
                      onClick={() => onTaskSelect?.(child.id)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-bg-tertiary/50 cursor-pointer"
                      data-testid={`child-task-${child.id}`}
                    >
                      <span
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${childLevelStyles.bg} ${childLevelStyles.text} ${childLevelStyles.border}`}
                      >
                        {child.level ?? "?"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                        {child.title}
                      </span>
                      {childStepName && (
                        <span className="flex-shrink-0 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted">
                          {childStepName}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </CollapsibleSection>
          )}

          {/* === DEPENDENCIES (blocked by, blocking, parent) === */}
          <CollapsibleSection
            title="Dependencies"
            defaultOpen={false}
            testId="dependencies-section"
            icon={
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
            }
            badge={
              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-muted">
                {(taskData.dependency_ids?.length ?? 0) +
                  dependentIds.length +
                  (taskData.parent_id ? 1 : 0)}
              </span>
            }
          >
            <DependenciesSummary
              parentId={taskData.parent_id}
              dependsOnIds={taskData.dependency_ids ?? []}
              dependentIds={dependentIds}
              onTaskSelect={onTaskSelect}
            />
          </CollapsibleSection>

          {/* === CODE (file path references) === */}
          <CollapsibleSection
            title="Code"
            defaultOpen={false}
            testId="code-section"
            icon={
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                />
              </svg>
            }
            badge={
              (taskData.code_refs?.length ?? 0) > 0 ? (
                <span className="font-mono text-[10px] text-text-muted">
                  {taskData.code_refs?.length}
                </span>
              ) : undefined
            }
          >
            <CodeRefsSummary codeRefs={taskData.code_refs ?? []} />
          </CollapsibleSection>

          {/* === DETAILS (metadata, editing, etc.) === */}
          <CollapsibleSection
            title="Details"
            defaultOpen={false}
            testId="details-section"
            icon={
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            }
          >
            <div className="divide-y divide-border px-4 py-2">
              {/* Priority */}
              <div className="py-3">
                <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  Priority
                </h4>
                {editingField === "priority" ? (
                  <div className="space-y-2">
                    <select
                      value={editValues.priority || ""}
                      onChange={(e) =>
                        handleFieldChange("priority", e.target.value)
                      }
                      onKeyDown={(e) => handleKeyDown(e, "priority")}
                      onBlur={() => handleFieldSave("priority")}
                      autoFocus
                      disabled={isSubmitting}
                      className="w-full rounded border border-primary/30 bg-bg-secondary px-2 py-1.5 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="">None</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                    {fieldError && (
                      <p className="text-xs text-error">{fieldError}</p>
                    )}
                  </div>
                ) : (
                  <p
                    onClick={() => handleFieldClick("priority")}
                    className="text-sm text-text-secondary cursor-pointer hover:bg-bg-hover p-2 rounded"
                  >
                    {taskData.priority || "None"}
                  </p>
                )}
              </div>

              {/* Level */}
              <div className="py-3">
                <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  Level
                </h4>
                {editingField === "level" ? (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      {["epic", "ticket", "task"].map((level) => (
                        <button
                          key={level}
                          type="button"
                          onClick={() => {
                            handleFieldChange("level", level);
                            handleFieldSave("level");
                          }}
                          disabled={isSubmitting}
                          className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                            editValues.level === level
                              ? "bg-primary text-white"
                              : "border border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary"
                          } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                          {level.charAt(0).toUpperCase() + level.slice(1)}
                        </button>
                      ))}
                    </div>
                    {fieldError && (
                      <p className="text-xs text-error">{fieldError}</p>
                    )}
                  </div>
                ) : (
                  <p
                    onClick={() => handleFieldClick("level")}
                    className="text-sm text-text-secondary cursor-pointer hover:bg-bg-hover p-2 rounded"
                  >
                    {taskData.level
                      ? taskData.level.charAt(0).toUpperCase() +
                        taskData.level.slice(1)
                      : "Unknown"}
                  </p>
                )}
              </div>

              {/* Tags */}
              <div className="py-3">
                <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  Tags
                </h4>
                <InlineEditField
                  value={(taskData.tags ?? []).join(", ")}
                  placeholder="Click to add tags (comma-separated)"
                  onSave={async (value) => {
                    const tags = value
                      .split(",")
                      .map((t) => t.trim())
                      .filter((t) => t.length > 0);
                    await onUpdateField("tags", tags);
                  }}
                />
              </div>

              {/* Timestamps */}
              <div className="py-3">
                <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  Timeline
                </h4>
                <div className="space-y-1">
                  <DetailRow label="Created">
                    {formatDateTime(taskData.created_at)}
                  </DetailRow>
                  <DetailRow label="Updated">
                    {formatDateTime(taskData.updated_at)}
                  </DetailRow>
                  {taskData.started_at && (
                    <DetailRow label="Started">
                      {formatDateTime(taskData.started_at)}
                    </DetailRow>
                  )}
                  {taskData.completed_at && (
                    <DetailRow label="Completed">
                      {formatDateTime(taskData.completed_at)}
                    </DetailRow>
                  )}
                </div>
              </div>

              {/* Worktree */}
              {taskData.worktree && (
                <div className="py-3">
                  <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                    Worktree
                  </h4>
                  <p className="font-mono text-xs text-text-secondary break-all">
                    {taskData.worktree}
                  </p>
                </div>
              )}

              {/* Human Review Toggle */}
              <div className="py-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
                    Human Review
                  </h4>
                  <Toggle
                    checked={taskData.needs_human_review ?? false}
                    onChange={(checked) =>
                      onUpdateField("needs_human_review", checked)
                    }
                    label="Toggle human review requirement"
                    activeColor="warning"
                  />
                </div>
                {taskData.needs_human_review && (
                  <p className="mt-1 text-xs text-warning">
                    This task requires human review before completion
                  </p>
                )}
              </div>

              {/* Revision Feedback */}
              <div className="py-3">
                <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  Revision Feedback
                </h4>
                <InlineEditField
                  value={taskData.revision_feedback || ""}
                  placeholder="Click to add revision feedback"
                  multiline
                  rows={4}
                  onSave={async (value) => {
                    await onUpdateField("revision_feedback", value);
                  }}
                />
              </div>
            </div>
          </CollapsibleSection>

        </div>
      )}
    </>
  );

  if (standalone) {
    return (
      <div
        className="relative flex h-full w-full flex-col bg-bg-secondary"
        data-testid="task-detail-panel-standalone"
      >
        {content}
      </div>
    );
  }

  return (
    <ResizablePanel
      storageKey="task-detail-panel-width"
      glowColor="from-primary/0 via-primary/30 to-primary/0"
    >
      {content}
    </ResizablePanel>
  );
}
