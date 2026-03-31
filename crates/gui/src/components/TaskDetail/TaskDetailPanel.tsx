import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type {
  TaskLevel,
  TaskPriority,
  TaskChangedEvent,
} from "../../bindings";
import { commands, events } from "../../bindings";
import { useTask } from "../../hooks/useTask";
import { useTaskStore } from "../../stores";
import { ExecutionHistory } from "./ExecutionHistory";
import { DeleteConfirmation } from "../DeleteConfirmation";
import { ResizablePanel } from "../ResizablePanel";
import { Spinner } from "../Spinner";
import { InlineEditField } from "./InlineEditField";
import { Toggle } from "../Toggle";
import { AcceptanceCriteria } from "./AcceptanceCriteria";
import { CollapsibleSection } from "./CollapsibleSection";
import { DependenciesSummary } from "./DependenciesSummary";
import { CodeRefsSummary } from "./CodeRefsSummary";
import { SpecSection } from "./SpecSection";
import { OpenChatButton } from "../OpenChatButton";

/** Debounce delay in milliseconds for batching rapid events */
const DEBOUNCE_MS = 100;

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose?: () => void;
  onTaskSelect?: (taskId: string) => void;
  onBack?: () => void;
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
function getLevelStyles(level: TaskLevel): {
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
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isRunningStep, setIsRunningStep] = useState(false);
  const [isRunningWorkflow, setIsRunningWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const { task: taskData, isLoading, error, refetch } = useTask(taskId);
  const allTasks = useTaskStore((s) => s.tasks);

  // Derive children and dependents from the already-loaded task list
  const childrenIds = useMemo(() => {
    if (!taskId || allTasks.length === 0) return [];
    return allTasks
      .filter((t) => t.parent_id === taskId)
      .map((t) => t.id);
  }, [taskId, allTasks]);

  const dependentIds = useMemo(() => {
    if (!taskId || allTasks.length === 0) return [];
    return allTasks
      .filter((t) => t.dependency_ids?.includes(taskId))
      .map((t) => t.id);
  }, [taskId, allTasks]);

  // Extract sections by type
  const acceptanceCriteria = useMemo(
    () =>
      (taskData?.sections ?? []).filter(
        (s) => s.type === "testing_criterion"
      ),
    [taskData?.sections]
  );

  const checklistItems = useMemo(
    () =>
      (taskData?.sections ?? []).filter((s) => s.type === "checklist_item"),
    [taskData?.sections]
  );

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
    (
      fieldName: "title" | "priority" | "level",
      value: string
    ) => {
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
          priority: fieldName === "priority" ? (editValues.priority as string | null) : taskData.priority,
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
        level: string;
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
          options.add_tags = newTags.filter(t => !currentTags.includes(t));
          options.remove_tags = currentTags.filter(t => !newTags.includes(t));
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

  // Delete confirmation handlers
  const handleShowDeleteConfirmation = useCallback(() => {
    setShowDeleteConfirmation(true);
    setDeleteError(null);
  }, []);

  const handleCancelDelete = useCallback(() => {
    setShowDeleteConfirmation(false);
    setDeleteError(null);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!taskData?.id) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const result = await commands.deleteTask(taskData.id, cascade);

      if (result.status === "error") {
        setDeleteError(result.error.message);
      } else {
        setShowDeleteConfirmation(false);
        onClose?.();
      }
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete task"
      );
    } finally {
      setIsDeleting(false);
    }
  }, [taskData?.id, cascade, onClose]);

  const handleRunStep = useCallback(async () => {
    if (!taskData?.id || !taskData.current_step_id) return;
    setIsRunningStep(true);
    setWorkflowError(null);
    try {
      const result = await commands.runStep(taskData.id, taskData.current_step_id);
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
      const result = await commands.orchestrateTask(taskData.id);
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

  if (!taskId) {
    return null;
  }

  const statusStyles = taskData
    ? getStatusStyles(taskData.step_name ?? "unassigned")
    : null;
  const levelStyles = taskData ? getLevelStyles(taskData.level) : null;
  const priorityStyles = taskData
    ? getPriorityStyles(taskData.priority)
    : null;
  const isExecuting =
    taskData?.step_name === "in_progress" ||
    (taskData?.step_name?.includes(":") &&
      taskData.step_name.split(":").pop() === "in_progress");

  return (
    <ResizablePanel
      storageKey="task-detail-panel-width"
      glowColor="from-primary/0 via-primary/30 to-primary/0"
    >
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
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 19l-7-7 7-7" />
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
            </div>
          ) : (
            <h2 className="font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
              Task Details
            </h2>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Run Step Button */}
          {taskData?.workflow_id && taskData?.current_step_id && (
            <button
              type="button"
              onClick={handleRunStep}
              disabled={isRunningStep || isRunningWorkflow}
              className="cursor-pointer flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary bg-primary/10 text-primary hover:bg-primary/20 hover:shadow-glow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Run current step"
              title="Run the current workflow step"
            >
              {isRunningStep ? (
                <Spinner />
              ) : (
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
              <span>{isRunningStep ? "Running..." : "Run Step"}</span>
            </button>
          )}
          {/* Run Workflow Button */}
          {taskData?.workflow_id && (
            <button
              type="button"
              onClick={handleRunWorkflow}
              disabled={isRunningStep || isRunningWorkflow}
              className="cursor-pointer flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent bg-accent/10 text-accent hover:bg-accent/20 hover:shadow-glow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Run entire workflow"
              title="Run the entire workflow for this task"
            >
              {isRunningWorkflow ? (
                <Spinner />
              ) : (
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              <span>{isRunningWorkflow ? "Running..." : "Run Workflow"}</span>
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
          <button
            type="button"
            onClick={handleShowDeleteConfirmation}
            className="cursor-pointer flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-error bg-error/10 text-error hover:bg-error/20 hover:shadow-glow-sm"
            aria-label="Delete task"
            title="Delete this task"
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
          <div className="border-b border-border px-4 py-3">
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
                {taskData.level}
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

          {/* === ACCEPTANCE CRITERIA (most prominent) === */}
          <div className="border-b border-border">
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
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
                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-muted">
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
            {/* Execution timeline */}
            {taskData.id && <ExecutionHistory taskId={taskData.id} />}
          </CollapsibleSection>

          {/* === SPEC (goal, constraints, collapsible) === */}
          <CollapsibleSection
            title="Spec"
            defaultOpen={false}
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
            />
          </CollapsibleSection>

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
                {(taskData.dependency_ids?.length ?? 0) + dependentIds.length + (taskData.parent_id ? 1 : 0)}
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
                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-muted">
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
              {/* Description */}
              <div className="py-3">
                <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  Description
                </h4>
                <InlineEditField
                  value={taskData.description || ""}
                  placeholder="Click to add description"
                  multiline
                  rows={4}
                  onSave={async (value) => {
                    await onUpdateField("description", value);
                  }}
                />
              </div>

              {/* Priority */}
              <div className="py-3">
                <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  Priority
                </h4>
                {editingField === "priority" ? (
                  <div className="space-y-2">
                    <select
                      value={editValues.priority || ""}
                      onChange={(e) => handleFieldChange("priority", e.target.value)}
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
                    {fieldError && <p className="text-xs text-error">{fieldError}</p>}
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
                    {fieldError && <p className="text-xs text-error">{fieldError}</p>}
                  </div>
                ) : (
                  <p
                    onClick={() => handleFieldClick("level")}
                    className="text-sm text-text-secondary cursor-pointer hover:bg-bg-hover p-2 rounded"
                  >
                    {taskData.level.charAt(0).toUpperCase() + taskData.level.slice(1)}
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
                    const tags = value.split(",").map(t => t.trim()).filter(t => t.length > 0);
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
                    onChange={(checked) => onUpdateField("needs_human_review", checked)}
                    label="Toggle human review requirement"
                    activeColor="warning"
                  />
                </div>
                {taskData.needs_human_review && (
                  <p className="mt-1 text-xs text-warning">This task requires human review before completion</p>
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

          {/* Delete Confirmation Section */}
          {showDeleteConfirmation && (
            <div className="border-t border-border">
              <DeleteConfirmation
                itemType="Task"
                itemName={taskData.title}
                isDeleting={isDeleting}
                error={deleteError}
                onConfirm={handleConfirmDelete}
                onCancel={handleCancelDelete}
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
            </div>
          )}
        </div>
      )}
    </ResizablePanel>
  );
}
