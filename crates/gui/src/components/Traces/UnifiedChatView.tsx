/**
 * UnifiedChatView — THREAD mode of /traces/:taskId.
 *
 * Renders ONE continuous scroll surface containing all session-log events
 * across every execution in the subtree, ordered chronologically.
 *
 * Anti-pattern this fixes: the legacy ConversationLogViewer was rendered
 * once per execution inside its own bounded scroll box, making the
 * conversation feel disjointed. Here, the entire subtree shares a single
 * scrollable container; workflow/step boundaries become sticky section
 * dividers; consecutive executions on the same task get a `from → to`
 * transition chip; events from descendant tasks (child task activated by
 * a parent step) are visually nested in a `DelegationBlock` with their
 * own boundary header.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  SessionLog,
  StepExecution,
  Task,
  Workflow,
} from "../../bindings";
import {
  mergeExecutionEvents,
  type TaggedConversationEvent,
} from "../../types/conversation";
import { useSubtreeSessionLogs } from "../../hooks/useSubtreeSessionLogs";
import { parseCost } from "../../utils";
import {
  EventRenderer,
  TimeModeContext,
  type TimeMode,
} from "./conversation/EventRenderer";
import { StepBoundary } from "./conversation/StepBoundary";
import { TransitionMarker } from "./conversation/TransitionMarker";
import { DelegationBlock } from "./conversation/DelegationBlock";
import { HumanInputGate } from "./HumanInputGate";
import type { TaskRunTraceProjection } from "./taskRunTrace";
import { resolveHumanInputGate } from "../../utils/humanInputGate";
import {
  summarizeExecutions,
  summarizeProjection,
  traceDebug,
} from "./traceDebug";

interface UnifiedChatViewProps {
  rootTaskId: string;
  executions: readonly StepExecution[];
  tasks: readonly Task[];
  runProjection?: TaskRunTraceProjection | null;
  /**
   * Optional list of workflows used to resolve the workflow tag shown on each
   * execution row's StepBoundary header. The tag must reflect the workflow the
   * execution actually ran under (via `StepExecution.workflow_id`), not the
   * task's current workflow — a task that started in Backlog and was routed
   * into Implementation should still show BACKLOG on its early executions.
   * When omitted (or no match is found), the boundary falls back to the
   * task's current `workflow_name`.
   */
  workflows?: readonly Workflow[];
  /** Optional: pass logs in directly (used by tests); otherwise fetched. */
  logsByExecutionId?: Record<string, SessionLog[]>;
  isLoading?: boolean;
  error?: string | null;
  /**
   * Optional ref forwarded to the scroll container so a sibling FlightStrip
   * can read scroll position and write to it on click/scrub.
   */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /**
   * Optional predicate to filter merged events. If returns false, the event
   * is hidden. Empty segments (no surviving events) are dropped.
   */
  eventFilter?: (tagged: TaggedConversationEvent) => boolean;
  /**
   * Optional predicate to filter executions before merging. Events whose
   * executionId is rejected here are dropped. Used by FilterBar to narrow
   * by status/step/model/rootOnly.
   */
  executionFilter?: (executionId: string) => boolean;
  /** When true, append-on-new-event auto-scrolls to the bottom. */
  autoScroll?: boolean;
  /**
   * Execution id from URL fragment (#exec=…). When provided, the matching
   * segment is scrolled into view on first paint.
   */
  focusExecutionId?: string | null;
  /** Currently keyboard-focused execution id (j/k cycles). */
  activeExecutionId?: string | null;
  activeRunStoppable?: boolean;
  isStoppingActiveRun?: boolean;
  onStopActiveRun?: () => void;
}

function buildDepthMap(
  rootTaskId: string,
  tasksById: Map<string, Task>
): Map<string, number> {
  const depths = new Map<string, number>();
  depths.set(rootTaskId, 0);
  function depthOf(id: string, seen: Set<string>): number {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parentId = tasksById.get(id)?.parent_id ?? null;
    const d = parentId ? depthOf(parentId, seen) + 1 : 0;
    depths.set(id, d);
    return d;
  }
  for (const id of tasksById.keys()) depthOf(id, new Set());
  return depths;
}

interface SessionFacts {
  /** Model from the session_start event (preferred over StepExecution.model). */
  model: string | null;
  /** Wall-time of the session from the session_end event, in ms. */
  durationMs: number | null;
  /** Assistant turn count from the session_end event. */
  numTurns: number | null;
  /** Cost in USD from the session_end event. */
  costUsd: number | null;
}

interface Segment {
  executionId: string;
  taskId: string;
  /** TaskRun id this segment belongs to, when known. */
  taskRunId: string | null;
  workflowId: string | null;
  stepName: string | null;
  startedAt: string | null;
  /**
   * Renderable events only — `session_start` / `session_end` are stripped out
   * and surfaced via `sessionFacts` on the StepBoundary header instead.
   */
  events: TaggedConversationEvent[];
  /** Folded session_start / session_end facts for the boundary header. */
  sessionFacts: SessionFacts;
}

