/**
 * UnifiedChatView — THREAD mode of /traces/:taskId.
 *
 * Renders ONE continuous scroll surface containing all session-log events
 * across every execution in the subtree, ordered chronologically.
 *
 * The conversation surface is shaped as a chat: each StepExecution.prompt
 * renders as a USER bubble (copper wash, right-aligned), each assistant turn
 * renders as an AGENT bubble (left-aligned, neutral). Tool calls + tool
 * results that follow an assistant turn collapse INTO that bubble as
 * `ToolCallBlock` children, so the user can read the conversation as a
 * sequence of turns rather than a flat list of sibling events.
 *
 * Workflow / step boundaries become thin centered dividers ("— STEP · ▶ EXECUTE ·
 * 4m ago —"); consecutive executions on the same task get a TransitionMarker;
 * events from descendant tasks (child task activated by a parent step) are
 * visually nested in a DelegationBlock with their own divider header.
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
  type AssistantMessageEvent,
  type ConversationEvent,
  type TaggedConversationEvent,
  type ThinkingEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "../../types/conversation";
import { useSubtreeSessionLogs } from "../../hooks/useSubtreeSessionLogs";
import { parseCost } from "../../utils";
import { ChatMessage } from "../molecules/ChatMessage";
import { ToolCallBlock } from "../molecules/ToolCallBlock";
import { MarkdownContent } from "../shared/MarkdownContent";
import {
  EventRenderer,
  TimeModeContext,
  formatTimeWithMs,
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
   * execution's StepBoundary divider. The tag must reflect the workflow the
   * execution actually ran under (via `StepExecution.workflow_id`), not the
   * task's current workflow — a task that started in Backlog and was routed
   * into Implementation should still show BACKLOG on its early executions.
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
  /** Optional predicate to filter merged events. Empty segments are dropped. */
  eventFilter?: (tagged: TaggedConversationEvent) => boolean;
  /** Optional predicate to filter executions before merging. */
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
  model: string | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
}

