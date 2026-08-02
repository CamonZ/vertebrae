import type { Artifact } from "../../bindings";
import { ArtifactPreviewBody } from "./ArtifactPreviewBody";
import {
  CloseIcon,
  FloatingDetailPanel,
  IconButton,
  PanelHeader,
} from "../panels";

interface ArtifactInspectorPanelProps {
  artifact: Artifact | null;
  closing?: boolean;
  onClose: () => void;
  onExitAnimationEnd: (event: {
    target: EventTarget;
    currentTarget: EventTarget;
  }) => void;
}

export function ArtifactInspectorPanel({
  artifact,
  closing = false,
  onClose,
  onExitAnimationEnd,
}: ArtifactInspectorPanelProps) {
  const label = artifact?.logical_name ?? artifact?.filename ?? "Artifact";
  return (
    <FloatingDetailPanel
      panelId="artifact-inspector"
      widthStorageKey="artifact-inspector-panel-width"
      closing={closing}
      onExitAnimationEnd={onExitAnimationEnd}
      onClose={onClose}
      isOpen={artifact != null && !closing}
      className="tasks-v2"
      testId="artifact-inspector-panel"
    >
      <div className="flex h-full min-h-0 flex-col bg-bg">
        <PanelHeader
          title={<span data-testid="artifact-inspector-title">{label}</span>}
          metadata={
            artifact && (
              <>
                <span>{artifact.filename}</span>
                {artifact.metadata && (
                  <span>
                    {artifact.metadata.content_kind} ·{" "}
                    {artifact.metadata.format}
                  </span>
                )}
              </>
            )
          }
          controls={
            <IconButton
              onClick={onClose}
              ariaLabel="Close artifact inspector"
              testId="artifact-inspector-close"
            >
              <CloseIcon />
            </IconButton>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {artifact && <ArtifactPreviewBody artifact={artifact} />}
        </div>
      </div>
    </FloatingDetailPanel>
  );
}
