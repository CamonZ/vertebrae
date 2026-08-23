/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas · Run Console — docked glass HUD over the workflow canvas.

   The map shows the *machine* (workflows); this shows the *work* (tasks) flowing
   through it. A FAB toggles a left-docked panel with Ready ↔ Running tabs, each
   driven by REAL task data:

     • task feed   — `useRunConsoleTasks` (listReady() — the dependency-aware
                     `vtb ready` set, refreshed on the same realtime events
                     usePipelineSummary uses, debounced).
     • tab split   — `splitRunConsole` over `utils/runState` (Running = active
                     TaskRuns; Ready = workflow tasks with no active run).
     • mini-pipe   — each row renders its task's workflow steps through the kind
                     adapter, the current step `running`, earlier `done`, later
                     `queued` (`miniPipeline`).
     • actions     — Run → runWorkflow(taskId, null); Stop → stopRun({task_id});
                     Run-all over the head of the ready queue. A 1s tick advances
                     live runtimes from each run's started_at.
     • row click   — opens the canonical TaskDetailPanel (right-docked floating
                     glass; brought by the panel itself).

   Mounted OUTSIDE the Atlas morph layers so it persists across the Map⇄Graph
   toggle. The docked surfaces carry `data-no-pan` so dragging them never pans
   the canvas underneath.

   Ported from docs/design/run-console.jsx (RunConsole).
   ────────────────────────────────────────────────────────────────── */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands, type PipelineSummary } from "../../bindings";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import { CloseIcon, IconButton, PlayIcon, StopIcon } from "../panels";
import { Glyph, IdChip } from "../shared/HearthPrimitives";
import { TaskDetailPanel } from "../TaskDetail";
import { useRunConsoleTasks } from "./hooks/useRunConsoleTasks";
import { useActiveTaskRunsForTasks } from "../../hooks/useTaskRuns";
import { useTaskLocation } from "../../hooks/useTaskLocation";
import { taskLocationWorkflowLabel } from "../../utils/taskLocation";
import { kindClass } from "./inspector/selection";
import {
  miniPipeline,
  runtimeSince,
  splitRunConsole,
  type RunConsoleRow,
} from "./runConsoleData";
import "./RunConsole.css";

/** How many tasks "Run all" launches from the head of the ready queue. */
const RUN_ALL_HEAD = 6;
/** Live-runtime clock cadence. */
const TICK_MS = 1000;

/** Horizontal resize clamp + persistence (panel is left-docked; handle on right). */
const MIN_WIDTH = 300;
const MAX_WIDTH = 620;
const DEFAULT_WIDTH = 354;
const RESIZE_STEP = 16;
const WIDTH_STORAGE_KEY = "atlas.runConsole.width";

type ConsoleTab = "ready" | "running";

const ICON = {
  search: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  ),
  bolt: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M13 2L3 14h8l-1 8 10-12h-8z" />
    </svg>
  ),
};

interface RowProps {
  row: RunConsoleRow;
  tab: ConsoleTab;
  summary: PipelineSummary | null;
  selected: boolean;
  now: number;
  onRun: (taskId: string) => void;
  onStop: (taskId: string) => void;
  onSelect: (taskId: string) => void;
}