/** Group tagged events into one render segment per executionId. */
function groupByExecution(
  events: TaggedConversationEvent[],
  taskRunIdByExecutionId: Map<string, string>
): Segment[] {
  const segments: Segment[] = [];
  const segmentsByExecutionId = new Map<string, Segment>();
  for (const tagged of events) {
    const existing = segmentsByExecutionId.get(tagged.executionId);
    if (existing) {
      foldOrPush(existing, tagged);
      continue;
    }
    const seg: Segment = {
      executionId: tagged.executionId,
      taskId: tagged.taskId,
      taskRunId: taskRunIdByExecutionId.get(tagged.executionId) ?? null,
      workflowId: tagged.workflowId,
      stepName: tagged.stepName,
      startedAt: tagged.executionStartedAt,
      events: [],
      sessionFacts: {
        model: null,
        durationMs: null,
        numTurns: null,
        costUsd: null,
      },
    };
    foldOrPush(seg, tagged);
    segments.push(seg);
    segmentsByExecutionId.set(tagged.executionId, seg);
  }
  return segments;
}

/**
 * Either fold session_start / session_end metadata into the segment's
 * `sessionFacts`, or push the event onto the renderable list.
 */
function foldOrPush(seg: Segment, tagged: TaggedConversationEvent): void {
  const ev = tagged.event;
  if (ev.kind === "session_start") {
    seg.sessionFacts.model = ev.model;
    return;
  }
  if (ev.kind === "session_end") {
    seg.sessionFacts.durationMs = ev.durationMs;
    seg.sessionFacts.numTurns = ev.numTurns;
    seg.sessionFacts.costUsd = ev.costUsd;
    return;
  }
  seg.events.push(tagged);
}

