import type { ReactNode } from "react";
import type { Artifact } from "../../bindings";
import { ARTIFACT_INSPECTOR_PANEL_ID } from "../../stores/entityPanelStore";
import { ArtifactPreviewBody } from "./ArtifactPreviewBody";
import {
  CloseIcon,
  FloatingDetailPanel,
  IconButton,
  PanelHeader,
} from "../panels";

interface ArtifactInspectorPanelProps {
  artifact: Artifact | null;
  status?: ReactNode;
  closing?: boolean;
  onClose: () => void;
  onExitAnimationEnd: (event: {
    target: EventTarget;
    currentTarget: EventTarget;
  }) => void;
  position?: "right" | "left-of-task";
}

export function ArtifactInspectorPanel({
  artifact,
  status,
  closing = false,
  onClose,
  onExitAnimationEnd,
  position,
}: ArtifactInspectorPanelProps) {
  const label = artifact?.logical_name ?? artifact?.filename ?? "Artifact";
  // Lead with the file name; the folder path stays readable but recedes.
  const slash = label.lastIndexOf("/");
  const folder = slash >= 0 ? label.slice(0, slash + 1) : "";
  const name = slash >= 0 ? label.slice(slash + 1) : label;
  return (
    <FloatingDetailPanel
      panelId={ARTIFACT_INSPECTOR_PANEL_ID}
      widthStorageKey="artifact-inspector-panel-width"
      closing={closing}
      onExitAnimationEnd={onExitAnimationEnd}
      onClose={onClose}
      className="tasks-v2 detail-opaque"
      testId="artifact-inspector-panel"
      position={position}
      aboveChat={position === "left-of-task" && !closing}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="artifact-inspector-content"
      >
        <PanelHeader
          title={
            <span
              data-testid="artifact-inspector-title"
              className="artifact-inspector-title"
              title={label}
            >
              {folder && (
                <span className="artifact-inspector-folder">{folder}</span>
              )}
              {name}
            </span>
          }
          metadata={
            artifact && (
              <>
                {artifact.filename !== label && (
                  <span className="font-mono">{artifact.filename}</span>
                )}
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
        <div className="artifact-inspector-body min-h-0 flex-1 overflow-y-auto p-4">
          {status ?? (artifact && <ArtifactPreviewBody artifact={artifact} />)}
        </div>
      </div>
    </FloatingDetailPanel>
  );
}