function Row({
  row,
  tab,
  summary,
  selected,
  now,
  onRun,
  onStop,
  onSelect,
}: RowProps) {
  const { task } = row;
  const location = useTaskLocation(task);
  const isRunning = tab === "running";
  // The row's workflow steps as state-coloured segments for the mini-pipeline
  // strip. Only an actually-running task animates its current step (Ready rows
  // stay static).
  const segments = useMemo(
    () => miniPipeline(task, summary, isRunning),
    [task, summary, isRunning]
  );
  const runtime = runtimeSince(row.startedAt, now);

  return (
    <div
      className={"rc-row" + (selected ? " sel" : "")}
      onClick={() => onSelect(task.id)}
      data-testid="rc-row"
    >
      <div className="rc-main">
        <div className="rc-top">
          <Glyph level={task.level} accent={tab === "running"} />
          <IdChip
            id={task.id}
            kind="task"
            level={task.level}
            testId="rc-row-id"
          />
          {tab === "running" ? (
            runtime ? (
              <span className="rc-meta">{runtime}</span>
            ) : null
          ) : location.status !== "unassigned" ? (
            <span className="rc-meta">
              {taskLocationWorkflowLabel(location)}
            </span>
          ) : null}
        </div>
        <div className="rc-title">{task.title}</div>
        {segments.length > 0 ? (
          <div className="rc-pipe" data-testid="rc-pipe">
            {segments.map((seg, i) => (
              <span
                key={i}
                className={`rc-seg ${kindClass(seg.kind)} ${seg.state}`}
              />
            ))}
          </div>
        ) : null}
      </div>
      {tab === "ready" ? (
        <button
          className="rc-act run"
          title="Run this task"
          aria-label="Run task"
          onClick={(e) => {
            e.stopPropagation();
            onRun(task.id);
          }}
        >
          <PlayIcon />
        </button>
      ) : (
        <button
          className="rc-act stop"
          title="Stop run"
          aria-label="Stop run"
          onClick={(e) => {
            e.stopPropagation();
            onStop(task.id);
          }}
        >
          <StopIcon />
        </button>
      )}
    </div>
  );
}

export interface RunConsoleProps {
  /** Pipeline summary, used to project each task onto its workflow's steps. */
  summary: PipelineSummary | null;
}

/**
 * Docked Run Console. Self-contained: owns its open/tab/query/selection state
 * and its own task feed. Safe to mount once alongside the Atlas canvas.
 */
