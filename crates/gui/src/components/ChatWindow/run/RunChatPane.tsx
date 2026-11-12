/**
 * RunChatPane — a durable TaskRun rendered read-only inside a chat pane.
 *
 * Data comes from the single-run trace path (useRunTrace → sessionLogStore,
 * normalized with runToThreads) and renders through the shared <Thread>
 * primitive with step heads. There is no composer and no ChatSession: a
 * waiting human_input gate shows its gate card instead.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { commands, type TaskRun } from "../../../bindings";
import { useRunTrace, useTask } from "../../../hooks";
import { useTaskRuns } from "../../../hooks/useTaskRuns";
import { resolveGateInChat } from "../../../hooks/useGateChat";
import { useChatStore, type RunChatPane } from "../../../stores/chatStore";
import { computeExecutionRollups, formatTokenCount } from "../../../utils";
import { formatDurationMs } from "../../../utils/formatDuration";
import { resolveHumanInputGate } from "../../../utils/humanInputGate";
import type { HumanInputGateContext } from "../../../utils/humanInputGate";
import { isActiveRunStatus } from "../../../utils/runState";
import { IdentityBadge } from "../../shared/EntityId";
import { EventLog, Thread, runToThreads } from "../../thread";
import type { Thread as ThreadModel } from "../../thread/types";
import { PaneControls, SvgIcon, type HeaderAction } from "../ChatHeader";
import { HumanInputGate } from "./HumanInputGate";
import { usePaneFind } from "../usePaneFind";
import { ThreadFindContext } from "../../thread/find";
import { findThread, countThreadMessages } from "./runThreads";

export interface RunPaneWindowProps {
  pane: RunChatPane;
  paneIsActive: boolean;
  paneCount: number;
  index: number;
  isMaximized: boolean;
  canAddSplitPane: boolean;
  focusPane: (paneId: string) => void;
  closePane: (paneId: string) => void;
  unsplitPanes: (paneId?: string) => void;
  closeChatPanel: () => void;
  toggleHistorySelector: () => boolean;
  toggleMaximized: () => void;
  splitWithFreshSession: () => Promise<boolean>;
  /** Registers this pane's find opener for ⌘F. */
  registerFind?: (paneId: string, openFind: (() => boolean) | null) => void;
}

/** Px from the bottom within which new output keeps the view pinned. */
const PIN_THRESHOLD = 48;

function runDotClass(run: TaskRun | null): string {
  if (!run) return "em";
  if (run.status === "failed") return "em err";
  if (isActiveRunStatus(run.status)) return "em ok";
  return "em mute";
}

