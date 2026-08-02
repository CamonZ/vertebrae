import { useCallback, useEffect } from "react";
import { events, type ArtifactChangedEvent } from "../bindings";
import {
  getProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";
import {
  removeArtifactFromQueryCache,
  invalidateArtifactQuery,
} from "../query";

/** Refreshes attachment projections after artifact or link CDC updates. */
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
      } else {
        // Artifact CDC only has file fields, while the rendered list item
        // includes attachment-local logical name and metadata. Refetch the
        // projection instead of replacing a complete entry with raw CDC.
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
