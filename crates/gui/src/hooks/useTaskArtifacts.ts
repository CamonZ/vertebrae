import { useQuery } from "@tanstack/react-query";
import { commands, type Artifact } from "../bindings";
import { errorMessage, queryKeys, unwrapCommand } from "../query";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  taskDetailTraceNow,
  traceTaskDetailPhase,
} from "../utils/taskDetailTrace";

const NO_ARTIFACTS: Artifact[] = [];

/** Fetches the artifact projections attached to one task. */
export function useTaskArtifacts(taskId: string | null | undefined) {
  const generation = useProjectScopeGeneration();
  const query = useQuery({
    queryKey: queryKeys.artifacts.task(generation, taskId ?? ""),
    enabled: Boolean(taskId),
    queryFn: async () => {
      const startedAt = taskDetailTraceNow();
      traceTaskDetailPhase(taskId!, "artifacts-query-start", {
        command: "listTaskArtifacts",
      });
      try {
        const artifacts = await unwrapCommand(
          commands.listTaskArtifacts(taskId!)
        );
        traceTaskDetailPhase(taskId!, "artifacts-query-success", {
          durationMs: taskDetailTraceNow() - startedAt,
          count: artifacts.length,
        });
        return isCurrentProjectScopeGeneration(generation) ? artifacts : [];
      } catch (error) {
        traceTaskDetailPhase(taskId!, "artifacts-query-error", {
          durationMs: taskDetailTraceNow() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });

  return {
    artifacts: query.data ?? NO_ARTIFACTS,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => void query.refetch(),
  };
}