export const RunPaneWindow = memo(function RunPaneWindow({
  pane,
  paneIsActive,
  paneCount,
  index,
  isMaximized,
  canAddSplitPane,
  focusPane,
  closePane,
  unsplitPanes,
  closeChatPanel,
  toggleHistorySelector,
  toggleMaximized,
  splitWithFreshSession,
  registerFind,
}: RunPaneWindowProps) {
  const { taskId, runId, focusThreadId, scrollRequest } = pane;
  const { task } = useTask(taskId);
  const { runs, error: runsError } = useTaskRuns(taskId);
  const run = useMemo(
    () => runs.find((candidate) => candidate.id === runId) ?? null,
    [runs, runId]
  );
  const {
    stepExecutions,
    logsByExecutionId,
    logBucketsByExecutionId,
    isLoading,
    error: traceError,
  } = useRunTrace(taskId, runId);

  const threads = useMemo<ThreadModel[]>(
    () =>
      run
        ? runToThreads({ taskRun: run, stepExecutions, logsByExecutionId })
        : [],
    [run, stepExecutions, logsByExecutionId]
  );
  const focused = useMemo(
    () => (focusThreadId ? findThread(threads, focusThreadId) : null),
    [threads, focusThreadId]
  );
  const shownThreads = useMemo(
    () => (focusThreadId ? (focused ? [focused] : []) : threads),
    [focusThreadId, focused, threads]
  );

  const rollups = useMemo(
    () => computeExecutionRollups(stepExecutions, logBucketsByExecutionId),
    [stepExecutions, logBucketsByExecutionId]
  );

  const humanInputGate = useMemo(() => {
    if (focusThreadId || !run || run.status !== "waiting") return null;
    return resolveHumanInputGate(run, stepExecutions);
  }, [focusThreadId, run, stepExecutions]);

  const stoppable = task?.run_controls?.stoppable === true;
  const [isStopping, setIsStopping] = useState(false);
  const stopRun = useCallback(async () => {
    setIsStopping(true);
    try {
      await commands.stopRun({ task_run_id: runId, task_id: null });
    } finally {
      setIsStopping(false);
    }
  }, [runId]);

  // Resolve opens the bound gate chat beside this run instead of over it.
  const resolveInChat = useCallback(
    async (context: HumanInputGateContext) => {
      const sessionId = await resolveGateInChat(context);
      if (sessionId)
        useChatStore.getState().showSessionBesideRunPane(sessionId, pane);
    },
    [pane]
  );

  const openSubagent = useCallback(
    (thread: ThreadModel) => {
      useChatStore
        .getState()
        .openRunPane(
          { taskId, runId, focusThreadId: thread.id },
          { split: true }
        );
    },
    [taskId, runId]
  );

  const [showTimestamps, setShowTimestamps] = useState(false);
  const [selectedEvt, setSelectedEvt] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const find = usePaneFind(scrollRef);
  useEffect(() => {
    if (!registerFind) return;
    registerFind(pane.id, find.openFind);
    return () => registerFind(pane.id, null);
  }, [registerFind, pane.id, find.openFind]);

  const registerRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) el.setAttribute("data-thread-id", id);
  }, []);

  // Keep a live run pinned to its tail while the reader is at the bottom.
  const messageCount = useMemo(
    () => countThreadMessages(shownThreads),
    [shownThreads]
  );
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messageCount]);

  // Scroll requests (history step rows, deep links) wait for their thread.
  const handledScrollNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!scrollRequest || handledScrollNonce.current === scrollRequest.nonce)
      return;
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(
      `[data-thread-id="${CSS.escape(scrollRequest.threadId)}"]`
    );
    if (!el || !target) return;
    handledScrollNonce.current = scrollRequest.nonce;
    pinnedRef.current = false;
    setSelectedEvt(scrollRequest.threadId);
    el.scrollTop +=
      target.getBoundingClientRect().top - el.getBoundingClientRect().top - 16;
  }, [scrollRequest, shownThreads]);

  const title = focusThreadId
    ? `${focused?.label ?? "Subagent"} · ${task?.title ?? taskId.slice(0, 8)}`
    : (task?.title ?? taskId.slice(0, 8));
  const error = runsError ?? traceError;

  const leading: HeaderAction[] = [
    {
      key: "timestamps",
      title: showTimestamps ? "Hide timestamps" : "Show timestamps",
      ariaLabel: "Timestamps",
      onClick: () => setShowTimestamps((shown) => !shown),
      show: true,
      pressed: showTimestamps,
      testId: "run-pane-timestamps",
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <circle cx="12" cy="12" r="8" strokeWidth={2} />
          <path strokeLinecap="round" strokeWidth={2} d="M12 8v4l2.5 2.5" />
        </SvgIcon>
      ),
    },
    {
      key: "history",
      title: "Toggle chat history",
      ariaLabel: "Toggle chat history",
      onClick: () => void toggleHistorySelector(),
      show: !isMaximized,
      icon: (
        <SvgIcon size="h-3.5 w-3.5">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h10"
          />
        </SvgIcon>
      ),
    },
  ];

  const mode = showTimestamps ? "timed" : "bare";
  let body: ReactNode;
  if (error) {
    body = (
      <div
        data-testid="run-pane-error"
        className="m-4 rounded-[var(--radius-md)] border border-[var(--color-err)]/40 bg-[var(--color-err-wash)] p-4 text-sm text-[var(--color-err)]"
      >
        Failed to load run: {error}
      </div>
    );
  } else if ((isLoading || !run) && shownThreads.length === 0) {
    body = (
      <div
        data-testid="run-pane-loading"
        className="flex h-full items-center justify-center p-8 text-sm text-[var(--color-fg-mute)]"
      >
        Loading run…
      </div>
    );
  } else if (shownThreads.length === 0) {
    body = (
      <div
        data-testid="run-pane-empty"
        className="p-8 text-center text-sm text-[var(--color-fg-mute)]"
      >
        {focusThreadId
          ? "This subagent is no longer part of the run."
          : "No conversation yet for this run."}
      </div>
    );
  } else {
    body = (
      <ThreadFindContext.Provider value={find.findQuery}>
        <EventLog mode={mode}>
          {shownThreads.map((thread) => (
            <Thread
              key={thread.id}
              thread={thread}
              depth={0}
              mode={mode}
              reveal="deep"
              readOnly
              selectedEvt={selectedEvt}
              onSelect={setSelectedEvt}
              registerRef={registerRef}
              onFocus={openSubagent}
            />
          ))}
        </EventLog>
      </ThreadFindContext.Provider>
    );
  }

  return (
    <section
      className="hc-chat-pane"
      data-testid="chat-pane"
      data-pane-kind="run"
      data-pane-active={paneIsActive || undefined}
      aria-label={`Chat pane ${index + 1}: ${title}`}
      aria-selected={paneIsActive}
      tabIndex={0}
      onMouseDownCapture={() => focusPane(pane.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        focusPane(pane.id);
      }}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="run-pane"
        data-run-id={runId}
        data-run-status={run?.status ?? ""}
      >
        <div className="hc-head">
          <div className="hc-head-top">
            <div className="hc-title">
              <span className="label" data-testid="run-pane-title">
                {title}
              </span>
              <span className={runDotClass(run)} />
            </div>
            <PaneControls
              leading={leading}
              onClosePanel={closeChatPanel}
              onToggleWide={toggleMaximized}
              isWide={isMaximized}
              onSplitPane={
                isMaximized ? () => void splitWithFreshSession() : undefined
              }
              canSplitPane={canAddSplitPane}
              onUnsplitPanes={
                isMaximized && paneCount > 1
                  ? () => unsplitPanes(pane.id)
                  : undefined
              }
              onClosePane={
                isMaximized && paneCount > 1
                  ? () => closePane(pane.id)
                  : undefined
              }
            />
          </div>
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-1 font-mono text-2xs text-[var(--color-fg-mute)]"
            data-testid="run-pane-meta"
          >
            <span className="uppercase tracking-wider">
              {run?.status ?? "run"}
            </span>
            <IdentityBadge
              id={runId}
              kind="task run"
              className="px-1 text-fg-soft"
              testId="run-pane-run-id"
            />
            <span>
              {rollups.totalAttempts}{" "}
              {rollups.totalAttempts === 1 ? "step" : "steps"}
            </span>
            {rollups.totalWallTimeMs > 0 && (
              <span>{formatDurationMs(rollups.totalWallTimeMs)}</span>
            )}
            {rollups.totalTokens > 0 && (
              <span title={`${formatTokenCount(rollups.totalTokens)} tokens`}>
                <span data-testid="run-pane-tokens-raw">
                  {formatTokenCount(rollups.rawInputTokens)} raw
                </span>
                {" · "}
                <span data-testid="run-pane-tokens-cache">
                  {formatTokenCount(rollups.cacheReadTokens)} cache
                </span>
                {" · "}
                <span data-testid="run-pane-tokens-output">
                  {formatTokenCount(rollups.outputTokens)} out
                </span>
              </span>
            )}
            {rollups.totalCost > 0 && (
              <span>${rollups.totalCost.toFixed(2)}</span>
            )}
          </div>
        </div>
        {find.bar}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4"
          data-testid="run-pane-scroll"
          onScroll={(event) => {
            const el = event.currentTarget;
            pinnedRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
          }}
        >
          {body}
        </div>
        {humanInputGate && (
          <div className="border-t border-[var(--color-line)] p-3">
            <HumanInputGate
              context={humanInputGate}
              stoppable={stoppable}
              isStopping={isStopping}
              onStop={() => void stopRun()}
              onResolve={(context) => void resolveInChat(context)}
            />
          </div>
        )}
      </div>
    </section>
  );
});
