import { useState, useEffect, useRef, useCallback } from "react";
import type {
  TaskWithRelations,
  TaskLevel,
  TaskPriority,
  TaskChangedEvent,
} from "../../bindings";
import { commands, events } from "../../bindings";
import { useTask } from "../../hooks/useTask";
import { TaskSections } from "./TaskSections";
import { TaskCodeRefs } from "./TaskCodeRefs";
import { TaskRelations } from "./TaskRelations";
import { ExecutionHistory } from "./ExecutionHistory";
import { DeleteConfirmation } from "../DeleteConfirmation";
import { ResizablePanel } from "../ResizablePanel";
import { InlineEditField } from "./InlineEditField";
import { Toggle } from "../Toggle";

/** Debounce delay in milliseconds for batching rapid events */
const DEBOUNCE_MS = 100;

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose?: () => void;
  onTaskSelect?: (taskId: string) => void;
}

type TabId = "details" | "sections" | "code_refs" | "relations" | "history";

interface Tab {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: Tab[] = [
  {
    id: "details",
    label: "Details",
    icon: (
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
    ),
  },
  {
    id: "sections",
    label: "Sections",
    icon: (
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
          d="M4 6h16M4 12h16M4 18h7"
        />
      </svg>
    ),
  },
  {
    id: "code_refs",
    label: "Code",
    icon: (
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
    ),
  },
  {
    id: "relations",
    label: "Graph",
    icon: (
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
    ),
  },
  {
    id: "history",
    label: "History",
    icon: (
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
    ),
  },
];

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
        glow: "shadow-[0_0_8px_rgba(245,158,11,0.3)]",
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
 * Task details tab content
 */
function TaskDetailsTab({
  taskData,
  editingField,
  editValues,
  isSubmitting,
  fieldError,
  onFieldClick,
  onFieldChange,
  onFieldSave,
  onKeyDown,
  onUpdateField,
  showDeleteConfirmation,
  deleteError,
  isDeleting,
  cascade,
  onCancelDelete,
  onConfirmDelete,
  onCascadeChange,
}: {
  taskData: TaskWithRelations;
  editingField: "title" | "priority" | "level" | null;
  editValues: {
    title: string;
    priority: string | null;
    level: string;
  };
  isSubmitting: boolean;
  fieldError: string | null;
  onFieldClick: (field: "title" | "priority" | "level") => void;
  onFieldChange: (
    field: "title" | "priority" | "level",
    value: string
  ) => void;
  onFieldSave: (fieldName: "title" | "priority" | "level") => void;
  onKeyDown: (
    e: React.KeyboardEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
    field: "title" | "priority" | "level"
  ) => void;
  onUpdateField: (field: string, value: string | boolean | string[]) => Promise<void>;
  showDeleteConfirmation: boolean;
  deleteError: string | null;
  isDeleting: boolean;
  cascade: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onCascadeChange: (value: boolean) => void;
}) {
  const { task } = taskData;
  const statusStyles = getStatusStyles(task.status);
  const levelStyles = getLevelStyles(task.level);
  const priorityStyles = getPriorityStyles(task.priority);

  return (
    <div className="divide-y divide-border">
      {/* Status Badges */}
      <div className="flex flex-wrap gap-2 p-4">
        <span
          className={`inline-flex items-center rounded border px-2 py-1 text-[10px] font-medium uppercase tracking-wider ${levelStyles.bg} ${levelStyles.text} ${levelStyles.border}`}
        >
          {task.level}
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusStyles.bg} ${statusStyles.text} ${statusStyles.glow ?? ""}`}
        >
          {task.status.replace("_", " ")}
        </span>
        {priorityStyles && (
          <span
            className={`font-mono text-sm font-bold ${priorityStyles.color}`}
          >
            {priorityStyles.indicator}
          </span>
        )}
      </div>

      {/* Priority Section */}
      <div className="p-4 border-b border-border">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Priority
        </h3>
        {editingField === "priority" ? (
          <div className="space-y-2">
            <select
              value={editValues.priority || ""}
              onChange={(e) => onFieldChange("priority", e.target.value)}
              onKeyDown={(e) => onKeyDown(e, "priority")}
              onBlur={() => onFieldSave("priority")}
              autoFocus
              disabled={isSubmitting}
              className="w-full rounded border border-primary/30 bg-bg-secondary px-2 py-1.5 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
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
            onClick={() => onFieldClick("priority")}
            className="text-sm text-text-secondary cursor-pointer hover:bg-bg-hover p-2 rounded"
          >
            {task.priority || "None"}
          </p>
        )}
      </div>

      {/* Level Section */}
      <div className="p-4 border-b border-border">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Level
        </h3>
        {editingField === "level" ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              {["epic", "ticket", "task"].map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => {
                    onFieldChange("level", level);
                    onFieldSave("level");
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
            onClick={() => onFieldClick("level")}
            className="text-sm text-text-secondary cursor-pointer hover:bg-bg-hover p-2 rounded"
          >
            {task.level.charAt(0).toUpperCase() + task.level.slice(1)}
          </p>
        )}
      </div>

      {/* Basic Info */}
      <div className="p-4">
        <div className="space-y-1 divide-y divide-border-subtle">
          <DetailRow label="ID">
            <code className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs">
              {task.id?.slice(0, 8) ?? "-"}
            </code>
          </DetailRow>
        </div>
      </div>

      {/* Description */}
      <div className="p-4 border-b border-border">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Description
        </h3>
        <InlineEditField
          value={task.description || ""}
          placeholder="Click to add description"
          multiline
          rows={4}
          onSave={async (value) => {
            await onUpdateField("description", value);
          }}
        />
      </div>

      {/* Tags */}
      <div className="p-4 border-b border-border">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Tags
        </h3>
        <InlineEditField
          value={task.tags.join(", ")}
          placeholder="Click to add tags (comma-separated)"
          onSave={async (value) => {
            const tags = value.split(",").map(t => t.trim()).filter(t => t.length > 0);
            await onUpdateField("tags", tags);
          }}
        />
      </div>

      {/* Timestamps */}
      <div className="p-4">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Timeline
        </h3>
        <div className="space-y-1">
          <DetailRow label="Created">
            {formatDateTime(task.created_at)}
          </DetailRow>
          <DetailRow label="Updated">
            {formatDateTime(task.updated_at)}
          </DetailRow>
          {task.started_at && (
            <DetailRow label="Started">
              {formatDateTime(task.started_at)}
            </DetailRow>
          )}
          {task.completed_at && (
            <DetailRow label="Completed">
              {formatDateTime(task.completed_at)}
            </DetailRow>
          )}
        </div>
      </div>

      {/* Human Review Toggle */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Human Review
          </h3>
          <Toggle
            checked={task.needs_human_review ?? false}
            onChange={(checked) => onUpdateField("needs_human_review", checked)}
            label="Toggle human review requirement"
            activeColor="warning"
          />
        </div>
        {task.needs_human_review && (
          <p className="mt-2 text-xs text-warning">This task requires human review before completion</p>
        )}
      </div>

      {/* Revision Feedback */}
      <div className="p-4 border-b border-border">
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Revision Feedback
        </h3>
        <InlineEditField
          value={task.revision_feedback || ""}
          placeholder="Click to add revision feedback"
          multiline
          rows={4}
          onSave={async (value) => {
            await onUpdateField("revision_feedback", value);
          }}
        />
      </div>

      {/* Rejection Reason Banner */}
      {task.rejection_reason && (
        <div className="p-4">
          <div className="rounded-lg border border-error/30 bg-error/10 p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                <svg
                  className="h-5 w-5 text-error"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold text-error">
                  Rejection Reason
                </h4>
                <p className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">
                  {task.rejection_reason}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Section */}
      {showDeleteConfirmation && (
        <DeleteConfirmation
          itemType="Task"
          itemName={task.title}
          isDeleting={isDeleting}
          error={deleteError}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        >
          {taskData.children_ids && taskData.children_ids.length > 0 && (
            <div className="rounded border border-warning/20 bg-warning/5 p-2.5">
              <p className="text-xs text-warning font-medium mb-2">
                This task has {taskData.children_ids.length} child task
                {taskData.children_ids.length !== 1 ? "s" : ""}
              </p>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cascade}
                  onChange={(e) => onCascadeChange(e.target.checked)}
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
                  onChange={(e) => onCascadeChange(!e.target.checked)}
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
      )}
    </div>
  );
}

/**
 * TaskDetailPanel displays comprehensive task information in a side panel.
 * Features neural-pathway-inspired design with glowing accents.
 * Automatically refreshes when task change events are received.
 */
export function TaskDetailPanel({
  taskId,
  onClose,
  onTaskSelect,
}: TaskDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("details");
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
  const { task: taskData, isLoading, error, refetch } = useTask(taskId);

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
      if (!taskData?.task) return;

      const task = taskData.task;
      const fieldMap = {
        title: task.title,
        priority: task.priority || "",
        level: task.level,
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
      if (!taskData?.task.id) return;

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
          title: fieldName === "title" ? editValues.title : taskData.task.title,
          description: taskData.task.description,
          priority: fieldName === "priority" ? (editValues.priority as string | null) : taskData.task.priority,
          add_tags: [],
          remove_tags: [],
          level: fieldName === "level" ? editValues.level : taskData.task.level,
          needs_human_review: taskData.task.needs_human_review,
          revision_feedback: taskData.task.revision_feedback,
        };

        // Call updateTask command
        const result = await commands.updateTask(taskData.task.id, options);

        if (result.status === "error") {
          setFieldError(result.error.message);
        } else {
          setEditingField(null);
          await refetch();
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
      const taskId = taskData?.task.id;
      if (!taskId) return;

      const task = taskData.task;
      
      // Build update options based on the field being updated
      const options: {
        title: string;
        description: string | null;
        priority: string | null;
        add_tags: string[];
        remove_tags: string[];
        level: string;
        needs_human_review: boolean;
        revision_feedback: string | null;
      } = {
        title: task.title,
        description: task.description,
        priority: task.priority,
        add_tags: [],
        remove_tags: [],
        level: task.level,
        needs_human_review: task.needs_human_review ?? false,
        revision_feedback: task.revision_feedback,
      };

      switch (field) {
        case "description":
          options.description = (value as string) || null;
          break;
        case "tags": {
          // For tags, we need to compute the difference
          const newTags = value as string[];
          const currentTags = task.tags;
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

      const result = await commands.updateTask(taskId, options);
      if (result.status === "error") {
        throw new Error(result.error.message);
      }
      await refetch();
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
    if (!taskData?.task.id) return;

    setIsDeleting(true);
    setDeleteError(null);

    try {
      const result = await commands.deleteTask(taskData.task.id, cascade);

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
  }, [taskData?.task.id, cascade, onClose]);

  if (!taskId) {
    return null;
  }

  return (
    <ResizablePanel
      storageKey="task-detail-panel-width"
      glowColor="from-primary/0 via-primary/30 to-primary/0"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-mono text-xs font-medium uppercase tracking-wider text-text-muted">
          Task Details
        </h2>
        <div className="flex items-center gap-2">
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

      {/* Content */}
      {taskData && !isLoading && !error && (
        <>
          {/* Task title */}
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
                {taskData.task.title}
              </h3>
            )}
          </div>

          {/* Tabs */}
          <div className="border-b border-border">
            <nav className="flex" aria-label="Task detail tabs">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${activeTab === tab.id
                    ? "text-primary"
                    : "text-text-muted hover:text-text-secondary"
                    }`}
                  aria-selected={activeTab === tab.id}
                  role="tab"
                >
                  {tab.icon}
                  <span className="hidden sm:inline">{tab.label}</span>
                  {activeTab === tab.id && (
                    <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-primary shadow-glow-sm" />
                  )}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-auto">
            {activeTab === "details" && (
              <TaskDetailsTab
                taskData={taskData}
                editingField={editingField}
                editValues={editValues}
                isSubmitting={isSubmitting}
                fieldError={fieldError}
                onFieldClick={handleFieldClick}
                onFieldChange={handleFieldChange}
                onFieldSave={handleFieldSave}
                onKeyDown={handleKeyDown}
                onUpdateField={onUpdateField}
                showDeleteConfirmation={showDeleteConfirmation}
                deleteError={deleteError}
                isDeleting={isDeleting}
                cascade={cascade}
                onCancelDelete={handleCancelDelete}
                onConfirmDelete={handleConfirmDelete}
                onCascadeChange={setCascade}
              />
            )}
            {activeTab === "sections" && taskData.task.id && (
              <TaskSections
                sections={taskData.task.sections}
                taskId={taskData.task.id}
                onSectionsChanged={refetch}
              />
            )}
            {activeTab === "code_refs" && taskData.task.id && (
              <TaskCodeRefs
                codeRefs={taskData.task.code_refs}
                taskId={taskData.task.id}
                onCodeRefsChanged={refetch}
              />
            )}
            {activeTab === "relations" && taskData.task.id && (
              <TaskRelations
                taskId={taskData.task.id}
                parentId={taskData.parent_id}
                childrenIds={taskData.children_ids}
                dependsOnIds={taskData.depends_on_ids}
                dependentIds={taskData.dependent_ids}
                onTaskSelect={onTaskSelect}
                onRelationshipChange={refetch}
              />
            )}
            {activeTab === "history" && taskData.task.id && (
              <ExecutionHistory taskId={taskData.task.id} />
            )}
          </div>
        </>
      )}
    </ResizablePanel>
  );
}
