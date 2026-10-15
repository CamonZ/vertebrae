import { useEffect, useCallback } from "react";
import {
  commands,
  events,
  type StepExecutionChangedEvent,
} from "../bindings";
import { upsertStepExecutionInQueryCache } from "../query";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

/** Options for the step execution change listener hook */
interface UseStepExecutionChangeListenerOptions {
  /** Whether the listener is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Hook that listens to StepExecutionChangedEvent from Tauri and applies entity data
 * directly to the execution query cache. No REST refetch is needed when WS
 * payloads carry the full entity.
 *
 * @param options - Configuration options for the listener
 */
export function useStepExecutionChangeListener(
  options: UseStepExecutionChangeListenerOptions = {}
) {
  const { enabled = true } = options;
  const projectScopeGeneration = useProjectScopeGeneration();

  const handleExecutionChanged = useCallback(
    (event: { payload: StepExecutionChangedEvent }) => {
      if (projectScopeGeneration !== getProjectScopeGeneration()) return;

      const {
        execution_id,
        task_id,
        task_run_id,
        status,
        change_type,
        execution,
      } = event.payload;

      console.debug(
        `[StepExecutionChangeListener] Execution ${execution_id.slice(0, 6)} ${change_type}: ${status}`
      );

      if (execution) {
        upsertStepExecutionInQueryCache(execution, {
          taskId: task_id,
          taskRunId: task_run_id || execution.task_run_id,
          generation: projectScopeGeneration,
        });
        return;
      }

      if (!task_id) return;
      void commands
        .getTaskExecutions(task_id)
        .then((result) => {
          if (projectScopeGeneration !== getProjectScopeGeneration()) return;
          if (result.status !== "ok") return;
          for (const fetchedExecution of result.data) {
            upsertStepExecutionInQueryCache(fetchedExecution, {
              taskId: task_id,
              taskRunId: fetchedExecution.task_run_id ?? null,
              generation: projectScopeGeneration,
            });
          }
        })
        .catch(() => {});
    },
    [projectScopeGeneration]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const unlistenPromise = events.stepExecutionChangedEvent.listen(
      handleExecutionChanged
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, handleExecutionChanged]);
}
