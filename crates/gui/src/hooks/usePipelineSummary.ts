import { useCallback, useEffect, useRef, useState } from "react";
import {
  commands,
  events,
  type PipelineSummary,
  type PipelineWorkflow,
  type PipelineStep,
} from "../bindings";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
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
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const summaryRef = useRef<PipelineSummary | null>(null);
  const isFetchInFlightRef = useRef(false);
  const hasPendingFetchRef = useRef(false);

  const wsStatus = useWebSocketStatus();
  const prevWsStatus = useRef(wsStatus);

  const commitSummary = useCallback((next: PipelineSummary) => {
    if (next === summaryRef.current) return;
    summaryRef.current = next;
    setSummary(next);
  }, []);

  const loadSummary = useCallback(async () => {
    const projectScopeGeneration = getProjectScopeGeneration();

    try {
      const result = await commands.getPipelineSummary();
      if (!isCurrentProjectScopeGeneration(projectScopeGeneration)) return;

      if (result.status === "ok") {
        commitSummary(result.data);
        setError(null);
      } else {
        setError(result.error.message);
      }
    } catch (e) {
      if (isCurrentProjectScopeGeneration(projectScopeGeneration)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (isCurrentProjectScopeGeneration(projectScopeGeneration)) {
        setIsLoading(false);
      }
    }
  }, [commitSummary]);

  const fetchSummary = useCallback(async () => {
    if (isFetchInFlightRef.current) {
      hasPendingFetchRef.current = true;
      return;
    }

    isFetchInFlightRef.current = true;
    try {
      do {
        hasPendingFetchRef.current = false;
        await loadSummary();
      } while (hasPendingFetchRef.current);
    } finally {
      isFetchInFlightRef.current = false;
    }
  }, [loadSummary]);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  // Always refetch on (re)connect, regardless of whether prior data exists.
  // A disconnect window may have dropped events; resuming with stale buckets
  // and applying deltas on top would compound drift.
  useEffect(() => {
    const wasDown =
      prevWsStatus.current === "reconnecting" ||
      prevWsStatus.current === "disconnected";
    if (wsStatus === "connected" && wasDown) {
      void fetchSummary();
    }
    prevWsStatus.current = wsStatus;
  }, [wsStatus, fetchSummary]);

  useEffect(() => {
    let cancelled = false;
    const unlistenPromises = [
      events.taskChangedEvent.listen((event) => {
        if (cancelled || !summaryRef.current) return;
        const { change_type, task } = event.payload;
        if (change_type === "Created" && task) {
          commitSummary(applyTaskCreated(summaryRef.current, task));
          return;
        }
        if (change_type === "Updated") {
          commitSummary(applyTaskUpdated(summaryRef.current));
          return;
        }
        if (change_type === "Deleted") {
          commitSummary(applyTaskDeleted(summaryRef.current, event.payload));
        }
      }),
      events.taskStepChangedEvent.listen((event) => {
        if (cancelled || !summaryRef.current) return;
        commitSummary(applyTaskStepChanged(summaryRef.current, event.payload));
      }),
      events.taskRunStepChangedEvent.listen((event) => {
        if (cancelled || !summaryRef.current) return;
        commitSummary(
          applyTaskRunStepChanged(summaryRef.current, event.payload),
        );
      }),
      events.stepChangedEvent.listen((event) => {
        if (cancelled || !summaryRef.current) return;
        const { change_type, step, step_id, workflow_id } = event.payload;
        if ((change_type === "Created" || change_type === "Updated") && step) {
          const apply =
            change_type === "Created" ? applyStepCreated : applyStepUpdated;
          commitSummary(apply(summaryRef.current, step));
          return;
        }
        if (change_type === "Deleted") {
          commitSummary(
            applyStepDeleted(summaryRef.current, step_id, workflow_id),
          );
        }
      }),
      events.stepTransitionChangedEvent.listen((event) => {
        if (cancelled || !summaryRef.current) return;
        const { change_type } = event.payload;
        if (change_type === "Created") {
          commitSummary(
            applyStepTransitionCreated(summaryRef.current, event.payload),
          );
          return;
        }
        if (change_type === "Deleted") {
          commitSummary(
            applyStepTransitionDeleted(summaryRef.current, event.payload),
          );
        }
      }),
      events.workflowChangedEvent.listen((event) => {
        if (cancelled || !summaryRef.current) return;
        const { change_type, workflow, workflow_id } = event.payload;
        if (change_type === "Created" && workflow) {
          commitSummary(applyWorkflowCreated(summaryRef.current, workflow));
          return;
        }
        if (change_type === "Updated" && workflow) {
          commitSummary(applyWorkflowUpdated(summaryRef.current, workflow));
          return;
        }
        if (change_type === "Deleted") {
          commitSummary(applyWorkflowDeleted(summaryRef.current, workflow_id));
        }
      }),
      events.workflowTransitionChangedEvent.listen((event) => {
        if (cancelled || !summaryRef.current) return;
        const { change_type } = event.payload;
        if (change_type === "Created") {
          commitSummary(
            applyWorkflowTransitionCreated(
              summaryRef.current,
              event.payload,
            ),
          );
          return;
        }
        if (change_type === "Deleted") {
          commitSummary(
            applyWorkflowTransitionDeleted(
              summaryRef.current,
              event.payload,
            ),
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
  }, [commitSummary, fetchSummary]);

  return {
    summary,
    isLoading,
    error,
    refetch: fetchSummary,
  };
}

export type { PipelineSummary, PipelineWorkflow, PipelineStep };
