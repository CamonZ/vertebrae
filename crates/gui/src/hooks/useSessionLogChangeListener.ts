import { useEffect, useCallback } from "react";
import { events, type SessionLogCreatedEvent } from "../bindings";
import { useToastStore } from "../stores";

/** Options for the session log change listener hook */
interface UseSessionLogChangeListenerOptions {
  /** Called when a session log is created for a specific execution */
  onSessionLogCreated?: (event: SessionLogCreatedEvent) => void;
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to SessionLogCreatedEvent from Tauri.
 * Session logs are append-only entries tied to step executions, so this hook
 * exposes a callback for consumers to handle new log entries (e.g., appending
 * them to a local list for the currently viewed execution).
 *
 * @param options - Configuration options for the listener
 */
export function useSessionLogChangeListener(
  options: UseSessionLogChangeListenerOptions = {}
) {
  const { onSessionLogCreated, enabled = true } = options;
  const addToast = useToastStore((state) => state.addToast);

  const handleSessionLogCreated = useCallback(
    (event: { payload: SessionLogCreatedEvent }) => {
      const { log_id, execution_id } = event.payload;

      console.debug(
        `[SessionLogChangeListener] Log ${log_id.slice(0, 6)} created for execution ${execution_id.slice(0, 6)}`
      );

      addToast(`New session log for execution ${execution_id.slice(0, 6)}`, "info");

      if (onSessionLogCreated) {
        onSessionLogCreated(event.payload);
      }
    },
    [addToast, onSessionLogCreated]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.sessionLogCreatedEvent.listen(
      handleSessionLogCreated
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleSessionLogCreated]);
}
