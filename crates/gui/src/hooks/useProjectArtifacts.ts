import { useQuery } from "@tanstack/react-query";
import { commands, type Artifact } from "../bindings";
import { errorMessage, queryKeys, unwrapCommand } from "../query";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

const NO_ARTIFACTS: Artifact[] = [];

/** Fetches the active project's artifact file projections. */
export function useProjectArtifacts() {
  const generation = useProjectScopeGeneration();
  const query = useQuery({
    queryKey: queryKeys.artifacts.project(generation),
    queryFn: async () => {
      const artifacts = await unwrapCommand(commands.listProjectArtifacts());
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
