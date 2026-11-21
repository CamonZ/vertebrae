import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { queryKeys, unwrapCommand } from "../query";
import {
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

export function useArtifactPresentation(artifactId: string) {
  const generation = useProjectScopeGeneration();
  return useQuery({
    queryKey: queryKeys.artifacts.inspector(generation, artifactId),
    queryFn: async () => {
      const artifact = await unwrapCommand(
        commands.findArtifactPresentation(artifactId)
      );
      return isCurrentProjectScopeGeneration(generation) ? artifact : null;
    },
  });
}
