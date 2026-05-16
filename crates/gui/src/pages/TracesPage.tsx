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
} from "../components/Traces/applyFilters";
import { useTask, useTaskRuns, useTaskRunTrace } from "../hooks";
import { useWorkflows } from "../hooks/useWorkflows";
import { useSubtreeExecutions } from "../hooks/useSubtreeExecutions";
import { useSubtreeSessionLogs } from "../hooks/useSubtreeSessionLogs";
import { useTraceFilters } from "../hooks/useTraceFilters";
import { useTaskStore } from "../stores/taskStore";
import type { TaggedConversationEvent } from "../types/conversation";
import { computeExecutionRollups, popOut } from "../utils";

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
              ? (tagged: TaggedConversationEvent) => matchesSearch(tagged, search)
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
  const [pickerInRail, setPickerInRail] = useState(false);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<TaskPickerHandle | null>(null);

  const safeTaskId = taskId ?? null;
  const { task, isLoading: isTaskLoading, error: taskError } = useTask(safeTaskId);

  // URL state for stable trace links. `runId` selects a specific TaskRun for
  // the entry-point task; `rootRunId` pins the trace tree to a recursive root
  // (e.g. for cross-task deep links into a workflow run).
  const selectedRunId = searchParams.get("runId") ?? null;
  const rootRunIdParam = searchParams.get("rootRunId") ?? null;

  const setSelectedRunId = useCallback(
    (next: string | null) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next) params.set("runId", next);
          else params.delete("runId");
          return params;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const {
    runs,
    resolveRun,
    isLoading: isRunsLoading,
    error: runsError,
  } = useTaskRuns(safeTaskId);

  // Resolve the run that backs the current trace. `rootRunId` always wins so
  // shared deep links remain stable even when a newer run is active; if it
  // doesn't match a known run, fall back to the user's `runId` selection.
  const resolvedRun = useMemo(() => {
    if (rootRunIdParam) {
      const match = runs.find((r) => r.id === rootRunIdParam);
      if (match) return { run: match, source: "selected" as const };
    }
    return resolveRun(selectedRunId);
  }, [rootRunIdParam, runs, resolveRun, selectedRunId]);

  // The trace fetch is keyed on the root TaskRun id. When the resolved run
  // already has a `root_task_run_id` (child workflow runs), prefer that so
  // the recursive trace tree shows the full lineage.
  const rootTaskRunId =
    rootRunIdParam ??
    resolvedRun.run?.root_task_run_id ??
    resolvedRun.run?.id ??
    null;

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

  const { logsByExecutionId: legacyLogsByExecutionId } =
    useSubtreeSessionLogs(useLegacySubtree ? legacyExecutions : []);

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

  const filteredExecutions = useMemo<StepExecution[]>(() => {
    if (!safeTaskId) return [];
    return filterExecutions(executions, filters, { rootTaskId: safeTaskId });
  }, [executions, filters, safeTaskId]);

  const runProjection = useMemo<TaskRunTraceProjection | null>(() => {
    if (useLegacySubtree || runTaskRuns.length === 0) return null;
    return projectTaskRunTrace(runTaskRuns, filteredExecutions, tasks);
  }, [useLegacySubtree, runTaskRuns, filteredExecutions, tasks]);

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
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable === true;

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
        const ids = list
          .map((x) => x.id)
          .filter((id): id is string => !!id);
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

  const handleSelectRun = useCallback(
    (runId: string) => {
      setSelectedRunId(runId);
    },
    [setSelectedRunId]
  );

  const showPickerRail = !taskId || pickerInRail;
  // Show the run-history rail whenever the task has TaskRun data; fall back
  // to the legacy subtree rail for tasks that never had a durable run.
  const showRunHistoryRail = runs.length > 0;
  const headerError = taskId
    ? (taskError ?? runsError ?? dataError)
    : null;
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
            runs={runs}
            activeRunId={resolvedRun.run?.id ?? null}
            activeRunSource={resolvedRun.source}
            onSelectRun={handleSelectRun}
            onSwitchTask={() => setPickerInRail(true)}
            collapsed={railCollapsed}
            onToggleCollapsed={handleToggleRail}
          />
        ) : (
          <SubtreeRail
            rootTaskId={taskId!}
            tasks={tasks}
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
          className="flex min-w-0 flex-1 flex-col gap-3 p-4"
        >
          {!taskId ? (
            <div
              data-testid="traces-no-task-hint"
              className="flex h-full flex-col justify-center px-8 text-center"
            >
              <div className="mx-auto" style={{ maxWidth: "28rem" }}>
                <h2 className="text-base font-medium text-text-secondary">
                  No task selected
                </h2>
                <p className="mt-2 text-sm text-text-muted">
                  Search for a task in the panel on the left to view its
                  execution traces. Press{" "}
                  <kbd className="rounded border border-border bg-bg-tertiary px-1 font-mono text-[10px] text-text-secondary">
                    /
                  </kbd>{" "}
                  to focus the search field.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <ModeToggle mode={mode} onChange={setMode} />
                <div className="flex items-center gap-3">
                  {showRunHistoryRail && resolvedRun.run && (
                    <span
                      data-testid="traces-active-run"
                      data-run-id={resolvedRun.run.id}
                      data-run-source={resolvedRun.source}
                      className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-text-muted"
                    >
                      <span>{resolvedRun.source} run</span>
                      <IdentityBadge
                        id={resolvedRun.run.id}
                        kind="task run"
                        className="px-1 text-text-secondary"
                        testId="traces-active-run-id"
                      />
                    </span>
                  )}
                  {mode === "thread" && (
                    <label
                      data-testid="traces-auto-scroll-label"
                      className="flex cursor-pointer items-center gap-1 text-[10px] text-text-secondary"
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
                  tasks={tasks}
                  runProjection={runProjection}
                  logsByExecutionId={logsByExecutionId}
                  threadScrollRef={threadScrollRef}
                />
              )}
              <div className="flex min-h-0 flex-1 flex-row gap-3">
                <div className="min-w-0 flex-1">
                  {renderModeContent({
                    mode,
                    taskId,
                    executions: filteredExecutions,
                    tasks,
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
                    className="w-[300px] shrink-0 overflow-auto rounded border border-border bg-bg-tertiary p-3 text-xs"
                  >
                    <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                      Pinned execution
                    </div>
                    <div className="break-all font-mono text-text-primary">
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