interface Segment {
  executionId: string;
  taskId: string;
  taskRunId: string | null;
  workflowId: string | null;
  stepName: string | null;
  startedAt: string | null;
  /** Renderable events only — `session_start` / `session_end` are folded into `sessionFacts`. */
  events: TaggedConversationEvent[];
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

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------
//
// A segment's flat event list is regrouped into "turn entries" for rendering:
//
//   - `agent`  — one assistant_message, plus any preceding `thinking` events
//                (preamble) and the immediately following tool_call/tool_result
//                run (children). Renders as one ChatMessage bubble with
//                ToolCallBlock children.
//   - `event`  — a standalone event that doesn't belong inside an agent
//                bubble (file_edit, todo_list, or an orphan thinking before
//                any assistant_message has opened a turn). Renders via the
//                existing EventRenderer.
//
// Tool results are paired with their parent tool_call by `toolUseId` /
// `toolId`. Unpaired tool_results fall through as standalone events.

interface PendingToolCall {
  call: ToolCallEvent;
  result: ToolResultEvent | null;
}

interface AgentTurn {
  kind: "agent";
  assistant: AssistantMessageEvent;
  preamble: ThinkingEvent[];
  tools: PendingToolCall[];
}

interface StandaloneEntry {
  kind: "event";
  event: ConversationEvent;
  previousTimestamp: string | null;
}

interface StandaloneToolEntry {
  kind: "standalone_tool";
  call: ToolCallEvent;
  result: ToolResultEvent | null;
  previousTimestamp: string | null;
}

type TurnEntry = AgentTurn | StandaloneEntry | StandaloneToolEntry;

/**
 * Walk a segment's renderable events linearly and produce a list of
 * `TurnEntry` items the renderer can iterate.
 */
function groupIntoTurns(events: TaggedConversationEvent[]): TurnEntry[] {
  const turns: TurnEntry[] = [];
  let pendingPreamble: ThinkingEvent[] = [];
  let activeTurn: AgentTurn | null = null;

  const flushPreamble = (): void => {
    if (pendingPreamble.length === 0) return;
    for (let i = 0; i < pendingPreamble.length; i++) {
      const ev = pendingPreamble[i];
      const prev = i > 0 ? pendingPreamble[i - 1].timestamp : null;
      turns.push({ kind: "event", event: ev, previousTimestamp: prev });
    }
    pendingPreamble = [];
  };

  for (let i = 0; i < events.length; i++) {
    const tagged = events[i];
    const ev = tagged.event;
    const prevTs = i > 0 ? events[i - 1].event.timestamp : null;

    if (ev.kind === "thinking") {
      if (activeTurn) {
        // A thinking event after an open agent turn opens a new turn (the
        // model went back to reasoning). Flush the active turn first.
        activeTurn = null;
      }
      pendingPreamble.push(ev);
      continue;
    }

    if (ev.kind === "assistant_message") {
      activeTurn = {
        kind: "agent",
        assistant: ev,
        preamble: pendingPreamble,
        tools: [],
      };
      pendingPreamble = [];
      turns.push(activeTurn);
      continue;
    }

    if (ev.kind === "tool_call") {
      // Tool calls attach to the active agent turn. If there isn't one (the
      // assistant turn hasn't opened yet — e.g. Codex-style sessions that
      // fire tool calls before any assistant_message), emit a standalone_tool
      // entry that can still pair with its tool_result later.
      if (activeTurn) {
        activeTurn.tools.push({ call: ev, result: null });
      } else {
        flushPreamble();
        turns.push({
          kind: "standalone_tool",
          call: ev,
          result: null,
          previousTimestamp: prevTs,
        });
      }
      continue;
    }

    if (ev.kind === "tool_result") {
      // Pair with the latest unfilled tool_call in the active turn.
      if (activeTurn) {
        const pending = [...activeTurn.tools]
          .reverse()
          .find((t) => t.result === null && t.call.toolId === ev.toolUseId);
        if (pending) {
          pending.result = ev;
          continue;
        }
        // Same-turn tool_result with no matching call id — still attach to
        // the most-recent unfilled slot so the result renders alongside.
        const lastOpen = [...activeTurn.tools]
          .reverse()
          .find((t) => t.result === null);
        if (lastOpen) {
          lastOpen.result = ev;
          continue;
        }
      }
      // No active turn — try to pair with an earlier unfilled tool_call,
      // either a standalone one or one inside a previously-closed agent turn.
      if (fillUnfilledToolAnywhere(turns, ev)) {
        continue;
      }
      flushPreamble();
      turns.push({ kind: "event", event: ev, previousTimestamp: prevTs });
      continue;
    }

    // file_edit, todo_list, anything else — render standalone.
    flushPreamble();
    activeTurn = null;
    turns.push({ kind: "event", event: ev, previousTimestamp: prevTs });
  }

  // Trailing thinking events with no closing assistant turn.
  flushPreamble();
  return turns;
}

function toolCallState(
  result: ToolResultEvent | null
): "pending" | "success" | "error" {
  if (!result) return "pending";
  return result.isError ? "error" : "success";
}

/**
 * Walk turns backwards and fill the first unfilled tool slot matching the
 * result. Prefers an exact toolUseId match; falls back to the most recent
 * unfilled slot of any kind. Handles both standalone tools and tools inside
 * a previously-closed agent turn (the model started thinking again before
 * its tool_result arrived).
 */
function fillUnfilledToolAnywhere(
  turns: TurnEntry[],
  result: ToolResultEvent
): boolean {
  let fallback: PendingToolCall | StandaloneToolEntry | null = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.kind === "standalone_tool") {
      if (t.result !== null) continue;
      if (t.call.toolId === result.toolUseId) {
        t.result = result;
        return true;
      }
      if (!fallback) fallback = t;
    } else if (t.kind === "agent") {
      for (let j = t.tools.length - 1; j >= 0; j--) {
        const pt = t.tools[j];
        if (pt.result !== null) continue;
        if (pt.call.toolId === result.toolUseId) {
          pt.result = result;
          return true;
        }
        if (!fallback) fallback = pt;
      }
    }
  }
  if (fallback) {
    fallback.result = result;
    return true;
  }
  return false;
}

function formatToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
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

  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollEl = useCallback(
    (el: HTMLDivElement | null) => {
      internalScrollRef.current = el;
      if (scrollRef) {
        (scrollRef as { current: HTMLDivElement | null }).current = el;
      }
    },
    [scrollRef]
  );

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
        className="m-4 rounded-[var(--radius-md)] border border-[var(--color-err)]/40 bg-[var(--color-err-wash)] p-4 text-sm text-[var(--color-err)]"
      >
        Failed to load conversation: {error}
      </div>
    );
  }

  if (isLoading && segments.length === 0) {
    return (
      <div
        data-testid="unified-chat-loading"
        className="flex h-full items-center justify-center p-8 text-sm text-[var(--color-fg-mute)]"
      >
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-fg-mute)] border-t-transparent" />
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
          className="relative h-full overflow-x-hidden overflow-y-auto bg-[var(--color-bg)]"
        >
          {gateNode}
          <div
            data-testid="unified-chat-empty"
            className="flex flex-col items-center justify-center p-8 text-center text-sm text-[var(--color-fg-mute)]"
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
        className="relative flex h-full flex-col bg-[var(--color-bg)]"
      >
        <div
          data-testid="unified-chat-empty"
          className="flex flex-1 flex-col items-center justify-center p-8 text-center text-sm text-[var(--color-fg-mute)]"
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
        className="relative h-full overflow-x-hidden overflow-y-auto bg-[var(--color-bg)]"
      >
        <div className="flex justify-end px-4 pt-2">
          <span className="text-[10px] text-[var(--color-fg-mute)]">
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

            const taskTitlePlacement =
              segment.taskId === rootTaskId ? "hidden" : "subtitle";
            const facts = segment.sessionFacts;

            const execWorkflowId = exec?.workflow_id ?? segment.workflowId;
            const resolvedWorkflowName =
              (execWorkflowId ? workflowNameById.get(execWorkflowId) : null) ??
              task?.workflow_name ??
              null;

            const promptText = exec?.prompt?.trim() ?? "";
            const model = facts.model ?? exec?.model ?? null;

            const boundary = (
              <StepBoundary
                executionId={segment.executionId}
                taskId={segment.taskId}
                taskTitle={task?.title ?? null}
                taskTitlePlacement={taskTitlePlacement}
                workflowName={resolvedWorkflowName}
                stepName={segment.stepName}
                startedAt={segment.startedAt}
                model={model}
                costUsd={facts.costUsd ?? parseCost(exec?.cost)}
                durationMs={facts.durationMs ?? exec?.duration_ms ?? null}
                numTurns={facts.numTurns}
                depth={depth}
              />
            );

            const turns = groupIntoTurns(segment.events);

            const turnNodes: ReactNode[] = [];

            // Surface the execution prompt as a USER bubble before the
            // assistant turns. Empty / whitespace-only prompts are skipped
            // so we don't render a hollow bubble.
            if (promptText.length > 0) {
              turnNodes.push(
                <div
                  key={`prompt-${segment.executionId}`}
                  data-testid="unified-chat-user-bubble"
                  data-execution-id={segment.executionId}
                  className="my-2 px-2"
                >
                  <ChatMessage
                    role="user"
                    author="USER"
                    timestamp={
                      segment.startedAt
                        ? formatTimeWithMs(segment.startedAt)
                        : undefined
                    }
                  >
                    <MarkdownContent text={promptText} />
                  </ChatMessage>
                </div>
              );
            }

            for (let i = 0; i < turns.length; i++) {
              const turn = turns[i];

              if (turn.kind === "agent") {
                turnNodes.push(
                  <div
                    key={`agent-${segment.executionId}-${i}`}
                    data-testid="unified-chat-agent-bubble"
                    data-execution-id={segment.executionId}
                    data-task-id={segment.taskId}
                    className="my-2 px-2"
                  >
                    <ChatMessage
                      role="assistant"
                      author={model ? `AGENT · ${model}` : "AGENT"}
                      timestamp={formatTimeWithMs(turn.assistant.timestamp)}
                    >
                      {turn.preamble.length > 0 && (
                        <div
                          data-testid="agent-bubble-preamble"
                          className="mb-2 border-l-2 border-[var(--color-line)] pl-2 text-[var(--color-fg-mute)]"
                        >
                          {turn.preamble.map((t, k) => (
                            <div key={k} className="py-0.5">
                              <MarkdownContent text={t.text} />
                            </div>
                          ))}
                        </div>
                      )}
                      <MarkdownContent text={turn.assistant.text} />
                      {turn.tools.map((t, k) => {
                        const state = toolCallState(t.result);
                        return (
                          <ToolCallBlock
                            key={`${t.call.toolId}-${k}`}
                            toolName={t.call.displayName ?? t.call.toolName}
                            summary={t.call.summary}
                            state={state}
                            input={formatToolInput(t.call.input)}
                            result={t.result?.result}
                          />
                        );
                      })}
                    </ChatMessage>
                  </div>
                );
                continue;
              }

              if (turn.kind === "standalone_tool") {
                const state = toolCallState(turn.result);
                turnNodes.push(
                  <div
                    key={`standalone-tool-${segment.executionId}-${i}`}
                    data-testid="unified-chat-standalone-tool"
                    data-execution-id={segment.executionId}
                    data-task-id={segment.taskId}
                    data-state={state}
                    className="px-2"
                  >
                    <ToolCallBlock
                      toolName={turn.call.displayName ?? turn.call.toolName}
                      summary={turn.call.summary}
                      state={state}
                      input={formatToolInput(turn.call.input)}
                      result={turn.result?.result}
                    />
                  </div>
                );
                continue;
              }

              // Standalone event (file_edit / todo_list / orphan thinking).
              // Render via the existing EventRenderer.
              turnNodes.push(
                <div
                  key={`event-${segment.executionId}-${i}`}
                  data-testid="unified-chat-event"
                  data-execution-id={segment.executionId}
                  data-task-id={segment.taskId}
                  className="px-2"
                >
                  <EventRenderer
                    event={turn.event}
                    previousTimestamp={turn.previousTimestamp}
                    level={task?.level ?? null}
                  />
                </div>
              );
            }

            const sectionContent = (
              <>
                {boundary}
                <div className="space-y-1">{turnNodes}</div>
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
                    ? "rounded-[var(--radius-md)] ring-2 ring-[var(--color-accent)]/60"
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
