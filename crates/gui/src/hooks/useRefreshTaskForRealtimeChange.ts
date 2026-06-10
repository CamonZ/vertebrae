import { useCallback } from "react";
import { commands } from "../bindings";
import { useTaskStore } from "../stores";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import { upsertTaskInQueryCache } from "../query";

const taskRefreshesInFlight = new Set<string>();

export function useRefreshTaskForRealtimeChange(logPrefix: string) {
  const reconcileTask = useTaskStore((state) => state.reconcileTask);
  const projectScopeGeneration = useProjectScopeGeneration();

  return useCallback(
    async (taskId: string) => {
      const requestGeneration = projectScopeGeneration;
      const refreshKey = `${requestGeneration}:${taskId}`;
      if (taskRefreshesInFlight.has(refreshKey)) return;
      taskRefreshesInFlight.add(refreshKey);

      try {
        const result = await commands.getTask(taskId);
        if (requestGeneration !== getProjectScopeGeneration()) return;
        if (result.status === "ok") {
          upsertTaskInQueryCache(result.data, requestGeneration);
          reconcileTask(result.data);
        } else {
          console.warn(
            `[${logPrefix}] Failed to refresh task ${taskId.slice(0, 6)} after realtime change: ${result.error.message}`
          );
        }
      } finally {
        taskRefreshesInFlight.delete(refreshKey);
      }
    },
    [logPrefix, projectScopeGeneration, reconcileTask]
  );
}