export function UnifiedChatView({
  rootTaskId,
  executions,
  tasks,
  runProjection,
  workflows,
  logsByExecutionId: providedLogs,
  isLoading: externalLoading,
  error: externalError,
  scrollRef,
  eventFilter,
  executionFilter,
  autoScroll = false,
  focusExecutionId = null,
  activeExecutionId = null,
  activeRunStoppable = false,
  isStoppingActiveRun = false,
  onStopActiveRun,
}: UnifiedChatViewProps): ReactNode {
  const [timeMode, setTimeMode] = useState<TimeMode>("absolute");
  const fetched = useSubtreeSessionLogs(providedLogs ? [] : executions);
  const logsByExecutionId = providedLogs ?? fetched.logsByExecutionId;
  const isLoading = externalLoading ?? fetched.isLoading;
  const error = externalError ?? fetched.error;

  const tasksById = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  const executionsById = useMemo(() => {
    const m = new Map<string, StepExecution>();
    for (const e of executions) {
      if (e.id) m.set(e.id, e);
    }
    return m;
  }, [executions]);

  const workflowNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const w of workflows ?? []) {
      if (w.id) m.set(w.id, w.name);
    }
    return m;
  }, [workflows]);

  const depthByTaskId = useMemo(
    () => buildDepthMap(rootTaskId, tasksById),
    [rootTaskId, tasksById]
  );

  const taskRunIdByExecutionId = useMemo(() => {
    if (runProjection) return runProjection.runIdByExecutionId;
    const m = new Map<string, string>();
    for (const e of executions) {
      if (e.id && e.task_run_id) m.set(e.id, e.task_run_id);
    }
    return m;
  }, [runProjection, executions]);

  const depthByTaskRunId = useMemo(() => {
    const m = new Map<string, number>();
    if (!runProjection) return m;
    for (const node of runProjection.orderedRuns) {
      m.set(node.run.id, node.depth);
    }
    return m;
  }, [runProjection]);

  const merged = useMemo(
    () => mergeExecutionEvents(executions, logsByExecutionId),
    [executions, logsByExecutionId]
  );

  const filteredMerged = useMemo(() => {
    if (!eventFilter && !executionFilter) return merged;
    return merged.filter((tagged) => {
      if (executionFilter && !executionFilter(tagged.executionId)) return false;
      if (eventFilter && !eventFilter(tagged)) return false;
      return true;
    });
  }, [merged, eventFilter, executionFilter]);

  const segments = useMemo(
    () => groupByExecution(filteredMerged, taskRunIdByExecutionId),
    [filteredMerged, taskRunIdByExecutionId]
  );

  useEffect(() => {
    traceDebug("render thread", {
      rootTaskId,
      executions: summarizeExecutions(executions),
      projection: summarizeProjection(runProjection ?? null),
      mergedEventCount: merged.length,
      filteredEventCount: filteredMerged.length,
      segmentExecutionIds: segments.map((segment) => segment.executionId),
      logsByExecutionId: Object.fromEntries(
        Object.entries(logsByExecutionId).map(([executionId, logs]) => [
          executionId,
          logs.length,
        ])
      ),
    });
  }, [
    executions,
    filteredMerged.length,
    logsByExecutionId,
    merged.length,
    rootTaskId,
    runProjection,
    segments,
  ]);

  const humanInputGate = useMemo(() => {
    if (!runProjection) return null;
    for (const node of runProjection.orderedRuns) {
      if (node.run.status !== "waiting") continue;
      const gate = resolveHumanInputGate(node.run, node.executions);
      if (gate) return gate;
    }
    return null;
  }, [runProjection]);

  // Local fallback ref so live-tail effects work even when no scrollRef is
  // forwarded by a parent (kept stable across renders).
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollEl = useCallback(
    (el: HTMLDivElement | null) => {
      internalScrollRef.current = el;
      if (scrollRef) {
        // RefObject with a writable .current — assign through.
        (scrollRef as { current: HTMLDivElement | null }).current = el;
      }
    },
    [scrollRef]
  );

  // Auto-scroll on new events when enabled. Compares against previous total
  // event count so we only scroll on append, not on filter narrowing.
  const lastEventCountRef = useRef(filteredMerged.length);
  useLayoutEffect(() => {
    const prev = lastEventCountRef.current;
    lastEventCountRef.current = filteredMerged.length;
    if (!autoScroll) return;
    if (filteredMerged.length <= prev) return;
    const el = internalScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filteredMerged.length, autoScroll]);

  // Deep-link / activeExecutionId focus: scroll the matching segment into view.
  useEffect(() => {
    const target = focusExecutionId ?? activeExecutionId;
    if (!target) return;
    const root = internalScrollRef.current;
    if (!root) return;
    const node = root.querySelector<HTMLElement>(
      `[data-segment-execution-id="${target}"]`
    );
    if (node?.scrollIntoView) {
      node.scrollIntoView({ behavior: "auto", block: "start" });
    }
  }, [focusExecutionId, activeExecutionId]);

  const toggleTimeMode = useCallback(
    () => setTimeMode((m) => (m === "absolute" ? "differential" : "absolute")),
    []
  );

  const timeModeContextValue = useMemo(
    () => ({ mode: timeMode, toggle: toggleTimeMode }),
    [timeMode, toggleTimeMode]
  );

  if (error) {
    return (
      <div
        data-testid="unified-chat-error"
        className="m-4 rounded border border-error/40 bg-error/10 p-4 text-sm text-error"
      >
        Failed to load conversation: {error}
      </div>
    );
  }

  if (isLoading && segments.length === 0) {
    return (
      <div
        data-testid="unified-chat-loading"
        className="flex h-full items-center justify-center p-8 text-sm text-text-muted"
      >
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-text-muted border-t-transparent" />
        <span className="ml-2">Loading conversation…</span>
      </div>
    );
  }

  const gateNode = humanInputGate ? (
    <div className="px-4 pt-2">
      <HumanInputGate
        context={humanInputGate}
        stoppable={activeRunStoppable}
        isStopping={isStoppingActiveRun}
        onStop={onStopActiveRun}
      />
    </div>
  ) : null;

  if (segments.length === 0) {
    if (gateNode) {
      return (
        <div
          ref={setScrollEl}
          data-testid="unified-chat-view"
          data-auto-scroll={autoScroll ? "1" : "0"}
          className="relative h-full overflow-y-auto bg-bg-primary"
        >
          {gateNode}
          <div
            data-testid="unified-chat-empty"
            className="flex flex-col items-center justify-center p-8 text-center text-sm text-text-muted"
          >
            No conversation yet — run is parked waiting on human input.
          </div>
        </div>
      );
    }
    return (
      <div
        ref={setScrollEl}
        data-testid="unified-chat-view"
        data-auto-scroll={autoScroll ? "1" : "0"}
        className="relative flex h-full flex-col bg-bg-primary"
      >
        <div
          data-testid="unified-chat-empty"
          className="flex flex-1 flex-col items-center justify-center p-8 text-center text-sm text-text-muted"
        >
          No conversation yet across this subtree.
        </div>
      </div>
    );
  }

  return (
    <TimeModeContext.Provider value={timeModeContextValue}>
      <div
        ref={setScrollEl}
        data-testid="unified-chat-view"
        data-auto-scroll={autoScroll ? "1" : "0"}
        className="relative h-full overflow-y-auto bg-bg-primary"
      >
        <div className="flex justify-end px-4 pt-2">
          <span className="text-xs text-text-muted">
            Click timestamps to toggle:{" "}
            {timeMode === "absolute" ? "HH:MM:SS.mmm" : "time after"}
          </span>
        </div>
        {gateNode}
        <div className="px-2 pb-4">
          {segments.map((segment, idx) => {
            const previousSegment = idx > 0 ? segments[idx - 1] : null;
            const exec = executionsById.get(segment.executionId);
            const task = tasksById.get(segment.taskId);

            // Prefer TaskRun-derived depth/grouping; fall back to task-id for
            // segments without a TaskRun (legacy / orphan executions).
            const depthOf = (seg: Segment | null): number => {
              if (seg === null) return 0;
              const runDepth =
                seg.taskRunId !== null
                  ? depthByTaskRunId.get(seg.taskRunId)
                  : undefined;
              return runDepth ?? depthByTaskId.get(seg.taskId) ?? 0;
            };
            const depth = depthOf(segment);

            const sameGroupAsPrev =
              previousSegment !== null &&
              ((segment.taskRunId !== null &&
                previousSegment.taskRunId === segment.taskRunId) ||
                (segment.taskRunId === null &&
                  previousSegment.taskRunId === null &&
                  previousSegment.taskId === segment.taskId));

            const showTransition =
              sameGroupAsPrev &&
              previousSegment!.executionId !== segment.executionId;

            const previousDepth = depthOf(previousSegment);

            const isDelegation =
              previousSegment !== null && !sameGroupAsPrev && depth > previousDepth;

            // Hide the title on root-task segments (page header already shows
            // it); descendants render it as a subtitle so delegations read as
            // "delegated to: ...".
            const taskTitlePlacement =
              segment.taskId === rootTaskId ? "hidden" : "subtitle";
            const facts = segment.sessionFacts;

            // Resolve the workflow tag from the execution's own `workflow_id`
            // so historical executions keep their original workflow label even
            // after the task has been routed into a different workflow. Falls
            // back to the task's current workflow_name only when the workflow
            // can't be resolved (e.g. no workflow list provided, or the
            // execution lacks a workflow_id).
            const execWorkflowId = exec?.workflow_id ?? segment.workflowId;
            const resolvedWorkflowName =
              (execWorkflowId ? workflowNameById.get(execWorkflowId) : null) ??
              task?.workflow_name ??
              null;

            const boundary = (
              <StepBoundary
                executionId={segment.executionId}
                taskId={segment.taskId}
                taskTitle={task?.title ?? null}
                taskTitlePlacement={taskTitlePlacement}
                workflowName={resolvedWorkflowName}
                stepName={segment.stepName}
                startedAt={segment.startedAt}
                model={facts.model ?? exec?.model ?? null}
                costUsd={facts.costUsd ?? parseCost(exec?.cost)}
                durationMs={facts.durationMs ?? exec?.duration_ms ?? null}
                numTurns={facts.numTurns}
                depth={depth}
                prompt={exec?.prompt ?? null}
              />
            );

            const eventList = (
              <div className="space-y-1 px-2">
                {segment.events.map((tagged, i) => {
                  const previousTimestamp =
                    i > 0 ? segment.events[i - 1].event.timestamp : null;
                  return (
                    <div
                      key={`${tagged.executionId}-${tagged.eventIndex}-${i}`}
                      data-testid="unified-chat-event"
                      data-execution-id={tagged.executionId}
                      data-task-id={tagged.taskId}
                    >
                      <EventRenderer
                        event={tagged.event}
                        previousTimestamp={previousTimestamp}
                        level={task?.level ?? null}
                      />
                    </div>
                  );
                })}
              </div>
            );

            const sectionContent = (
              <>
                {boundary}
                {eventList}
              </>
            );

            const isActive = activeExecutionId === segment.executionId;
            return (
              <div
                key={segment.executionId}
                data-testid="unified-chat-segment"
                data-segment-execution-id={segment.executionId}
                data-segment-task-id={segment.taskId}
                data-segment-task-run-id={segment.taskRunId ?? undefined}
                data-active={isActive ? "1" : "0"}
                className={
                  isActive
                    ? "rounded ring-2 ring-accent-primary/60"
                    : undefined
                }
              >
                {showTransition && (
                  <TransitionMarker
                    fromStep={previousSegment?.stepName ?? null}
                    toStep={segment.stepName}
                    taskId={segment.taskId}
                  />
                )}
                {isDelegation ? (
                  <DelegationBlock
                    parentTaskId={previousSegment!.taskId}
                    childTaskId={segment.taskId}
                    childTaskTitle={task?.title ?? null}
                    depth={Math.max(depth, 1)}
                  >
                    {sectionContent}
                  </DelegationBlock>
                ) : (
                  sectionContent
                )}
              </div>
            );
          })}
        </div>
      </div>
    </TimeModeContext.Provider>
  );
}
