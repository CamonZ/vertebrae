import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { SessionLog, StepExecution, Task } from "../bindings";
import {
  CorridorView,
  FilterBar,
  FlightStrip,
  ModeToggle,
  SubtreeRail,
  TracesHeader,
  TracesPickerRail,
  UnifiedChatView,
  type TaskPickerHandle,
  type TraceMode,
} from "../components/Traces";
import {
  filterExecutions,
  matchesSearch,
} from "../components/Traces/applyFilters";
import { useTask } from "../hooks";
import { useSubtreeExecutions } from "../hooks/useSubtreeExecutions";
import { useSubtreeSessionLogs } from "../hooks/useSubtreeSessionLogs";
import { useTraceFilters } from "../hooks/useTraceFilters";
import { useTaskStore } from "../stores/taskStore";
import type { TaggedConversationEvent } from "../types/conversation";

interface ModeContentProps {
  mode: TraceMode;
  taskId: string;
  executions: StepExecution[];
  tasks: Task[];
  logsByExecutionId: Record<string, SessionLog[]>;
  isSubtreeLoading: boolean;
  subtreeError: string | null;
  threadScrollRef: RefObject<HTMLDivElement | null>;
  onPinExecution: (id: string) => void;
  search: string;
  autoScroll: boolean;
  focusExecutionId: string | null;
  activeExecutionId: string | null;
}

function renderModeContent(props: ModeContentProps): ReactNode {
  const {
    mode,
    taskId,
    executions,
    tasks,
    logsByExecutionId,
    isSubtreeLoading,
    subtreeError,
    threadScrollRef,
    onPinExecution,
    search,
    autoScroll,
    focusExecutionId,
    activeExecutionId,
  } = props;
  switch (mode) {
    case "thread":
      return (
        <UnifiedChatView
          rootTaskId={taskId}
          executions={executions}
          tasks={tasks}
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
        />
      );
    case "corridor":
      return (
        <CorridorView
          rootTaskId={taskId}
          executions={executions}
          tasks={tasks}
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

export function TracesPage(): ReactNode {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const tasks = useTaskStore((state) => state.tasks);

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
  const {
    rollups,
    executions,
    subtreeTaskIds,
    isLoading: isSubtreeLoading,
    error: subtreeError,
  } = useSubtreeExecutions(safeTaskId);
  const { logsByExecutionId } = useSubtreeSessionLogs(executions);

  const { filters, setStatus, setStepName, setModel, setSearch, setRootOnly } =
    useTraceFilters();

  const filteredExecutions = useMemo(() => {
    if (!safeTaskId) return [] as StepExecution[];
    return filterExecutions(executions, filters, { rootTaskId: safeTaskId });
  }, [executions, filters, safeTaskId]);

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

  const handleToggleRail = useCallback(() => {
    setRailCollapsed((v) => !v);
  }, []);

  const handlePickTask = useCallback(
    (id: string) => {
      setPickerInRail(false);
      navigate(`/traces/${id}`);
    },
    [navigate]
  );

  const showPickerRail = !taskId || pickerInRail;
  const headerError = taskId ? (taskError ?? subtreeError) : null;
  const headerLoading = taskId ? isTaskLoading || isSubtreeLoading : false;
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
        onBack={taskId ? handleBack : undefined}
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
        ) : (
          <SubtreeRail
            rootTaskId={taskId!}
            tasks={tasks}
            subtreeTaskIds={subtreeTaskIds}
            executions={filteredExecutions}
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
              {mode === "thread" && filteredExecutions.length > 0 && (
                <FlightStrip
                  rootTaskId={taskId}
                  executions={filteredExecutions}
                  tasks={tasks}
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
                    logsByExecutionId,
                    isSubtreeLoading,
                    subtreeError,
                    threadScrollRef,
                    onPinExecution: setPinnedExecutionId,
                    search: filters.search,
                    autoScroll,
                    focusExecutionId,
                    activeExecutionId,
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
