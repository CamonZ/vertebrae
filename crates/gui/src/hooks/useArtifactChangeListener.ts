import { useCallback, useEffect } from "react";
import { events, type ArtifactChangedEvent } from "../bindings";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  removeArtifactFromQueryCache,
  invalidateArtifactQuery,
  upsertArtifactInQueryCache,
} from "../query";

/** Applies complete artifact projections directly to TanStack Query. */
export function useArtifactChangeListener() {
  const generation = useProjectScopeGeneration();
  const handleChanged = useCallback(
    ({ payload }: { payload: ArtifactChangedEvent }) => {
      if (generation !== getProjectScopeGeneration()) return;
      if (payload.change_type === "Deleted") {
        removeArtifactFromQueryCache(
          payload.artifact_id,
          payload.task_id,
          generation
        );
      } else if (payload.artifact) {
        upsertArtifactInQueryCache(
          payload.artifact,
          payload.task_id,
          generation
        );
      } else {
        invalidateArtifactQuery(payload.task_id, generation);
      }
    },
    [generation]
  );
  useEffect(() => {
    const unlisten = events.artifactChangedEvent.listen(handleChanged);
    return () => void unlisten.then((stop) => stop());
  }, [handleChanged]);
}
