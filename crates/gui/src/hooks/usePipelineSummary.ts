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

export function usePipelineSummary() {
  const projectScopeGeneration = useProjectScopeGeneration();
  const eventEpochRef = useRef(0);
  const queryKey = useMemo(
    () => queryKeys.pipelineSummary(projectScopeGeneration),
    [projectScopeGeneration]
  );
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      while (true) {
        const eventEpoch = eventEpochRef.current;
        const summary = await unwrapCommand(commands.getPipelineSummary());
        if (
          projectScopeGeneration !== getProjectScopeGeneration() ||
          eventEpoch === eventEpochRef.current
        ) {
          return summary;
        }
      }
    },
  });
  const refetch = query.refetch;

  const wsStatus = useWebSocketStatus();
  const prevWsStatus = useRef(wsStatus);

  // Always refetch on (re)connect. A disconnect window may have dropped
  // deltas, so applying new events to the old buckets would compound drift.
  useEffect(() => {
    const wasDown =
      prevWsStatus.current === "reconnecting" ||
      prevWsStatus.current === "disconnected";
    if (wsStatus === "connected" && wasDown) {
      void refetch();
    }
    prevWsStatus.current = wsStatus;
  }, [wsStatus, refetch]);

  useEffect(() => {
    let cancelled = false;
    const isStale = () =>
      cancelled || projectScopeGeneration !== getProjectScopeGeneration();
    const applyToCache = (
      reducer: (summary: PipelineSummary) => PipelineSummary
    ) => {
      if (isStale()) return;
      queryClient.setQueryData<PipelineSummary>(queryKey, (summary) =>
        summary ? reducer(summary) : summary
      );
      eventEpochRef.current += 1;
    };
    const invalidateSummary = () => {
      if (isStale()) return;
      eventEpochRef.current += 1;
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
        if (change_type === "Created") {
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

  return {
    summary: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => {
      void refetch();
    },
  };
}

export type { PipelineSummary, PipelineWorkflow, PipelineStep };
