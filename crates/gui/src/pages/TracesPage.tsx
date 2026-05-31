import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import type {
  SessionLog,
  StepExecution,
  Task,
  TaskFilterOptions,
  TaskRun,
  Workflow,
} from "../bindings";
import { commands } from "../bindings";
import { resolveHumanInputGate } from "../utils/humanInputGate";
import {
  CorridorView,
  FilterBar,
  FlightStrip,
  ModeToggle,
  RunHistoryRail,
  SubtreeRail,
  TracesHeader,
  TracesPickerRail,
  UnifiedChatView,
  projectTaskRunTrace,
  type TaskPickerHandle,
  type TaskRunTraceProjection,
  type TraceMode,
} from "../components/Traces";
import { IdentityBadge } from "../components/shared/EntityId";
import {
  filterExecutions,
  matchesSearch,
  resolveLineageScope,
  scopedRunIdsForLineage,
} from "../components/Traces/applyFilters";
import {
  summarizeExecutions,
  summarizeProjection,
  summarizeRuns,
  traceDebug,
} from "../components/Traces/traceDebug";
import {
  useTask,
  useTaskRuns,
  useTaskRunsForTasks,
  useTaskRunTrace,
} from "../hooks";
import { useWorkflows } from "../hooks/useWorkflows";
import { useSubtreeExecutions } from "../hooks/useSubtreeExecutions";
import { useSubtreeSessionLogs } from "../hooks/useSubtreeSessionLogs";
import { useTraceFilters } from "../hooks/useTraceFilters";
import { useShellHeader } from "../hooks/useShellHeader";
import { useTaskStore } from "../stores/taskStore";
import type { TaggedConversationEvent } from "../types/conversation";
import { computeExecutionRollups, popOut } from "../utils";
import { isEditableShortcutTarget } from "../utils/keyboard";

interface ModeContentProps {
  mode: TraceMode;
  taskId: string;
  executions: StepExecution[];
  tasks: Task[];
  runProjection: TaskRunTraceProjection | null;
  workflows: readonly Workflow[];
  logsByExecutionId: Record<string, SessionLog[]>;
  isSubtreeLoading: boolean;
  subtreeError: string | null;
  threadScrollRef: RefObject<HTMLDivElement | null>;
  onPinExecution: (id: string) => void;
  search: string;
  autoScroll: boolean;
  focusExecutionId: string | null;
  activeExecutionId: string | null;
  activeRunStoppable: boolean;
  isStoppingActiveRun: boolean;
  onStopActiveRun: () => void;
}

function renderModeContent(props: ModeContentProps): ReactNode {
  const {
    mode,
    taskId,
    executions,
    tasks,
    runProjection,
    workflows,
    logsByExecutionId,
    isSubtreeLoading,
    subtreeError,
    threadScrollRef,
    onPinExecution,
    search,
    autoScroll,
    focusExecutionId,
    activeExecutionId,
    activeRunStoppable,
    isStoppingActiveRun,
    onStopActiveRun,
  } = props;
  traceDebug(`render ${mode}`, {
    mode,
    rootTaskId: taskId,
    executions: summarizeExecutions(executions),
    hasRunProjection: runProjection?.hasRuns === true,
    projection: summarizeProjection(runProjection),
  });
  switch (mode) {
    case "thread":
      return (
        <UnifiedChatView
          rootTaskId={taskId}
          executions={executions}
          tasks={tasks}
          runProjection={runProjection}
          workflows={workflows}
          logsByExecutionId={logsByExecutionId}
          isLoading={isSubtreeLoading}
          error={subtreeError}
          scrollRef={threadScrollRef}
          eventFilter={
            search
              ? (tagged: TaggedConversationEvent) =>
                  matchesSearch(tagged, search)
              : undefined
          }
          autoScroll={autoScroll}
          focusExecutionId={focusExecutionId}
          activeExecutionId={activeExecutionId}
          activeRunStoppable={activeRunStoppable}
          isStoppingActiveRun={isStoppingActiveRun}
          onStopActiveRun={onStopActiveRun}
        />
      );
    case "corridor":
      return (
        <CorridorView
          rootTaskId={taskId}
          executions={executions}
          tasks={tasks}
          runProjection={runProjection}
          threadScrollRef={threadScrollRef}
          onPinExecution={onPinExecution}
        />
      );
  }
}

