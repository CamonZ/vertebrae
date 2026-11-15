import { useEffect, useRef } from "react";
import { reconcileTaskRunHistory } from "../query";
import { useProjectScopeGeneration } from "../stores/projectScopedStores";
import { useWebSocketStatus } from "./useWebSocketStatus";

/**
 * Realtime events keep cached run history current; a websocket outage may
 * drop some. Reconcile the project's history lists when the socket comes
 * back, with one request per loaded page rather than per task.
 */
export function useTaskRunHistoryReconciliation() {
  const generation = useProjectScopeGeneration();
  const status = useWebSocketStatus();
  const previous = useRef(status);

  useEffect(() => {
    const wasDown =
      previous.current === "reconnecting" ||
      previous.current === "disconnected";
    previous.current = status;
    if (status === "connected" && wasDown) reconcileTaskRunHistory(generation);
  }, [generation, status]);
}
