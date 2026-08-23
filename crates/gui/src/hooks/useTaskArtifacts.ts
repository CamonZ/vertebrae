import { useQuery } from "@tanstack/react-query";
import { commands, type Artifact } from "../bindings";
import { errorMessage, queryKeys, unwrapCommand } from "../query";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

const NO_ARTIFACTS: Artifact[] = [];

/** Fetches the artifact projections attached to one task. */
export function useTaskArtifacts(taskId: string | null | undefined) {
  const generation = useProjectScopeGeneration();
  const query = useQuery({
    queryKey: queryKeys.artifacts.task(generation, taskId ?? ""),
    enabled: Boolean(taskId),
    queryFn: async () => {
      const artifacts = await unwrapCommand(
        commands.listTaskArtifacts(taskId!)
      );
      return isCurrentProjectScopeGeneration(generation) ? artifacts : [];
    },
  });

  return {
    artifacts: query.data ?? NO_ARTIFACTS,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    refetch: () => void query.refetch(),
  };
}
