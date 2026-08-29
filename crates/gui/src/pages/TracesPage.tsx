import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import type { Task, TaskFilterOptions } from "../bindings";
import { commands } from "../bindings";
import { resolveHumanInputGate } from "../utils/humanInputGate";
import {
  FilterBar,
  FlightStrip,
  RunHistoryRail,
  TracesHeader,
  TracesPickerRail,
  UnifiedChatView,
  filterExecutions,
  type TaskPickerHandle,
} from "../components/Traces";
import { IdentityBadge } from "../components/shared/EntityId";
import { useTask, useTaskRuns, useRunTrace } from "../hooks";
import { useTasks } from "../hooks/useTasks";
import { useTraceFilters } from "../hooks/useTraceFilters";
import {
  computeViewCounts,
  filterThreadsByView,
} from "../components/Traces/viewFilter";
import { useShellHeader } from "../hooks/useShellHeader";
import { runToThreads, type ThreadModel } from "../components/thread";
import { computeExecutionRollups } from "../utils";
import { isEditableShortcutTarget } from "../utils/keyboard";

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

export function TracesPage(): ReactNode {
  const { taskId: routeTaskId } = useParams<{ taskId: string }>();
  const taskId = routeTaskId;
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Keep the full task list fresh so the picker offers every task, not just
  // whatever a previously visited page (or realtime run events) left behind.
  const { tasks } = useTasks();

  const [railCollapsed, setRailCollapsed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false);
  const [fetchedTraceTasks, setFetchedTraceTasks] = useState<Task[]>([]);
  const [pickerInRail, setPickerInRail] = useState(false);
  // Focus-drill state: the currently selected evt/thread id and the subthread
  // drilled into (read-only focus).
  const [selectedEvt, setSelectedEvt] = useState<string | null>(null);
  const [focused, setFocused] = useState<ThreadModel | null>(null);

  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<TaskPickerHandle | null>(null);
  const traceTaskFetchSeqRef = useRef(0);

  useShellHeader("Traces");

  // The entry task scopes the rail's TASKS tree to its subtree; the `task`
  // search param selects which task within that subtree drives the RUNS panel
  // and the trace stream, so picking a child keeps the parent and siblings
  // visible in the tree.
  const rootTaskId = taskId ?? null;
  const selectedTaskParam = searchParams.get("task");
  const currentTaskId = rootTaskId ? (selectedTaskParam ?? rootTaskId) : null;
  const {
    task,
    isLoading: isTaskLoading,
    error: taskError,
  } = useTask(currentTaskId);
  // Entered for a specific task (e.g. from a task detail panel) → scope the
  // rail's TASKS tree to that task + its descendants. The general /traces
  // browser (no task id) still shows the full tree.
  const liveFetchedTraceTasks = useMemo(() => {
    if (!rootTaskId || fetchedTraceTasks.length === 0) return fetchedTraceTasks;
    const liveTasksById = new Map(tasks.map((item) => [item.id, item]));
    return fetchedTraceTasks.map((fetchedTask) => ({
      ...fetchedTask,
      ...liveTasksById.get(fetchedTask.id),
    }));
  }, [rootTaskId, fetchedTraceTasks, tasks]);

  const traceTasks = useMemo(
    () =>
      rootTaskId
        ? mergeTasksById(liveFetchedTraceTasks, task ? [task] : [])
        : mergeTasksById(tasks, fetchedTraceTasks),
    [rootTaskId, tasks, fetchedTraceTasks, liveFetchedTraceTasks, task]
  );

  // Fetch the entry task + its descendants so the rail's TASKS tree is scoped to
  // that subtree. Ancestors and unrelated tasks are intentionally excluded.
  useEffect(() => {
    if (!rootTaskId) {
      setFetchedTraceTasks([]);
      return;
    }
    const seq = ++traceTaskFetchSeqRef.current;
    let cancelled = false;

    const fetchTraceTasks = async (): Promise<void> => {
      // Lookup cache (query data + on-demand fetches) — NOT the result set.
      const cache = new Map<string, Task>();
      for (const existingTask of tasks)
        cache.set(existingTask.id, existingTask);
      if (task) cache.set(task.id, task);

      const fetchTaskById = async (id: string): Promise<Task | null> => {
        const existing = cache.get(id);
        if (existing) return existing;
        const result = await commands.getTask(id);
        if (result.status !== "ok") return null;
        cache.set(result.data.id, result.data);
        return result.data;
      };

      // Result: the entry task + its descendants only (no ancestors).
      const subtree = new Map<string, Task>();
      const entry = await fetchTaskById(rootTaskId);
      if (entry) subtree.set(entry.id, entry);

      const seenDescendants = new Set<string>();
      const fetchChildren = async (parentId: string): Promise<void> => {
        if (seenDescendants.has(parentId)) return;
        seenDescendants.add(parentId);
        const result = await commands.listTasks(taskChildrenFilter(parentId));
        if (result.status !== "ok") return;
        for (const child of result.data) {
          cache.set(child.id, child);
          subtree.set(child.id, child);
        }
        for (const child of result.data) await fetchChildren(child.id);
      };
      await fetchChildren(rootTaskId);

      if (!cancelled && seq === traceTaskFetchSeqRef.current) {
        setFetchedTraceTasks(Array.from(subtree.values()));
      }
    };

    void fetchTraceTasks();
    return () => {
      cancelled = true;
    };
  }, [rootTaskId, task, tasks]);

  // URL state: `runId` selects a specific TaskRun for the entry-point task.
  const selectedRunId = searchParams.get("runId") ?? null;

  const {
    runs,
    resolveRun,
    isLoading: isRunsLoading,
    error: runsError,
  } = useTaskRuns(currentTaskId);

  // Resolve the single active run (selected → active → latest).
  const resolved = useMemo(
    () => resolveRun(selectedRunId),
    [resolveRun, selectedRunId]
  );
  const activeRun = resolved.run;
  const activeRunSource = resolved.source;
  const activeRunId = activeRun?.id ?? null;

  // SINGLE-RUN data path: the run's step executions + their session logs.
  const {
    stepExecutions,
    logsByExecutionId,
    fallbackCostByExecutionId,
    isLoading: isTraceLoading,
    error: traceError,
  } = useRunTrace(currentTaskId, activeRunId);

  const { filters, setSearch, setView } = useTraceFilters();

  const filteredExecutions = useMemo(() => {
    if (!currentTaskId) return stepExecutions;
    // Search now filters the message stream (see streamThreads), not executions.
    return filterExecutions(
      stepExecutions,
      { ...filters, search: "" },
      { rootTaskId: currentTaskId }
    );
  }, [stepExecutions, filters, currentTaskId]);

  // Normalize-on-render: derive the run's Thread[] from the live executions.
  const threads = useMemo<ThreadModel[]>(() => {
    if (!activeRun) return [];
    return runToThreads({
      taskRun: activeRun,
      stepExecutions: filteredExecutions,
      logsByExecutionId,
    });
  }, [activeRun, filteredExecutions, logsByExecutionId]);

  const rollups = useMemo(
    () =>
      computeExecutionRollups(
        filteredExecutions,
        logsByExecutionId,
        fallbackCostByExecutionId
      ),
    [filteredExecutions, fallbackCostByExecutionId, logsByExecutionId]
  );

  // Scope-chip counts come from the full run; the chips + search narrow the
  // CENTER stream only (the rail keeps the full thread tree).
  const viewCounts = useMemo(() => computeViewCounts(threads), [threads]);
  const streamThreads = useMemo(
    () => filterThreadsByView(threads, filters.view, filters.search),
    [threads, filters.view, filters.search]
  );

  // Waiting-run human-input gate for the single active run.
  const humanInputGate = useMemo(() => {
    if (!activeRun || activeRun.status !== "waiting") return null;
    return resolveHumanInputGate(activeRun, stepExecutions);
  }, [activeRun, stepExecutions]);

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

  // Focus-drill jump: select a thread id and scroll the stream to it.
  const jumpTo = useCallback((id: string) => {
    setSelectedEvt(id);
    setFocused(null);
    window.setTimeout(() => {
      const el = threadScrollRef.current;
      const target = el?.querySelector<HTMLElement>(
        `[data-thread-id="${CSS.escape(id)}"]`
      );
      if (el && target) {
        el.scrollTop +=
          target.getBoundingClientRect().top -
          el.getBoundingClientRect().top -
          16;
      }
    }, 40);
  }, []);

  // Deep-link: `#exec=<threadId>` primes the selection on first paint.
  useEffect(() => {
    const hash = location.hash;
    if (!hash) return;
    const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
    for (const part of cleaned.split("&")) {
      const [k, v] = part.split("=");
      if (k === "exec" && v) {
        jumpTo(decodeURIComponent(v));
        return;
      }
    }
  }, [location.hash, jumpTo]);

  // Keyboard: j/k cycle root threads, / focuses search, Esc exits focus.
  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const isEditable = isEditableShortcutTarget(e.target);
      if (e.key === "/" && !isEditable) {
        e.preventDefault();
        if (pickerRef.current) pickerRef.current.focus();
        else {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }
        return;
      }
      if (e.key === "Escape" && !isEditable) {
        setFocused((cur) => (cur ? null : cur));
        setPickerInRail(false);
        return;
      }
      if (isEditable) return;
      if (e.key !== "j" && e.key !== "k") return;
      const ids = threadsRef.current.map((t) => t.id);
      if (ids.length === 0) return;
      e.preventDefault();
      setSelectedEvt((current) => {
        const idx = current ? ids.indexOf(current) : -1;
        if (idx < 0) return ids[0];
        const delta = e.key === "j" ? 1 : -1;
        const nextIdx = Math.max(0, Math.min(ids.length - 1, idx + delta));
        return ids[nextIdx];
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleBack = useCallback(() => navigate(-1), [navigate]);

  const handleToggleRail = useCallback(() => {
    setRailCollapsed((v) => !v);
  }, []);

  // Picker selection: re-enter the page scoped to the picked task's subtree.
  const handlePickTask = useCallback(
    (id: string) => {
      setPickerInRail(false);
      setFocused(null);
      setSelectedEvt(null);
      navigate(`/traces/${id}`);
    },
    [navigate]
  );

  // TASKS-tree selection: keep the tree scoped to the entry task and only
  // switch which task's runs/trace are shown.
  const handleSelectTreeTask = useCallback(
    (id: string) => {
      setFocused(null);
      setSelectedEvt(null);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (id === rootTaskId) params.delete("task");
          else params.set("task", id);
          params.delete("runId");
          return params;
        },
        { replace: true }
      );
    },
    [rootTaskId, setSearchParams]
  );

  const handleSelectRun = useCallback(
    (runId: string) => {
      setFocused(null);
      setSelectedEvt(null);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("runId", runId);
          return params;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const showPickerRail = !taskId || pickerInRail;
  const showRunHistoryRail = runs.length > 0;

  const headerError = taskId ? (taskError ?? runsError ?? traceError) : null;
  const headerLoading = taskId
    ? isTaskLoading || isRunsLoading || isTraceLoading
    : false;

  return (
    <div data-testid="traces-page" className="flex h-full min-h-0 flex-col">
      <TracesHeader
        taskId={currentTaskId}
        title={task?.title ?? null}
        level={task?.level ?? null}
        rollups={rollups}
        runState={activeRun?.status ?? null}
        isLoading={headerLoading}
        error={headerError}
        onBack={taskId ? handleBack : undefined}
      />

      {taskId && (
        <FilterBar
          ref={searchInputRef}
          view={filters.view}
          counts={viewCounts}
          search={filters.search}
          onViewChange={setView}
          onSearchChange={setSearch}
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
        ) : (
          <RunHistoryRail
            runs={runs}
            tasks={traceTasks}
            currentTaskId={currentTaskId}
            activeRunId={activeRunId}
            activeRunSource={activeRunSource}
            activeRunThreads={threads}
            selectedEvt={selectedEvt}
            onJump={jumpTo}
            onSelectTask={handleSelectTreeTask}
            onSelectRun={handleSelectRun}
            onSwitchTask={() => setPickerInRail(true)}
            collapsed={railCollapsed}
            onToggleCollapsed={handleToggleRail}
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
              <div className="flex items-center justify-end gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-2">
                {showRunHistoryRail && activeRun && (
                  <span
                    data-testid="traces-active-run"
                    data-run-id={activeRun.id}
                    data-run-source={activeRunSource}
                    className="flex items-center gap-1 font-mono text-2xs uppercase tracking-wider text-fg-mute"
                  >
                    <span>{activeRunSource} run</span>
                    <IdentityBadge
                      id={activeRun.id}
                      kind="task run"
                      className="px-1 text-fg-soft"
                      testId="traces-active-run-id"
                    />
                  </span>
                )}
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
              </div>

              {streamThreads.length > 0 && (
                <FlightStrip
                  threads={streamThreads}
                  threadScrollRef={threadScrollRef}
                  selectedEvt={selectedEvt}
                  onSelect={setSelectedEvt}
                />
              )}

              {focused && (
                <div
                  data-testid="traces-focus-bar"
                  className="flex items-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[color-mix(in_oklch,var(--color-accent)_8%,var(--color-bg))] px-3 py-2 font-mono text-2xs"
                >
                  <button
                    type="button"
                    data-testid="traces-focus-bar-back"
                    onClick={() => setFocused(null)}
                    className="cursor-pointer border-b border-dotted border-[var(--color-fg-mute)] text-[var(--color-fg-mute)] hover:text-[var(--color-accent)]"
                  >
                    ← run {activeRunId}
                  </button>
                  <span className="text-[var(--color-fg-mute)]">/</span>
                  <span className="flex min-w-0 items-center gap-1 truncate text-[var(--color-fg-soft)]">
                    focused on{" "}
                    <b className="text-[var(--color-fg)]">{focused.label}</b>
                  </span>
                  <span className="ml-auto rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] px-1 text-[length:var(--text-9)] uppercase tracking-wider text-[var(--color-fg-mute)]">
                    read-only
                  </span>
                </div>
              )}

              <div
                data-testid="traces-event-stream-frame"
                className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)]"
              >
                <UnifiedChatView
                  threads={streamThreads}
                  isLoading={isTraceLoading}
                  error={traceError}
                  selectedEvt={selectedEvt}
                  onSelect={setSelectedEvt}
                  onFocus={setFocused}
                  focused={focused}
                  scrollRef={threadScrollRef}
                  autoScroll={autoScroll}
                  humanInputGate={humanInputGate}
                  activeRunStoppable={activeRunStoppable}
                  isStoppingActiveRun={isStoppingActiveRun}
                  onStopActiveRun={handleStopActiveRun}
                />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
