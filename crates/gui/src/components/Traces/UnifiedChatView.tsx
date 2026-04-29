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

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { SessionLog, StepExecution, Task } from "../../bindings";
import {
  mergeExecutionEvents,
  type TaggedConversationEvent,
} from "../../types/conversation";
import { useSubtreeSessionLogs } from "../../hooks/useSubtreeSessionLogs";
import {
  EventRenderer,
  TimeModeContext,
  type TimeMode,
} from "./conversation/EventRenderer";
import { StepBoundary } from "./conversation/StepBoundary";
import { TransitionMarker } from "./conversation/TransitionMarker";
import { DelegationBlock } from "./conversation/DelegationBlock";

interface UnifiedChatViewProps {
  rootTaskId: string;
  executions: readonly StepExecution[];
  tasks: readonly Task[];
  /** Optional: pass logs in directly (used by tests); otherwise fetched. */
  logsByExecutionId?: Record<string, SessionLog[]>;
  isLoading?: boolean;
  error?: string | null;
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

interface Segment {
  executionId: string;
  taskId: string;
  workflowId: string | null;
  stepName: string | null;
  startedAt: string | null;
  events: TaggedConversationEvent[];
}

/** Group consecutive tagged events by executionId, preserving order. */
function groupByExecution(events: TaggedConversationEvent[]): Segment[] {
  const segments: Segment[] = [];
  for (const tagged of events) {
    const last = segments[segments.length - 1];
    if (last && last.executionId === tagged.executionId) {
      last.events.push(tagged);
      continue;
    }
    segments.push({
      executionId: tagged.executionId,
      taskId: tagged.taskId,
      workflowId: tagged.workflowId,
      stepName: tagged.stepName,
      startedAt: tagged.executionStartedAt,
      events: [tagged],
    });
  }
  return segments;
}

export function UnifiedChatView({
  rootTaskId,
  executions,
  tasks,
  logsByExecutionId: providedLogs,
  isLoading: externalLoading,
  error: externalError,
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

  const depthByTaskId = useMemo(
    () => buildDepthMap(rootTaskId, tasksById),
    [rootTaskId, tasksById]
  );

  const merged = useMemo(
    () => mergeExecutionEvents(executions, logsByExecutionId),
    [executions, logsByExecutionId]
  );
  const segments = useMemo(() => groupByExecution(merged), [merged]);

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

  if (segments.length === 0) {
    return (
      <div
        data-testid="unified-chat-empty"
        className="flex h-full flex-col items-center justify-center p-8 text-center text-sm text-text-muted"
      >
        No conversation yet across this subtree.
      </div>
    );
  }

  return (
    <TimeModeContext.Provider value={timeModeContextValue}>
      <div
        data-testid="unified-chat-view"
        className="relative h-full overflow-y-auto bg-bg-primary"
      >
        <div className="flex justify-end px-4 pt-2">
          <span className="text-[10px] text-text-muted">
            Click timestamps to toggle:{" "}
            {timeMode === "absolute" ? "HH:MM:SS.mmm" : "time before"}
          </span>
        </div>
        <div className="px-2 pb-4">
          {segments.map((segment, idx) => {
            const previousSegment = idx > 0 ? segments[idx - 1] : null;
            const exec = executionsById.get(segment.executionId);
            const task = tasksById.get(segment.taskId);
            const depth = depthByTaskId.get(segment.taskId) ?? 0;

            const showTransition =
              previousSegment !== null &&
              previousSegment.taskId === segment.taskId &&
              previousSegment.executionId !== segment.executionId;

            const isDelegation =
              previousSegment !== null &&
              previousSegment.taskId !== segment.taskId &&
              depth > (depthByTaskId.get(previousSegment.taskId) ?? 0);

            const boundary = (
              <StepBoundary
                executionId={segment.executionId}
                taskId={segment.taskId}
                taskTitle={task?.title ?? null}
                workflowName={task?.workflow_name ?? null}
                stepName={segment.stepName}
                startedAt={segment.startedAt}
                model={exec?.model ?? null}
                costUsd={exec?.cost ?? null}
                depth={depth}
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

            return (
              <div key={segment.executionId}>
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
