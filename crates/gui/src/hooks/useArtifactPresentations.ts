import { useQuery } from "@tanstack/react-query";
import { commands, type Artifact } from "../bindings";
import { errorMessage, queryKeys, unwrapCommand } from "../query";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

const NO_ARTIFACTS: Artifact[] = [];

/** Shares project and ticket attachment presentations for inline entity links. */
export function useArtifactPresentations() {
  const generation = useProjectScopeGeneration();
  const queryKey = queryKeys.artifacts.presentations(generation);
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const request = commands.listArtifactPresentations();
      const artifacts = await unwrapCommand(request);

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