export function RunConsole({ summary }: RunConsoleProps) {
  const { tasks } = useRunConsoleTasks();
  const { activeRunsByTaskId } = useActiveTaskRunsForTasks(
    tasks.map((task) => task.id)
  );

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ConsoleTab>("ready");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Horizontal resize. Left-docked, so a drag on the RIGHT edge widens the panel
  // as the cursor moves right: width = cursorX − fixed-left-edge. Persisted.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_WIDTH;
    const stored = parseInt(localStorage.getItem(WIDTH_STORAGE_KEY) ?? "", 10);
    return Number.isNaN(stored)
      ? DEFAULT_WIDTH
      : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, stored));
  });
  const [isResizing, setIsResizing] = useState(false);

  // Join the shared glass-panel focus stack so Escape collapses the console when
  // it is the topmost panel (an open task-detail float, opened on top, wins
  // first — same topmost-wins model the detail panels use).
  const { focusProps } = useGlassPanel({
    id: "run-console",
    isOpen: open,
    onClose: () => setOpen(false),
  });

  // Live runtime clock — only ticks while the panel is open (no work at rest).
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [open]);

  // Persist the chosen width.
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(panelWidth));
    }
  }, [panelWidth]);

  // Drag-to-resize: measure the panel's fixed LEFT edge and grow rightward.
  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      const leftEdge = panelRef.current?.getBoundingClientRect().left ?? 0;
      setPanelWidth(
        Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, event.clientX - leftEdge))
      );
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing]);

  const { running, ready } = useMemo(
    () => splitRunConsole(tasks, activeRunsByTaskId),
    [activeRunsByTaskId, tasks]
  );

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (row: RunConsoleRow) => {
      if (!q) return true;
      const t = row.task;
      return (
        t.title.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        (t.tags ?? []).some((g) => g.toLowerCase().includes(q))
      );
    },
    [q]
  );

  const runningRows = useMemo(
    () => running.filter(matches),
    [running, matches]
  );
  const readyRows = useMemo(() => ready.filter(matches), [ready, matches]);
  const list = tab === "running" ? runningRows : readyRows;

  const runCount = running.length;
  const readyCount = ready.length;

  const onRun = useCallback(async (taskId: string) => {
    setTab("running");
    await commands.runWorkflow(taskId, null);
  }, []);

  const onStop = useCallback(async (taskId: string) => {
    await commands.stopRun({ task_run_id: null, task_id: taskId });
  }, []);

  const onRunAll = useCallback(async () => {
    const head = readyRows.slice(0, RUN_ALL_HEAD);
    if (head.length === 0) return;
    setTab("running");
    await Promise.all(head.map((r) => commands.runWorkflow(r.task.id, null)));
  }, [readyRows]);

  return (
    <>
      {open ? (
        <div
          ref={panelRef}
          className="rc"
          style={{ width: `${panelWidth}px` }}
          data-no-pan
          data-testid="run-console"
          {...focusProps}
        >
          <div className="rc-hd">
            <div className="rc-hd-top">
              <span className="rc-eyebrow">
                <span className="ember" />
                Run Console
              </span>
              <span className="rc-live">
                <span className="pulse" />
                {runCount} running
              </span>
              <IconButton
                onClick={() => setOpen(false)}
                ariaLabel="Collapse run console"
                title="Collapse"
              >
                <CloseIcon />
              </IconButton>
            </div>
            <div className="rc-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === "ready"}
                className={"rc-tab" + (tab === "ready" ? " on" : "")}
                onClick={() => setTab("ready")}
              >
                Ready<span className="n">{readyCount}</span>
              </button>
              <button
                role="tab"
                aria-selected={tab === "running"}
                className={"rc-tab" + (tab === "running" ? " on" : "")}
                onClick={() => setTab("running")}
              >
                Running<span className="n">{runCount}</span>
              </button>
            </div>
            <div className="rc-search">
              {ICON.search}
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter tasks by name, id, tag…"
                aria-label="Filter tasks"
              />
            </div>
          </div>

          <div className="rc-list">
            {list.length === 0 ? (
              <div className="rc-empty">
                {tab === "running"
                  ? "No runs in flight."
                  : "No ready tasks match."}
              </div>
            ) : (
              list.map((row) => (
                <Row
                  key={row.task.id}
                  row={row}
                  tab={tab}
                  summary={summary}
                  selected={selected === row.task.id}
                  now={now}
                  onRun={onRun}
                  onStop={onStop}
                  onSelect={setSelected}
                />
              ))
            )}
          </div>

          <div className="rc-ft">
            <span className="rc-ag">
              <b>{runCount}</b> running <span className="dot">·</span>{" "}
              <b>{readyCount}</b> ready
            </span>
            {tab === "ready" && readyRows.length > 0 ? (
              <button className="rc-runall" onClick={onRunAll}>
                {ICON.bolt}Run all
              </button>
            ) : null}
          </div>

          <div
            className="rc-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize run console"
            aria-valuenow={panelWidth}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            tabIndex={0}
            data-resizing={isResizing || undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              setIsResizing(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                setPanelWidth((w) => Math.min(MAX_WIDTH, w + RESIZE_STEP));
              } else if (event.key === "ArrowLeft") {
                setPanelWidth((w) => Math.max(MIN_WIDTH, w - RESIZE_STEP));
              }
            }}
          />
        </div>
      ) : (
        <button
          className="rc-fab"
          data-no-pan
          onClick={() => setOpen(true)}
          title="Open run controls"
          aria-label="Open run console"
          data-testid="run-console-fab"
        >
          <span className="rc-fab-ico">{ICON.bolt}</span>
          <span className="rc-fab-label">Runs</span>
          {runCount > 0 ? (
            <span className="rc-fab-count">
              <span className="pulse" />
              {runCount}
            </span>
          ) : null}
        </button>
      )}

      {selected ? (
        <TaskDetailPanel
          key={selected}
          taskId={selected}
          onClose={() => setSelected(null)}
          onTaskSelect={setSelected}
        />
      ) : null}
    </>
  );
}