/** Parse `#exec=<id>` from a hash like "#exec=ab12". */
function parseExecHash(hash: string): string | null {
  if (!hash) return null;
  const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of cleaned.split("&")) {
    const [k, v] = part.split("=");
    if (k === "exec" && v) return decodeURIComponent(v);
  }
  return null;
}

function collectTraceTaskIds(
  rootTaskId: string | null,
  tasks: readonly Task[]
): string[] {
  if (!rootTaskId) return [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map<string | null, string[]>();
  for (const task of tasks) {
    const parentId = task.parent_id ?? null;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(task.id);
    childrenByParent.set(parentId, children);
  }

  const ids: string[] = [];
  const visited = new Set<string>();

  const ancestors: string[] = [];
  let cursor: Task | undefined = tasksById.get(rootTaskId);
  while (cursor) {
    if (visited.has(cursor.id)) break;
    ancestors.push(cursor.id);
    const parentId = cursor.parent_id;
    if (!parentId) break;
    cursor = tasksById.get(parentId);
  }
  for (const taskId of ancestors.reverse()) {
    visited.add(taskId);
    ids.push(taskId);
  }

  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    ids.push(taskId);
    for (const childId of childrenByParent.get(taskId) ?? []) {
      visit(childId);
    }
  };
  if (!visited.has(rootTaskId)) {
    visited.add(rootTaskId);
    ids.push(rootTaskId);
  }
  for (const childId of childrenByParent.get(rootTaskId) ?? []) {
    visit(childId);
  }
  return ids;
}

function mergeRunsNewestFirst(
  primaryRuns: readonly TaskRun[],
  secondaryRuns: readonly TaskRun[]
): TaskRun[] {
  const runsById = new Map<string, TaskRun>();
  for (const run of primaryRuns) runsById.set(run.id, run);
  for (const run of secondaryRuns) {
    if (!runsById.has(run.id)) runsById.set(run.id, run);
  }
  return Array.from(runsById.values()).sort((a, b) => {
    const aTs = a.started_at ?? a.inserted_at ?? "";
    const bTs = b.started_at ?? b.inserted_at ?? "";
    if (aTs !== bTs) return bTs.localeCompare(aTs);
    return b.id.localeCompare(a.id);
  });
}

function taskChildrenFilter(parentId: string): TaskFilterOptions {
  return {
    step_names: null,
    levels: null,
    tags: null,
    root_only: null,
    children_of: parentId,
    search: null,
    workflow_id: null,
    step_id: null,
  };
}

function mergeTasksById(...taskLists: readonly (readonly Task[])[]): Task[] {
  const byId = new Map<string, Task>();
  for (const taskList of taskLists) {
    for (const nextTask of taskList) {
      byId.set(nextTask.id, { ...byId.get(nextTask.id), ...nextTask });
    }
  }
  return Array.from(byId.values());
}

interface TracesPageProps {
  /**
   * If provided, overrides the `:taskId` route param. Used by the
   * standalone pop-out window which routes on `/traces-window/:taskId` and
   * swaps task in-place via `onPickTask`.
   */
  taskIdOverride?: string | null;
  /**
   * Override picker selection. The default (in-app) behaviour navigates to
   * `/traces/:id`; the pop-out passes a local setter so the window URL/label
   * stays stable.
   */
  onPickTask?: (id: string) => void;
  /**
   * When true, suppresses the in-app Detach button (the standalone window
   * is already detached) and the Back button (no history to navigate).
   */
  standalone?: boolean;
}

