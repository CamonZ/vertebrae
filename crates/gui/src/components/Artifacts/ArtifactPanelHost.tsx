import { useEffect, useRef } from "react";
import { useArtifactPresentation } from "../../hooks/useArtifactPresentation";
import { usePanelExitTransition } from "../../hooks/usePanelExitTransition";
import { useTaskArtifacts } from "../../hooks/useTaskArtifacts";
import {
  TASK_DETAIL_PANEL_ID,
  useEntityPanelStore,
} from "../../stores/entityPanelStore";
import { usePanelFocusStore } from "../../stores/panelFocusStore";
import { useProjectScopeGeneration } from "../../stores/projectScopedStores";
import { ArtifactInspectorPanel } from "./ArtifactInspectorPanel";

interface ResolvedArtifactPanelProps {
  artifactId: string;
  closing: boolean;
  onExitAnimationEnd: ReturnType<
    typeof usePanelExitTransition
  >["onAnimationEnd"];
}

function ResolvedArtifactPanel({
  artifactId,
  closing,
  onExitAnimationEnd,
}: ResolvedArtifactPanelProps) {
  const taskId = useEntityPanelStore((state) =>
    state.selection?.type === "task" ? state.selection.taskId : null
  );
  const closeArtifact = useEntityPanelStore((state) => state.closeArtifact);
  const presentation = useArtifactPresentation(artifactId);
  const resolvedArtifact = presentation.isSuccess ? presentation.data : null;
  const taskArtifacts = useTaskArtifacts(taskId);
  const relationshipKnown =
    taskId != null && !taskArtifacts.isLoading && !taskArtifacts.error;
  const attachment = relationshipKnown
    ? taskArtifacts.artifacts.find((artifact) => artifact.id === artifactId)
    : undefined;

  useEffect(() => {
    if (closing || !resolvedArtifact || !relationshipKnown || attachment)
      return;
    const state = useEntityPanelStore.getState();
    if (
      state.artifactId === artifactId &&
      state.selection?.type === "task" &&
      state.selection.taskId === taskId
    ) {
      state.close();
    }
  }, [
    artifactId,
    attachment,
    closing,
    resolvedArtifact,
    relationshipKnown,
    taskId,
  ]);

  const artifact = resolvedArtifact ? (attachment ?? resolvedArtifact) : null;
  const status = presentation.isError ? (
    <div role="alert">
      Could not load the artifact.{" "}
      <button
        type="button"
        className="link"
        onClick={() => void presentation.refetch()}
      >
        Retry artifact
      </button>
    </div>
  ) : presentation.isLoading ? (
    <p role="status">Loading artifact…</p>
  ) : !artifact ? (
    <p role="alert">
      This artifact is missing or unavailable in the active project.
    </p>
  ) : null;

  return (
    <ArtifactInspectorPanel
      artifact={artifact}
      status={status}
      closing={closing}
      onClose={() => {
        closeArtifact();
        const panels = usePanelFocusStore.getState();
        if (attachment && panels.stack.includes(TASK_DETAIL_PANEL_ID)) {
          panels.focus(TASK_DETAIL_PANEL_ID);
        }
      }}
      onExitAnimationEnd={onExitAnimationEnd}
      position={attachment ? "left-of-task" : "right"}
    />
  );
}

function ArtifactPanelPresence() {
  const artifactId = useEntityPanelStore((state) => state.artifactId);
  const lastId = useRef<string | null>(null);
  if (artifactId) lastId.current = artifactId;
  const { mounted, closing, onAnimationEnd } = usePanelExitTransition(
    artifactId != null,
    180
  );
  const activeId = artifactId ?? lastId.current;
  if (!mounted || !activeId) return null;

  return (
    <ResolvedArtifactPanel
      key={activeId}
      artifactId={activeId}
      closing={closing}
      onExitAnimationEnd={onAnimationEnd}
    />
  );
}

export function ArtifactPanelHost() {
  const generation = useProjectScopeGeneration();
  return <ArtifactPanelPresence key={generation} />;
}
