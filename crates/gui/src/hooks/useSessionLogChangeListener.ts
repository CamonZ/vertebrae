import { useEffect, useCallback } from "react";
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

/** Options for the session log change listener hook */
interface UseSessionLogChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to SessionLogCreatedEvent from Tauri and appends incoming
 * session logs directly to the sessionLogStore. Consumers read logs from the
 * store rather than via callbacks.
 *
 * @param options - Configuration options for the listener
 */
export function useSessionLogChangeListener(
  options: UseSessionLogChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const appendLog = useSessionLogStore((state) => state.appendLog);
  const upsertLog = useSessionLogStore((state) => state.upsertLog);
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleSessionLogCreated = useCallback(
    (event: { payload: SessionLogCreatedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { log_id, step_execution_id, session_log } = event.payload;

      console.debug(
        `[SessionLogChangeListener] Log ${log_id.slice(0, 6)} created for execution ${step_execution_id.slice(0, 6)}`
      );

      if (session_log) {
        appendLog(step_execution_id, session_log);
      } else {
        console.debug(
          `[SessionLogChangeListener] session_log is null for log ${log_id.slice(0, 6)}, skipping append`
        );
      }
    },
    [appendLog, projectScopeGeneration]
  );

  const handleSessionLogUpdated = useCallback(
    (event: { payload: SessionLogUpdatedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const { log_id, step_execution_id, session_log } = event.payload;

      console.debug(
        `[SessionLogChangeListener] Log ${log_id.slice(0, 6)} updated for execution ${step_execution_id.slice(0, 6)}`
      );

      if (session_log) {
        upsertLog(step_execution_id, session_log);
      } else {
        console.debug(
          `[SessionLogChangeListener] session_log is null for log ${log_id.slice(0, 6)}, skipping upsert`
        );
      }
    },
    [projectScopeGeneration, upsertLog]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenCreatedPromise = events.sessionLogCreatedEvent.listen(
      handleSessionLogCreated
    );
    const unlistenUpdatedPromise = events.sessionLogUpdatedEvent.listen(
      handleSessionLogUpdated
    );

    return () => {
      unlistenCreatedPromise.then((unlisten) => unlisten());
      unlistenUpdatedPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleSessionLogCreated, handleSessionLogUpdated]);
}
