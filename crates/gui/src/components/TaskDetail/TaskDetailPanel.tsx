import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Task, TaskChangedEvent } from "../../bindings";
import { commands, events } from "../../bindings";
import { useTask } from "../../hooks/useTask";
import { useTaskExecutions } from "../../hooks/useTaskExecutions";
import { useDeleteTask } from "../../hooks/useDeleteTask";
import { useTaskStore } from "../../stores";
import { DeleteConfirmation } from "../DeleteConfirmation";
import { Spinner } from "../Spinner";
import { InlineEditField } from "./InlineEditField";
import { AcceptanceCriteria } from "./AcceptanceCriteria";
import { DependenciesSummary } from "./DependenciesSummary";
import { CodeRefsSummary } from "./CodeRefsSummary";
import { SpecSection } from "./SpecSection";
import { TracesExplorerButton } from "./TracesExplorerButton";
import {
  deriveRunControlsState,
  deriveHearthStateBreakdown,
  hasHearthStateBreakdown,
  hearthBreakdownVariantForTask,
  runStatusLabel,
} from "../../utils/runState";
import { formatStepName } from "../../utils/formatStepName";
import { getPriorityIndicator } from "../../utils/taskPriority";
import { resolveHumanInputGate } from "../../utils/humanInputGate";
import { HumanInputGate } from "../Traces/HumanInputGate";
import { IdentityBadge } from "../shared/EntityId";
import { Text } from "../atoms/Text";
import { FloatingDetailPanel, PanelHeader, ReviewGateBanner } from "../panels";
import { SectionGroup } from "../molecules/SectionGroup";
import { SegmentedControl } from "../molecules/SegmentedControl";
import { StatusBadge } from "../molecules/StatusBadge";
import {
  HeroStatus,
  IdChip,
  StateBreakdown,
  StepDot,
} from "../shared/HearthPrimitives";

/** Canonical uppercase mono eyebrow used for every collapsible section header.
 * Muted (not accent), matching the reference `.acc-hd .name` (var(--fg-mute)) —
 * the same tone as the in-section subtitles' parent step. */
function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      variant="eyebrow"
      color="tertiary"
      style={{ fontSize: "var(--text-2xs)" }}
    >
      {children}
    </Text>
  );
}

/** Debounce delay in milliseconds for batching rapid events */
const DEBOUNCE_MS = 100;

/** Temporarily hide the pop-out/detach control on side panels. Flip back to
 * `true` to restore the Detach button (the onDetach plumbing is left intact). */
const DETACH_ENABLED = false;

interface TaskDetailPanelProps {
  taskId: string | null;
  onClose?: () => void;
  onTaskSelect?: (taskId: string) => void;
  onBack?: () => void;
  /** When omitted, the Detach button is hidden (e.g. inside the pop-out itself). */
  onDetach?: () => void;
  /** Skip the ResizablePanel wrapper and fill the area — used by the pop-out window. */
  standalone?: boolean;
  /** Drilling out on close — applies the exit animation and drops focus. The
   *  parent (TasksPage) keeps the panel mounted through this window. */
  closing?: boolean;
  /** Fires when the float's exit animation ends, so the parent can unmount. */
  onExitAnimationEnd?: (event: { target: EventTarget; currentTarget: EventTarget }) => void;
}

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

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
        {label}
      </span>
      <span className="font-mono text-xs text-[var(--color-fg)]">
        {children}
      </span>
    </div>
  );
}

/**
 * Header action button. Icon-only, 28×28, with the Hearth hover affordance
 * (docs/design components-lib.css `.icon-btn`): transparent at rest, and on
 * hover a rounded box appears — a faint border plus a `bg-1` fill.
 */