export function TracesPage({
  taskIdOverride,
  onPickTask,
  standalone,
}: TracesPageProps = {}): ReactNode {
  const { taskId: routeTaskId } = useParams<{ taskId: string }>();
  const taskId = taskIdOverride ?? routeTaskId;
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tasks = useTaskStore((state) => state.tasks);
  const { workflows } = useWorkflows();

  const [mode, setMode] = useState<TraceMode>("thread");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [pinnedExecutionId, setPinnedExecutionId] = useState<string | null>(
    null
  );
  const [autoScroll, setAutoScroll] = useState(false);
  const [activeExecutionId, setActiveExecutionId] = useState<string | null>(
    null
  );
  const [fetchedTraceTasks, setFetchedTraceTasks] = useState<Task[]>([]);
  const [pickerInRail, setPickerInRail] = useState(false);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<TaskPickerHandle | null>(null);
  const traceTaskFetchSeqRef = useRef(0);

  useShellHeader("Traces");

  const safeTaskId = taskId ?? null;
  const {
    task,
    isLoading: isTaskLoading,
    error: taskError,
  } = useTask(safeTaskId);
  const traceTasks = useMemo(
    () => mergeTasksById(tasks, fetchedTraceTasks, task ? [task] : []),
    [tasks, fetchedTraceTasks, task]
  );

  useEffect(() => {
    if (!safeTaskId) {
      setFetchedTraceTasks([]);
      return;
    }

    const seq = ++traceTaskFetchSeqRef.current;
    let cancelled = false;

    const fetchTraceTasks = async (): Promise<void> => {
      const byId = new Map<string, Task>();
      for (const existingTask of tasks) byId.set(existingTask.id, existingTask);
      if (task) byId.set(task.id, task);

      const fetchTaskById = async (id: string): Promise<Task | null> => {
        const existing = byId.get(id);
        if (existing) return existing;
        const result = await commands.getTask(id);
        if (result.status !== "ok") return null;
        byId.set(result.data.id, result.data);
        return result.data;
      };

      let cursor = await fetchTaskById(safeTaskId);
      const seenAncestors = new Set<string>();
      while (cursor?.parent_id && !seenAncestors.has(cursor.parent_id)) {
        seenAncestors.add(cursor.parent_id);
        cursor = await fetchTaskById(cursor.parent_id);
      }

      const seenDescendants = new Set<string>();
      const fetchChildren = async (parentId: string): Promise<void> => {
        if (seenDescendants.has(parentId)) return;
        seenDescendants.add(parentId);
        const result = await commands.listTasks(taskChildrenFilter(parentId));
        if (result.status !== "ok") return;
        for (const child of result.data) byId.set(child.id, child);
        for (const child of result.data) await fetchChildren(child.id);
      };
      await fetchChildren(safeTaskId);

      if (!cancelled && seq === traceTaskFetchSeqRef.current) {
        setFetchedTraceTasks(Array.from(byId.values()));
      }
    };

    void fetchTraceTasks();

    return () => {
      cancelled = true;
    };
  }, [safeTaskId, task, tasks]);

  // URL state for stable trace links. `runId` selects a specific TaskRun for
  // the entry-point task; `rootRunId` pins the trace tree to a recursive root
  // (e.g. for cross-task deep links into a workflow run).
  const selectedRunId = searchParams.get("runId") ?? null;
  const rootRunIdParam = searchParams.get("rootRunId") ?? null;

  const {
    runs,
    resolveRun,
    isLoading: isRunsLoading,
    error: runsError,
  } = useTaskRuns(safeTaskId);
  const railTaskIds = useMemo(
    () => collectTraceTaskIds(safeTaskId, traceTasks),
    [safeTaskId, traceTasks]
  );
  const descendantRailTaskIds = useMemo(
    () => railTaskIds.filter((id) => id !== safeTaskId),
    [railTaskIds, safeTaskId]
  );
  const { runs: descendantRailRuns } = useTaskRunsForTasks(
    descendantRailTaskIds
  );
  const railRuns = useMemo(
    () => mergeRunsNewestFirst(runs, descendantRailRuns),
    [runs, descendantRailRuns]
  );

  // Resolve the run that backs the current trace. `rootRunId` always wins so
  // shared deep links remain stable even when a newer run is active; if it
  // doesn't match a known run, fall back to the user's `runId` selection.
  const resolvedRun = useMemo(() => {
    if (rootRunIdParam) {
      const match = runs.find((r) => r.id === rootRunIdParam);
      if (match) return { run: match, source: "selected" as const };
    }
    if (selectedRunId) {
      const selectedFromRail = railRuns.find((r) => r.id === selectedRunId);
      if (selectedFromRail) {
        return { run: selectedFromRail, source: "selected" as const };
      }
    }
    return resolveRun(selectedRunId);
  }, [rootRunIdParam, runs, railRuns, resolveRun, selectedRunId]);

  // The trace fetch is keyed on the selected TaskRun id. The rail shows the
  // task hierarchy; selecting an attempt should inspect that attempt's logs,
  // not implicitly jump back to the root TaskRun lineage.
  const rootTaskRunId = rootRunIdParam ?? resolvedRun.run?.id ?? null;

  const {
    taskRuns: runTaskRuns,
    executions: runExecutions,
    sessionLogs: runSessionLogs,
    isLoading: isRunTraceLoading,
    error: runTraceError,
  } = useTaskRunTrace(rootTaskRunId);

  // Legacy subtree path. Constraint: retain as fallback for tasks with no
  // TaskRun data so existing trace flows continue to work end-to-end.
  const useLegacySubtree = !rootTaskRunId;
  const {
    executions: legacyExecutions,
    subtreeTaskIds,
    isLoading: isSubtreeLoading,
    error: subtreeError,
  } = useSubtreeExecutions(useLegacySubtree ? safeTaskId : null);

  const executions = useLegacySubtree ? legacyExecutions : runExecutions;

  const selectedTraceRun = useMemo(() => {
    if (!selectedRunId) return null;
    return runTaskRuns.find((run) => run.id === selectedRunId) ?? null;
  }, [runTaskRuns, selectedRunId]);

  const activeTraceRun = selectedTraceRun ?? resolvedRun.run;
  const activeTraceRunSource = selectedTraceRun
    ? "selected"
    : resolvedRun.source;

  useEffect(() => {
    traceDebug("run trace inputs", {
      taskId: safeTaskId,
      selectedRunId,
      rootRunIdParam,
      resolvedRunId: resolvedRun.run?.id ?? null,
      resolvedRunSource: resolvedRun.source,
      resolvedRunRootTaskRunId: resolvedRun.run?.root_task_run_id ?? null,
      rootTaskRunId,
      useLegacySubtree,
    });
  }, [
    rootTaskRunId,
    rootRunIdParam,
    resolvedRun.run?.id,
    resolvedRun.run?.root_task_run_id,
    resolvedRun.source,
    safeTaskId,
    selectedRunId,
    useLegacySubtree,
  ]);

  // Build a map of execution -> session logs keyed by execution id. The
  // run-trace endpoint returns logs as a flat list, so we group them here.
  const runLogsByExecutionId = useMemo<Record<string, SessionLog[]>>(() => {
    if (useLegacySubtree) return {};
    const map: Record<string, SessionLog[]> = {};
    for (const log of runSessionLogs) {
      const execId = log.step_execution_id;
      if (!execId) continue;
      const bucket = map[execId];
      if (bucket) bucket.push(log);
      else map[execId] = [log];
    }
    return map;
  }, [useLegacySubtree, runSessionLogs]);

  const { logsByExecutionId: legacyLogsByExecutionId } = useSubtreeSessionLogs(
    useLegacySubtree ? legacyExecutions : []
  );

  const logsByExecutionId = useLegacySubtree
    ? legacyLogsByExecutionId
    : runLogsByExecutionId;

  const dataLoading = useLegacySubtree ? isSubtreeLoading : isRunTraceLoading;
  const dataError = useLegacySubtree ? subtreeError : runTraceError;

  // Recompute rollups with the fetched logs so the Σ COST fallback (for
  // executions where StepExecution.cost was never persisted) takes effect.
  const rollups = useMemo(
    () => computeExecutionRollups(executions, logsByExecutionId),
    [executions, logsByExecutionId]
  );

  const { filters, setStatus, setStepName, setModel, setSearch, setRootOnly } =
    useTraceFilters();

  const effectiveLineageScope = useMemo(
    () => resolveLineageScope(filters, activeTraceRun),
    [filters, activeTraceRun]
  );

  const scopedRunIds = useMemo(
    () =>
      scopedRunIdsForLineage(
        runTaskRuns,
        activeTraceRun?.id ?? null,
        effectiveLineageScope
      ),
    [runTaskRuns, activeTraceRun?.id, effectiveLineageScope]
  );

  const scopedRunTaskRuns = useMemo(() => {
    if (useLegacySubtree || !scopedRunIds) return runTaskRuns;
    return runTaskRuns.filter((run) => scopedRunIds.has(run.id));
  }, [useLegacySubtree, runTaskRuns, scopedRunIds]);

  useEffect(() => {
    traceDebug("lineage scope", {
      taskId: safeTaskId,
      selectedRunId,
      resolvedRunId: resolvedRun.run?.id ?? null,
      activeTraceRunId: activeTraceRun?.id ?? null,
      rootTaskRunId,
      effectiveLineageScope,
      scopedRunIds: scopedRunIds ? Array.from(scopedRunIds) : null,
      scopedRuns: summarizeRuns(scopedRunTaskRuns),
      fetchedRuns: summarizeRuns(runTaskRuns),
    });
  }, [
    effectiveLineageScope,
    rootTaskRunId,
    runTaskRuns,
    safeTaskId,
    scopedRunIds,
    scopedRunTaskRuns,
    selectedRunId,
    activeTraceRun?.id,
    resolvedRun.run?.id,
  ]);

  const filteredExecutions = useMemo<StepExecution[]>(() => {
    if (!safeTaskId) return [];
    return filterExecutions(executions, filters, {
      rootTaskId: safeTaskId,
      scopedRunIds: useLegacySubtree ? null : scopedRunIds,
    });
  }, [executions, filters, safeTaskId, scopedRunIds, useLegacySubtree]);

  const runProjection = useMemo<TaskRunTraceProjection | null>(() => {
    if (useLegacySubtree || scopedRunTaskRuns.length === 0) return null;
    return projectTaskRunTrace(
      scopedRunTaskRuns,
      filteredExecutions,
      traceTasks
    );
  }, [useLegacySubtree, scopedRunTaskRuns, filteredExecutions, traceTasks]);

  useEffect(() => {
    traceDebug("execution filters", {
      taskId: safeTaskId,
      useLegacySubtree,
      rawExecutions: summarizeExecutions(executions),
      filteredExecutions: summarizeExecutions(filteredExecutions),
      filters,
      scopedRunIds: scopedRunIds ? Array.from(scopedRunIds) : null,
    });
  }, [
    executions,
    filteredExecutions,
    filters,
    safeTaskId,
    scopedRunIds,
    useLegacySubtree,
  ]);

  useEffect(() => {
    traceDebug("projection output", {
      taskId: safeTaskId,
      projection: summarizeProjection(runProjection),
    });
  }, [runProjection, safeTaskId]);

  const humanInputGate = useMemo(() => {
    if (useLegacySubtree) return null;
    const waitingRuns = runTaskRuns.filter((r) => r.status === "waiting");
    if (waitingRuns.length === 0) return null;
    const execsByRunId = new Map<string, StepExecution[]>();
    for (const exec of runExecutions) {
      if (!exec.task_run_id) continue;
      const list = execsByRunId.get(exec.task_run_id);
      if (list) list.push(exec);
      else execsByRunId.set(exec.task_run_id, [exec]);
    }
    for (const run of waitingRuns) {
      const gate = resolveHumanInputGate(run, execsByRunId.get(run.id) ?? []);
      if (gate) return gate;
    }
    return null;
  }, [useLegacySubtree, runTaskRuns, runExecutions]);

  const activeRunStoppable = task?.run_controls?.stoppable === true;
  const [isStoppingActiveRun, setIsStoppingActiveRun] = useState(false);
  const handleStopActiveRun = useCallback(async () => {
    if (!humanInputGate) return;
    setIsStoppingActiveRun(true);
    try {
      await commands.stopRun({
        task_run_id: humanInputGate.run.id,
        task_id: null,
      });
    } finally {
      setIsStoppingActiveRun(false);
    }
  }, [humanInputGate]);

  const focusExecutionId = useMemo(
    () => parseExecHash(location.hash),
    [location.hash]
  );

  // On first mount with a deep-link, prime activeExecutionId so j/k starts
  // from the linked node.
  useEffect(() => {
    if (focusExecutionId && !activeExecutionId) {
      setActiveExecutionId(focusExecutionId);
    }
  }, [focusExecutionId, activeExecutionId]);

  // Keyboard navigation: j/k cycle executions, / focuses search.
  // We compute the navigable list lazily in the handler so it tracks
  // filtered executions without re-binding the listener every render.
  const filteredExecutionsRef = useRef(filteredExecutions);
  useEffect(() => {
    filteredExecutionsRef.current = filteredExecutions;
  }, [filteredExecutions]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const isEditable = isEditableShortcutTarget(e.target);

      if (e.key === "/" && !isEditable) {
        e.preventDefault();
        if (pickerRef.current) {
          pickerRef.current.focus();
        } else {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }
        return;
      }
      if (e.key === "Escape" && !isEditable) {
        setPickerInRail(false);
      }

      if (isEditable) return;
      if (e.key !== "j" && e.key !== "k") return;
      const list = filteredExecutionsRef.current;
      if (list.length === 0) return;
      e.preventDefault();
      setActiveExecutionId((current) => {
        const ids = list.map((x) => x.id).filter((id): id is string => !!id);
        if (ids.length === 0) return current;
        const idx = current ? ids.indexOf(current) : -1;
        if (idx < 0) return ids[0];
        const lastIdx = ids.length - 1;
        const delta = e.key === "j" ? 1 : -1;
        const nextIdx = Math.max(0, Math.min(lastIdx, idx + delta));
        return ids[nextIdx];
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleDetach = useCallback(async () => {
    if (!taskId) return;
    // Skip the localStorage stash: subtree executions + session logs can be
    // large and change live, so a short fetch flash on open is preferable to
    // serializing stale data through localStorage. Diverges from task/chat
    // pop-outs which do stash.
    await popOut(`/traces-window/${taskId}`, `traces-${taskId}`, {
      title: "Traces",
      width: 1100,
      height: 800,
    });
  }, [taskId]);

  const handleToggleRail = useCallback(() => {
    setRailCollapsed((v) => !v);
  }, []);

  const handlePickTask = useCallback(
    (id: string) => {
      setPickerInRail(false);
      if (onPickTask) {
        onPickTask(id);
      } else {
        navigate(`/traces/${id}`);
      }
    },
    [navigate, onPickTask]
  );

  const showPickerRail = !taskId || pickerInRail;
  // Show the run-history rail whenever the task has TaskRun data; fall back
  // to the legacy subtree rail for tasks that never had a durable run.
  const showRunHistoryRail = railRuns.length > 0;

  const handleSelectRun = useCallback(
    (runId: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("runId", runId);
          const selected = railRuns.find((run) => run.id === runId);
          const isRootRun =
            selected &&
            (!selected.parent_task_run_id ||
              !railRuns.some((run) => run.id === selected.parent_task_run_id));
          if (isRootRun) params.set("scope", "lineage");
          else params.delete("scope");
          return params;
        },
        { replace: true }
      );
    },
    [railRuns, setSearchParams]
  );

  const headerError = taskId ? (taskError ?? runsError ?? dataError) : null;
  const headerLoading = taskId
    ? isTaskLoading || isRunsLoading || dataLoading
    : false;
  const taskTitle = task?.title ?? null;
  const taskLevel = task?.level ?? null;

  return (
    <div data-testid="traces-page" className="flex h-full min-h-0 flex-col">
      <TracesHeader
        taskId={taskId ?? null}
        title={taskTitle}
        level={taskLevel}
        rollups={rollups}
        isLoading={headerLoading}
        error={headerError}
        onBack={!standalone && taskId ? handleBack : undefined}
        onDetach={!standalone && taskId ? handleDetach : undefined}
      />

      {taskId && (
        <FilterBar
          ref={searchInputRef}
          filters={filters}
          executions={executions}
          onStatusChange={setStatus}
          onStepNameChange={setStepName}
          onModelChange={setModel}
          onSearchChange={setSearch}
          onRootOnlyChange={setRootOnly}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-row">
        {showPickerRail ? (
          <TracesPickerRail
            tasks={tasks}
            onSelect={handlePickTask}
            pickerRef={pickerRef}
            collapsed={railCollapsed}
            onToggleCollapsed={handleToggleRail}
            onCancel={taskId ? () => setPickerInRail(false) : undefined}
          />
        ) : showRunHistoryRail ? (
          <RunHistoryRail
            runs={railRuns}
            tasks={traceTasks.filter((t) => railTaskIds.includes(t.id))}
            currentTaskId={safeTaskId}
            activeRunId={activeTraceRun?.id ?? null}
            activeRunSource={activeTraceRunSource}
            onSelectTask={handlePickTask}
            onSelectRun={handleSelectRun}
            onSwitchTask={() => setPickerInRail(true)}
            collapsed={railCollapsed}
            onToggleCollapsed={handleToggleRail}
          />
        ) : (
          <SubtreeRail
            rootTaskId={taskId!}
            tasks={traceTasks}
            subtreeTaskIds={subtreeTaskIds}
            executions={filteredExecutions}
            logsByExecutionId={logsByExecutionId}
            collapsed={railCollapsed}
            onToggleCollapsed={handleToggleRail}
            onSwitchTask={() => setPickerInRail(true)}
          />
        )}

        <main
          data-testid="traces-center-pane"
          className="flex min-w-0 flex-1 flex-col gap-3 bg-[var(--color-bg)] p-4"
        >
          {!taskId ? (
            <div
              data-testid="traces-no-task-hint"
              className="flex h-full flex-col justify-center px-8 text-center"
            >
              <div className="mx-auto" style={{ maxWidth: "28rem" }}>
                <h2 className="text-base font-medium text-fg-soft">
                  No task selected
                </h2>
                <p className="mt-2 text-sm text-fg-mute">
                  Search for a task in the panel on the left to view its
                  execution traces. Press{" "}
                  <kbd className="rounded border border-border bg-bg-2 px-1 font-mono text-2xs text-fg-soft">
                    /
                  </kbd>{" "}
                  to focus the search field.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-2">
                <ModeToggle mode={mode} onChange={setMode} />
                <div className="flex items-center gap-3">
                  {showRunHistoryRail && activeTraceRun && (
                    <span
                      data-testid="traces-active-run"
                      data-run-id={activeTraceRun.id}
                      data-run-source={activeTraceRunSource}
                      className="flex items-center gap-1 font-mono text-2xs uppercase tracking-wider text-fg-mute"
                    >
                      <span>{activeTraceRunSource} run</span>
                      <IdentityBadge
                        id={activeTraceRun.id}
                        kind="task run"
                        className="px-1 text-fg-soft"
                        testId="traces-active-run-id"
                      />
                    </span>
                  )}
                  {mode === "thread" && (
                    <label
                      data-testid="traces-auto-scroll-label"
                      className="flex cursor-pointer items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-bg-2)] px-2 py-1 text-2xs text-fg-soft"
                    >
                      <input
                        data-testid="traces-auto-scroll"
                        type="checkbox"
                        checked={autoScroll}
                        onChange={(e) => setAutoScroll(e.target.checked)}
                        className="h-3 w-3"
                      />
                      Auto-scroll
                    </label>
                  )}
                </div>
              </div>
              {mode === "thread" && filteredExecutions.length > 0 && (
                <FlightStrip
                  rootTaskId={taskId}
                  executions={filteredExecutions}
                  tasks={traceTasks}
                  runProjection={runProjection}
                  logsByExecutionId={logsByExecutionId}
                  threadScrollRef={threadScrollRef}
                />
              )}
              <div className="flex min-h-0 flex-1 flex-row gap-3">
                <div
                  data-testid="traces-event-stream-frame"
                  className="min-w-0 flex-1 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)]"
                >
                  {renderModeContent({
                    mode,
                    taskId,
                    executions: filteredExecutions,
                    tasks: traceTasks,
                    runProjection,
                    workflows,
                    logsByExecutionId,
                    isSubtreeLoading: dataLoading,
                    subtreeError: dataError,
                    threadScrollRef,
                    onPinExecution: setPinnedExecutionId,
                    search: filters.search,
                    autoScroll,
                    focusExecutionId,
                    activeExecutionId,
                    activeRunStoppable,
                    isStoppingActiveRun,
                    onStopActiveRun: handleStopActiveRun,
                  })}
                </div>
                {mode === "corridor" && pinnedExecutionId && (
                  <aside
                    data-testid="corridor-detail-pin"
                    data-execution-id={pinnedExecutionId}
                    className="w-[300px] shrink-0 overflow-auto rounded border border-border bg-bg-2 p-3 text-xs"
                  >
                    <div className="mb-2 font-mono text-2xs uppercase tracking-wider text-fg-mute">
                      Pinned execution
                    </div>
                    <div className="break-all font-mono text-fg">
                      {pinnedExecutionId}
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
