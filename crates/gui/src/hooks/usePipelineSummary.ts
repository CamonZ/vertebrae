import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  commands,
  events,
  type PipelineSummary,
  type PipelineWorkflow,
  type PipelineStep,
} from "../bindings";
import { errorMessage, queryClient, queryKeys, unwrapCommand } from "../query";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { useWebSocketStatus } from "./useWebSocketStatus";
import {
  applyStepCreated,
  applyStepDeleted,
  applyStepTransitionCreated,
  applyStepTransitionDeleted,
  applyStepUpdated,
  applyTaskCreated,
  applyTaskDeleted,
  applyTaskRunStepChanged,
  applyTaskStepChanged,
  applyTaskUpdated,
  applyWorkflowCreated,
  applyWorkflowDeleted,
  applyWorkflowTransitionCreated,
  applyWorkflowTransitionDeleted,
  applyWorkflowUpdated,
} from "./pipelineSummaryReducer";

/** Fetches per summary query before an overlapping event stream is accepted. */
export const MAX_SUMMARY_FETCH_ATTEMPTS = 3;

/**
 * Bumped whenever an event changes (or would change) the cached summary. A
 * fetch that overlaps a bump may predate that event, so it is retried, at most
 * `MAX_SUMMARY_FETCH_ATTEMPTS` times so a steady event stream cannot keep the
 * summary refetching.
 */
let summaryEventEpoch = 0;

async function fetchPipelineSummary(
  projectScopeGeneration: number
): Promise<PipelineSummary> {
  for (let attempt = 1; ; attempt++) {
    const eventEpoch = summaryEventEpoch;
    const summary = await unwrapCommand(commands.getPipelineSummary());
    if (
      projectScopeGeneration !== getProjectScopeGeneration() ||
      eventEpoch === summaryEventEpoch ||
      attempt >= MAX_SUMMARY_FETCH_ATTEMPTS
    ) {
      return summary;
    }
  }
}

export function usePipelineSummary() {
  const projectScopeGeneration = useProjectScopeGeneration();
  const query = useQuery({
    queryKey: queryKeys.pipelineSummary(projectScopeGeneration),
    queryFn: () => fetchPipelineSummary(projectScopeGeneration),
  });
  const refetch = query.refetch;

  return {
    summary: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void refetch();
    },
  };
}

/**
 * Keeps the cached pipeline summary in step with realtime events. Mounted once
 * in `GlobalListeners`: the summary is cached with an infinite stale time, so
 * events must reach it while no Atlas surface is mounted, or returning to the
 * Atlas would show the summary as it was when the Atlas was left.
 */
export function usePipelineSummarySync() {
  const projectScopeGeneration = useProjectScopeGeneration();
  const queryKey = useMemo(
    () => queryKeys.pipelineSummary(projectScopeGeneration),
    [projectScopeGeneration]
  );

  const wsStatus = useWebSocketStatus();
  const prevWsStatus = useRef(wsStatus);

  // Always refetch on (re)connect. A disconnect window may have dropped
  // deltas, so applying new events to the old buckets would compound drift.
  useEffect(() => {
    const wasDown =
      prevWsStatus.current === "reconnecting" ||
      prevWsStatus.current === "disconnected";
    if (wsStatus === "connected" && wasDown) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
    prevWsStatus.current = wsStatus;
  }, [wsStatus, queryKey]);

  useEffect(() => {
    let cancelled = false;
    const isStale = () =>
      cancelled || projectScopeGeneration !== getProjectScopeGeneration();
    const applyToCache = (
      reducer: (summary: PipelineSummary) => PipelineSummary
    ) => {
      if (isStale()) return;
      const current = queryClient.getQueryData<PipelineSummary>(queryKey);
      if (!current) {
        // Nothing cached yet; a fetch in flight may predate this event.
        summaryEventEpoch += 1;
        return;
      }
      const next = reducer(current);
      if (next === current) return;
      queryClient.setQueryData<PipelineSummary>(queryKey, next);
      summaryEventEpoch += 1;
    };
    const invalidateSummary = () => {
      if (isStale()) return;
      summaryEventEpoch += 1;
      void queryClient.invalidateQueries({ queryKey, exact: true });
    };
    const unlistenPromises = [
      events.taskChangedEvent.listen((event) => {
        const { change_type, task } = event.payload;
        if (change_type === "Created" && task) {
          applyToCache((summary) => applyTaskCreated(summary, task));
          return;
        }
        if (change_type === "Updated") {
          const { previous } = event.payload;
          if (!task || !previous) return;
          const changesSummaryBucket =
            previous.archived !== undefined ||
            previous.level !== undefined;
          if (!changesSummaryBucket) return;
          if (previous.current_step_id !== undefined) {
            invalidateSummary();
            return;
          }
          applyToCache((summary) => applyTaskUpdated(summary, event.payload));
          return;
        }
        if (change_type === "Deleted") {
          applyToCache((summary) => applyTaskDeleted(summary, event.payload));
        }
      }),
      events.taskStepChangedEvent.listen((event) => {
        applyToCache((summary) => applyTaskStepChanged(summary, event.payload));
      }),
      events.taskRunStepChangedEvent.listen((event) => {
        applyToCache((summary) =>
          applyTaskRunStepChanged(summary, event.payload)
        );
      }),
      events.stepChangedEvent.listen((event) => {
        const { change_type, step, step_id, workflow_id } = event.payload;
        if ((change_type === "Created" || change_type === "Updated") && step) {
          const apply =
            change_type === "Created" ? applyStepCreated : applyStepUpdated;
          applyToCache((summary) => apply(summary, step));
          return;
        }
        if (change_type === "Deleted") {
          applyToCache((summary) =>
            applyStepDeleted(summary, step_id, workflow_id)
          );
        }
      }),
      events.stepTransitionChangedEvent.listen((event) => {
        const { change_type } = event.payload;
        if (change_type === "Created" || change_type === "Updated") {
          applyToCache((summary) =>
            applyStepTransitionCreated(summary, event.payload)
          );
          return;
        }
        if (change_type === "Deleted") {
          applyToCache((summary) =>
            applyStepTransitionDeleted(summary, event.payload)
          );
        }
      }),
      events.workflowChangedEvent.listen((event) => {
        const { change_type, workflow, workflow_id } = event.payload;
        if (change_type === "Created" && workflow) {
          applyToCache((summary) => applyWorkflowCreated(summary, workflow));
          return;
        }
        if (change_type === "Updated" && workflow) {
          applyToCache((summary) => applyWorkflowUpdated(summary, workflow));
          return;
        }
        if (change_type === "Deleted") {
          applyToCache((summary) =>
            applyWorkflowDeleted(summary, workflow_id)
          );
        }
      }),
      events.workflowTransitionChangedEvent.listen((event) => {
        const { change_type } = event.payload;
        if (change_type === "Created") {
          applyToCache((summary) =>
            applyWorkflowTransitionCreated(summary, event.payload)
          );
          return;
        }
        if (change_type === "Deleted") {
          applyToCache((summary) =>
            applyWorkflowTransitionDeleted(summary, event.payload)
          );
        }
      }),
    ];

    return () => {
      cancelled = true;
      unlistenPromises.forEach((promise) => {
        void promise.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, [projectScopeGeneration, queryKey]);
}

export type { PipelineSummary, PipelineWorkflow, PipelineStep };