function IconButton({
  onClick,
  ariaLabel,
  title,
  testId,
  disabled = false,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  title?: string;
  testId?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      data-testid={testId}
      disabled={disabled}
      className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-transparent text-[var(--color-fg-mute)] transition-all hover:border-[var(--color-fg-faint)] hover:bg-[var(--color-bg-1)] hover:text-[var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-[var(--color-fg-mute)]"
    >
      {children}
    </button>
  );
}

/** Filled play triangle for the Run action (matches the reference run glyph). */
function PlayIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

/** Filled square for the Stop action (matches the reference stop glyph). */
function StopIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
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
  closing = false,
  onExitAnimationEnd,
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

  const [fetchedLevels, setFetchedLevels] = useState<
    Record<string, Task["level"]>
  >({});
  // Titles for related tasks (e.g. the parent) fetched alongside their levels
  // when they aren't already in the store — backs the header "under <parent>"
  // crumb.
  const [fetchedTitles, setFetchedTitles] = useState<Record<string, string>>(
    {}
  );
  const taskLevelById = useMemo(() => {
    const map = new Map<string, Task["level"]>();
    for (const t of allTasks) map.set(t.id, t.level);
    for (const [id, level] of Object.entries(fetchedLevels)) {
      if (!map.has(id)) map.set(id, level);
    }
    return map;
  }, [allTasks, fetchedLevels]);
  const getTaskLevel = useCallback(
    (id: string) => taskLevelById.get(id) ?? null,
    [taskLevelById]
  );

  // Parent title for the header "under <parent>" crumb. Prefer the store, fall
  // back to the title fetched alongside relation levels above.
  const parentTitle = useMemo(() => {
    const pid = taskData?.parent_id;
    if (!pid) return null;
    return (
      allTasks.find((t) => t.id === pid)?.title ?? fetchedTitles[pid] ?? null
    );
  }, [taskData?.parent_id, allTasks, fetchedTitles]);

  useEffect(() => {
    if (!taskData) return;
    const relationIds = [
      ...(taskData.parent_id ? [taskData.parent_id] : []),
      ...(taskData.dependency_ids ?? []),
      ...dependentIds,
    ];
    const missing = relationIds.filter(
      (id) => !taskLevelById.has(id) && !(id in fetchedLevels)
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map(async (id) => {
        const result = await commands.getTask(id);
        return result.status === "ok"
          ? ([id, result.data.level, result.data.title] as const)
          : null;
      })
    ).then((entries) => {
      if (cancelled) return;
      const levelUpdates: Record<string, Task["level"]> = {};
      const titleUpdates: Record<string, string> = {};
      for (const entry of entries) {
        if (!entry) continue;
        levelUpdates[entry[0]] = entry[1];
        titleUpdates[entry[0]] = entry[2];
      }
      if (Object.keys(levelUpdates).length > 0) {
        setFetchedLevels((prev) => ({ ...prev, ...levelUpdates }));
        setFetchedTitles((prev) => ({ ...prev, ...titleUpdates }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [taskData, dependentIds, taskLevelById, fetchedLevels]);

  const acceptanceCriteria = useMemo(
    () =>
      (taskData?.sections ?? []).filter((s) => s.type === "testing_criterion"),
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

  const pendingRefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  const handleTaskChanged = useCallback(
    (event: { payload: TaskChangedEvent }) => {
      const { task_id, change_type } = event.payload;

      if (task_id !== taskId) {
        return;
      }

      console.debug(
        `[TaskDetailPanel] Received ${change_type} event for task ${task_id.slice(0, 6)}`
      );

      if (change_type === "Deleted") {
        refetchRef.current();
        return;
      }

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

  useEffect(() => {
    if (!taskId) {
      return;
    }

    const unlistenPromise = events.taskChangedEvent.listen(handleTaskChanged);

    return () => {
      unlistenPromise.then((unlisten) => unlisten());

      if (pendingRefetch.current) {
        clearTimeout(pendingRefetch.current);
      }
    };
  }, [taskId, handleTaskChanged]);

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
        if (fieldName === "title" && !editValues.title.trim()) {
          setFieldError("Title cannot be empty");
          setIsSubmitting(false);
          return;
        }

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
          archived: null as boolean | null,
          worktree: null as string | null,
        };

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

  const onUpdateField = useCallback(
    async (field: string, value: string | boolean | string[]) => {
      if (!taskData?.id) return;

      const options: {
        title: string;
        description: string | null;
        priority: string | null;
        add_tags: string[];
        remove_tags: string[];
        level: string | null;
        archived: boolean | null;
        worktree: string | null;
      } = {
        title: taskData.title,
        description: taskData.description,
        priority: taskData.priority,
        add_tags: [],
        remove_tags: [],
        level: taskData.level,
        archived: null,
        worktree: null,
      };

      switch (field) {
        case "description":
          options.description = (value as string) || null;
          break;
        case "tags": {
          const newTags = value as string[];
          const currentTags = taskData.tags ?? [];
          options.add_tags = newTags.filter((t) => !currentTags.includes(t));
          options.remove_tags = currentTags.filter((t) => !newTags.includes(t));
          break;
        }
      }

      const result = await commands.updateTask(taskData.id, options);
      if (result.status === "error") {
        throw new Error(result.error.message);
      }
      refetch();
    },
    [taskData, refetch]
  );

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

  const priorityIndicator = taskData
    ? getPriorityIndicator(taskData.priority)
    : null;
  const runControlsState = deriveRunControlsState(
    taskData?.run_controls ?? null,
    { hasWorkflow: Boolean(taskData?.workflow_id) }
  );
  const heroStatus = activeRun?.status ?? null;
  const heroLabel = heroStatus ? runStatusLabel(heroStatus) : "No active run";
  const childBreakdown = deriveHearthStateBreakdown(children);
  const hasChildBreakdown = hasHearthStateBreakdown(childBreakdown);
  const runWorkflowDisabled = isRunningWorkflow || runControlsState.runDisabled;
  const shouldShowStopWorkflow = runControlsState.showStop;
  const stopWorkflowDisabled =
    isStoppingWorkflow || runControlsState.stopDisabled;
  const isPendingReview = taskData?.step_name === "pending_review";

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
          <div className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-3)] p-2.5">
            <p className="mb-2 text-xs font-medium text-[var(--color-warn)]">
              This task has {childrenIds.length} child task
              {childrenIds.length !== 1 ? "s" : ""}
            </p>
            <SegmentedControl
              ariaLabel="What happens to child tasks"
              options={[
                { value: "delete", label: "Delete all child tasks" },
                { value: "keep", label: "Keep child tasks without parent" },
              ]}
              value={cascade ? "delete" : "keep"}
              onChange={(value) => setCascade(value === "delete")}
              disabled={isDeleting}
            />
          </div>
        )}
      </DeleteConfirmation>
    ) : null;

  const headerControls = taskData ? (
    <>
      {taskData.workflow_id && !runControlsState.hasActiveRun && (
        <IconButton
          testId="task-detail-run-button"
          onClick={handleRunWorkflow}
          disabled={runWorkflowDisabled}
          ariaLabel="Run entire workflow"
          title="Run the entire workflow for this task"
        >
          {isRunningWorkflow ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <PlayIcon />
          )}
          <span className="sr-only">
            {isRunningWorkflow ? "Running..." : "Run Workflow"}
          </span>
        </IconButton>
      )}
      {shouldShowStopWorkflow && (
        <IconButton
          testId="task-detail-stop-button"
          onClick={handleStopWorkflow}
          disabled={stopWorkflowDisabled}
          ariaLabel="Stop running workflow"
          title={
            runControlsState.isStopping
              ? "Cancel the in-flight stop request"
              : "Stop the running orchestrator for this task"
          }
        >
          {isStoppingWorkflow ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <StopIcon />
          )}
          <span className="sr-only">
            {isStoppingWorkflow
              ? "Stopping..."
              : runControlsState.isStopping
                ? "Cancel orchestration"
                : "Stop"}
          </span>
        </IconButton>
      )}
      <IconButton
        onClick={openDeleteDialog}
        ariaLabel="Delete task"
        title="Delete this task"
        testId="task-detail-delete-button"
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
            d="M19 7l-.867 12.142A1 1 0 0116.138 21H7.862a1 1 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </svg>
      </IconButton>
      {onClose && <span className="t-action-sep" aria-hidden="true" />}
      {DETACH_ENABLED && onDetach && (
        <IconButton
          onClick={onDetach}
          ariaLabel="Detach into pop-out window"
          title="Open in a new window"
          testId="detach-button"
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
        </IconButton>
      )}
      {onClose && (
        <IconButton onClick={onClose} ariaLabel="Close panel">
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
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </IconButton>
      )}
    </>
  ) : null;

  const headerTitle = taskData ? (
    editingField === "title" ? (
      <div className="space-y-2">
        <input
          type="text"
          value={editValues.title}
          onChange={(e) => handleFieldChange("title", e.target.value)}
          onKeyDown={(e) => handleKeyDown(e, "title")}
          onBlur={() => handleFieldSave("title")}
          autoFocus
          disabled={isSubmitting}
          className="w-full rounded-[var(--radius-md)] border border-[var(--color-accent)] bg-[var(--color-bg-1)] px-2 py-1.5 font-serif text-lg leading-snug text-[var(--color-fg)] placeholder-[var(--color-fg-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
          placeholder="Enter title"
        />
        {fieldError && (
          <p className="font-sans text-xs text-[var(--color-err)]">
            {fieldError}
          </p>
        )}
      </div>
    ) : (
      <h3
        onClick={() => handleFieldClick("title")}
        className="cursor-pointer rounded-[var(--radius-sm)] font-serif text-lg leading-snug text-[var(--color-fg)] hover:bg-[var(--color-bg-1)]"
      >
        {taskData.title}
      </h3>
    )
  ) : (
    <span className="font-mono text-xs uppercase tracking-wider text-[var(--color-fg-mute)]">
      Task Details
    </span>
  );

  const headerMetadata = taskData ? (
    <>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Go back"
          className="cursor-pointer rounded-[var(--radius-sm)] p-1 text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
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
      <IdChip
        id={taskData.id}
        kind="task"
        level={taskData.level}
        testId="task-detail-id"
      />
      {/* Crumb line, per docs/design tasks-v2 detail header (`.dh-crumb`):
          "<id> · <level> · under <parent>". The run/step status lives in the
          hero below, so it isn't repeated here. */}
      <span
        aria-hidden
        className="font-mono text-2xs text-[var(--color-fg-faint)]"
      >
        ·
      </span>
      <span
        data-testid="task-detail-level"
        className="font-mono text-2xs text-[var(--color-fg-faint)]"
      >
        {taskData.level}
      </span>
      {taskData.parent_id && parentTitle && (
        <>
          <span
            aria-hidden
            className="font-mono text-2xs text-[var(--color-fg-faint)]"
          >
            ·
          </span>
          <span className="font-mono text-2xs text-[var(--color-fg-faint)]">
            under{" "}
            <button
              type="button"
              data-testid="task-detail-parent-link"
              onClick={() =>
                taskData.parent_id && onTaskSelect?.(taskData.parent_id)
              }
              className="cursor-pointer font-serif text-xs italic text-[var(--color-fg-mute)] transition-colors hover:text-[var(--color-fg)]"
            >
              {parentTitle}
            </button>
          </span>
        </>
      )}
      {priorityIndicator && (
        <span
          className={`font-mono text-xs font-bold ${priorityIndicator.color}`}
          aria-label={priorityIndicator.label}
        >
          {priorityIndicator.glyph}
        </span>
      )}
    </>
  ) : null;

  const content = (
    <div className="tasks-v2-detail-shell">
      {/* Header block: title + crumb + hero status read as one accent-tinted
          band with a gradient accent line at the bottom, per docs/design
          tasks-v2.html `.t-detail-head` (the hero lives inside the head). */}
      <div className="t-detail-head">
        <PanelHeader
          title={headerTitle}
          metadata={headerMetadata}
          controls={headerControls}
          className="t-detail-head-bar"
        />

        {taskData && !isLoading && !error && (
          <div
            className="t-detail-hero"
            data-testid="task-detail-hero"
            data-hero-state={heroStatus ?? "idle"}
          >
            <HeroStatus
              status={heroStatus}
              label={
                heroStatus ? (
                  heroLabel
                ) : (
                  <span data-testid="task-detail-hero-idle-label">
                    No active run
                  </span>
                )
              }
              step={{
                kind: null,
                label: formatStepName(taskData.step_name, "Unassigned"),
              }}
              finished={
                taskData.completed_at
                  ? `completed ${formatDateTime(taskData.completed_at)}`
                  : undefined
              }
              right={
                children.length > 0 ? (
                  <span className="font-mono text-2xs text-[var(--color-fg-faint)]">
                    {children.length} child{children.length === 1 ? "" : "ren"}
                  </span>
                ) : null
              }
            >
              {hasChildBreakdown && (
                <div className="mt-2">
                  <StateBreakdown {...childBreakdown} />
                </div>
              )}
              {children.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {children.slice(0, 18).map((childTask) => (
                    <span key={childTask.id} title={childTask.title}>
                      <StepDot
                        variant={hearthBreakdownVariantForTask(childTask)}
                      />
                    </span>
                  ))}
                </div>
              )}
            </HeroStatus>
          </div>
        )}
      </div>

      {deleteConfirmation}

      {workflowError && (
        <div
          className="mx-4 mt-2 rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-err)_30%,transparent)] bg-[var(--color-err-wash)] px-3 py-2 text-xs text-[var(--color-err)]"
          role="alert"
        >
          {workflowError}
        </div>
      )}

      {isLoading && (
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Spinner className="h-8 w-8" />
            <p className="text-xs text-[var(--color-fg-mute)]">
              Loading task...
            </p>
          </div>
        </div>
      )}

      {error && !isLoading && (
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="text-center">
            <svg
              className="mx-auto mb-3 h-10 w-10 text-[var(--color-err)]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="mb-2 text-sm font-medium text-[var(--color-fg)]">
              Failed to load task
            </p>
            <p className="rounded-[var(--radius-md)] border border-[color-mix(in_oklch,var(--color-err)_30%,transparent)] bg-[var(--color-err-wash)] px-3 py-2 font-mono text-xs text-[var(--color-err)]">
              {error}
            </p>
          </div>
        </div>
      )}

      {taskData && !isLoading && !error && (
        <div className="t-detail-body flex-1 overflow-auto">
          {isPendingReview && (
            <ReviewGateBanner
              title={`"${taskData.title}" is waiting on your review`}
              description="Accept to advance the workflow, or reject with feedback to send it back for revision."
              acceptLabel="Accept"
              rejectLabel="Reject"
            />
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

          <SectionGroup
            className="accordion"
            label={<SectionLabel>Spec</SectionLabel>}
            defaultOpen
            testId="spec-section-wrapper"
            ariaLabel="Toggle Spec section"
          >
            <SpecSection
              description={taskData.description}
              sections={taskData.sections ?? []}
              onDescriptionChange={async (value) => {
                await onUpdateField("description", value);
              }}
            />
          </SectionGroup>

          <SectionGroup
            className="accordion"
            label={<SectionLabel>Test Criteria</SectionLabel>}
            defaultOpen={acceptanceCriteria.length > 0}
            testId="criteria-section"
            ariaLabel="Toggle Test Criteria section"
            count={acceptanceCriteria.length}
          >
            <AcceptanceCriteria
              criteria={acceptanceCriteria}
              taskId={taskData.id}
              onSectionsChanged={refetch}
            />
          </SectionGroup>

          <SectionGroup
            className="accordion"
            label={<SectionLabel>Children</SectionLabel>}
            defaultOpen={children.length > 0}
            testId="children-section"
            ariaLabel="Toggle Children section"
            count={children.length}
          >
            {children.length === 0 ? (
              <p className="py-2 text-xs italic text-[var(--color-fg-mute)]">
                No child tasks
              </p>
            ) : (
              <div className="space-y-1 py-2">
                {children.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => onTaskSelect?.(child.id)}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-bg-2)]"
                    data-testid={`child-task-${child.id}`}
                  >
                    <IdentityBadge
                      id={child.id}
                      kind="task"
                      level={child.level}
                      copyable={false}
                      testId={`child-task-id-${child.id}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-fg-soft)]">
                      {child.title}
                    </span>
                    {(child.workflow_name || child.step_name) && (
                      <span className="flex-shrink-0">
                        <StatusBadge
                          state={{
                            kind: "workflow",
                            workflow: child.workflow_name ?? "",
                            step: child.step_name ?? "",
                          }}
                        />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </SectionGroup>

          <SectionGroup
            className="accordion"
            label={<SectionLabel>Dependencies</SectionLabel>}
            testId="dependencies-section"
            ariaLabel="Toggle Dependencies section"
            count={
              (taskData.dependency_ids?.length ?? 0) +
              dependentIds.length +
              (taskData.parent_id ? 1 : 0)
            }
          >
            <DependenciesSummary
              parentId={taskData.parent_id}
              dependsOnIds={taskData.dependency_ids ?? []}
              dependentIds={dependentIds}
              onTaskSelect={onTaskSelect}
              getTaskLevel={getTaskLevel}
            />
          </SectionGroup>

          <SectionGroup
            className="accordion"
            label={<SectionLabel>Code</SectionLabel>}
            testId="code-section"
            ariaLabel="Toggle Code section"
            count={taskData.code_refs?.length ?? 0}
          >
            <CodeRefsSummary codeRefs={taskData.code_refs ?? []} />
          </SectionGroup>

          <SectionGroup
            className="accordion"
            label={<SectionLabel>Details</SectionLabel>}
            testId="details-section"
            ariaLabel="Toggle Details section"
          >
            <div className="divide-y divide-[var(--color-line)] py-2">
              <div className="py-3">
                <h4 className="mb-1 font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
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
                      className="w-full rounded-[var(--radius-md)] border border-[var(--color-accent)] bg-[var(--color-bg-1)] px-2 py-1.5 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">None</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                    {fieldError && (
                      <p className="text-xs text-[var(--color-err)]">
                        {fieldError}
                      </p>
                    )}
                  </div>
                ) : (
                  <p
                    onClick={() => handleFieldClick("priority")}
                    className="cursor-pointer rounded-[var(--radius-sm)] p-2 text-sm text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-2)]"
                  >
                    {taskData.priority || "None"}
                  </p>
                )}
              </div>

              <div className="py-3">
                <h4 className="mb-1 font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
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
                          className={`flex-1 cursor-pointer rounded-[var(--radius-md)] px-3 py-1.5 text-sm font-medium transition-colors ${editValues.level === level
                              ? "bg-[var(--color-accent)] text-[var(--color-bg)]"
                              : "border border-[var(--color-line-strong)] bg-[var(--color-bg-1)] text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-2)]"
                            } disabled:cursor-not-allowed disabled:opacity-50`}
                        >
                          {level.charAt(0).toUpperCase() + level.slice(1)}
                        </button>
                      ))}
                    </div>
                    {fieldError && (
                      <p className="text-xs text-[var(--color-err)]">
                        {fieldError}
                      </p>
                    )}
                  </div>
                ) : (
                  <p
                    onClick={() => handleFieldClick("level")}
                    className="cursor-pointer rounded-[var(--radius-sm)] p-2 text-sm text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-2)]"
                  >
                    {taskData.level
                      ? taskData.level.charAt(0).toUpperCase() +
                      taskData.level.slice(1)
                      : "Unknown"}
                  </p>
                )}
              </div>

              <div className="py-3">
                <h4 className="mb-1 font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
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

              <div className="py-3">
                <h4 className="mb-1 font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
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

              {taskData.worktree && (
                <div className="py-3">
                  <h4 className="mb-1 font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
                    Worktree
                  </h4>
                  <p className="break-all font-mono text-xs text-[var(--color-fg-soft)]">
                    {taskData.worktree}
                  </p>
                </div>
              )}
            </div>
          </SectionGroup>

          <TracesExplorerButton taskId={taskData.id} standalone={standalone} />
        </div>
      )}
    </div>
  );

  // Floating glass overlay (mirrors the chat / Design inspector), per
  // docs/design/tasks-v2.html `.detail`. The shared FloatingDetailPanel owns the
  // surface, drag/keyboard resize, focus model, and the standalone pop-out
  // variant; `tasks-v2` scopes the inner content's typography and section styles.
  return (
    <FloatingDetailPanel
      panelId="task-detail"
      widthStorageKey="task-detail-panel-width"
      standalone={standalone}
      closing={closing}
      onExitAnimationEnd={onExitAnimationEnd}
      onClose={onClose}
      isOpen={!standalone && taskId != null && !closing}
      shouldHandleEscape={() => editingField === null && onClose != null}
      className="tasks-v2"
      testId="task-detail-panel"
      standaloneTestId="task-detail-panel-standalone"
    >
      {content}
    </FloatingDetailPanel>
  );
}
