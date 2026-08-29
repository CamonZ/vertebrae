import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  events,
  type SessionLogCreatedEvent,
  type SessionLogUpdatedEvent,
} from "../bindings";
import { useSessionLogStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  createSessionLogEventQueue,
  isUrgentSessionLog,
} from "../utils/sessionLogEventQueue";
import {
  makeSessionLogPerformanceCorrelation,
  sessionLogPerformance,
} from "../utils/sessionLogPerformance";

/** Options for the session log change listener hook */
interface UseSessionLogChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to session log Tauri events and writes incoming logs
 * directly to the sessionLogStore. Created events append new rows; updated
 * events upsert rows by id or logical_key. Consumers read logs from the store
 * rather than via callbacks.
 *
 * @param options - Configuration options for the listener
 */
export function useSessionLogChangeListener(
  options: UseSessionLogChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const projectScopeGeneration = useProjectScopeGeneration();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;
    const projectScope = String(projectScopeGeneration);
    const isCurrentScope = () =>
      !disposed && projectScopeGeneration === getProjectScopeGeneration();
    const monitor = sessionLogPerformance;
    const queue = createSessionLogEventQueue({
      onFlush: (queuedEvents) => {
        if (!isCurrentScope()) return;
        const startedAt =
          monitor.enabled && typeof performance !== "undefined"
            ? performance.now()
            : 0;
        useSessionLogStore.getState().applyLogBatch(
          queuedEvents.map(({ executionId, log, operation }) => ({
            executionId,
            log,
            operation,
          }))
        );
        if (!monitor.enabled) return;
        const durationMs =
          typeof performance !== "undefined"
            ? Math.max(0, performance.now() - startedAt)
            : 0;
        monitor.recordFlush({ projectScope }, queuedEvents.length, durationMs);
        for (const queuedEvent of queuedEvents) {
          if (queuedEvent.correlation) {
            monitor.recordVisible(queuedEvent.correlation);
          }
        }
      },
      onQueued: (queuedEvent, pendingCount) => {
        if (monitor.enabled) {
          monitor.recordQueued(
            {
              projectScope,
              executionId: queuedEvent.executionId,
            },
            pendingCount
          );
        }
      },
      onOverflow: () => {
        if (monitor.enabled) {
          monitor.recordOverflowReconciliation({ projectScope });
        }
      },
    });

    const enqueue = (
      operation: "append" | "upsert",
      event: { payload: SessionLogCreatedEvent | SessionLogUpdatedEvent }
    ) => {
      if (!isCurrentScope()) return;
      const { log_id, step_execution_id, session_log } = event.payload;
      if (!session_log) return;
      const correlation = monitor.enabled
        ? makeSessionLogPerformanceCorrelation({
            projectScope,
            executionId: step_execution_id,
            logId: log_id,
            logicalKey: session_log.logical_key,
          })
        : undefined;
      if (correlation) monitor.recordReceived(correlation);
      queue.enqueue({
        executionId: step_execution_id,
        log: session_log,
        operation,
        urgent: isUrgentSessionLog(session_log),
        correlation,
      });
    };

    const unlistenCreatedPromise = events.sessionLogCreatedEvent.listen(
      (event) => enqueue("append", event)
    );
    const unlistenUpdatedPromise = events.sessionLogUpdatedEvent.listen(
      (event) => enqueue("upsert", event)
    );
    const unlistenWebsocketPromise = listen<string>(
      "websocket-state-changed",
      (event) => {
        if (
          isCurrentScope() &&
          (event.payload === "reconnecting" || event.payload === "disconnected")
        ) {
          queue.flushNow();
        }
      }
    );

    return () => {
      try {
        queue.dispose({
          flush: projectScopeGeneration === getProjectScopeGeneration(),
        });
      } finally {
        disposed = true;
        void unlistenCreatedPromise.then((unlisten) => unlisten());
        void unlistenUpdatedPromise.then((unlisten) => unlisten());
        void unlistenWebsocketPromise.then((unlisten) => unlisten());
      }
    };
  }, [enabled, projectScopeGeneration]);
}
