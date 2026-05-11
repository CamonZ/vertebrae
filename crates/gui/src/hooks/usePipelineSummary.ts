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

// If the tab was hidden for less than this, the live WS stream is reliable
// enough that a refetch on visibility-change is wasted work.
const STALE_AFTER_HIDDEN_MS = 30_000;

export function usePipelineSummary() {
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasSummaryRef = useRef(false);
  const isFetchInFlightRef = useRef(false);
  const hasPendingFetchRef = useRef(false);

  const wsStatus = useWebSocketStatus();
  const prevWsStatus = useRef(wsStatus);

  const loadSummary = useCallback(async () => {
    const projectScopeGeneration = getProjectScopeGeneration();

    try {
      const result = await commands.getPipelineSummary();
      if (!isCurrentProjectScopeGeneration(projectScopeGeneration)) return;

      if (result.status === "ok") {
        setSummary(result.data);
        hasSummaryRef.current = true;
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
  }, []);

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

  useEffect(() => {
    const wasDown =
      prevWsStatus.current === "reconnecting" ||
      prevWsStatus.current === "disconnected" ||
      prevWsStatus.current === "connecting";
    if (wsStatus === "connected" && wasDown && hasSummaryRef.current) {
      void fetchSummary();
    }
    prevWsStatus.current = wsStatus;
  }, [wsStatus, fetchSummary]);

  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const elapsed = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (elapsed >= STALE_AFTER_HIDDEN_MS) {
        void fetchSummary();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchSummary]);

  useEffect(() => {
    // Sacrum does not currently emit a compact "pipeline aggregate changed"
    // event. These entity events are the authoritative invalidation signals for
    // task buckets, active TaskRun buckets, graph topology, and workflow edges.
    const unlistenPromises = [
      events.taskChangedEvent.listen(() => {
        void fetchSummary();
      }),
      events.taskRunChangedEvent.listen(() => {
        void fetchSummary();
      }),
      events.stepChangedEvent.listen(() => {
        void fetchSummary();
      }),
      events.workflowTransitionChangedEvent.listen(() => {
        void fetchSummary();
      }),
    ];

    return () => {
      unlistenPromises.forEach((promise) => {
        promise.then((unlisten) => unlisten());
      });
    };
  }, [fetchSummary]);

  return {
    summary,
    isLoading,
    error,
    refetch: fetchSummary,
  };
}

export type { PipelineSummary, PipelineWorkflow, PipelineStep };
