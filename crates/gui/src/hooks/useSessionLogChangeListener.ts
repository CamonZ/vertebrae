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
    const isCurrentScope = () =>
      !disposed && projectScopeGeneration === getProjectScopeGeneration();

    const enqueue = (
      operation: "append" | "upsert",
      event: { payload: SessionLogCreatedEvent | SessionLogUpdatedEvent }
    ) => {
      if (!isCurrentScope()) return;
      const { step_execution_id, session_log } = event.payload;
      if (!session_log) return;
      const store = useSessionLogStore.getState();
      if (operation === "append") {
        store.appendLog(step_execution_id, session_log);
      } else {
        store.upsertLog(step_execution_id, session_log);
      }
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
          useSessionLogStore.getState().flushPending();
        }
      }
    );

    return () => {
      try {
        disposed = true;
        if (projectScopeGeneration === getProjectScopeGeneration()) {
          useSessionLogStore.getState().flushPending();
        }
      } finally {
        void unlistenCreatedPromise.then((unlisten) => unlisten());
        void unlistenUpdatedPromise.then((unlisten) => unlisten());
        void unlistenWebsocketPromise.then((unlisten) => unlisten());
      }
    };
  }, [enabled, projectScopeGeneration]);
}
