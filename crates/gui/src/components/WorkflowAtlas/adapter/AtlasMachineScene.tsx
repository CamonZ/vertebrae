import { createPortal } from "react-dom";
import {
  FlowScene,
  type FlowSceneProps,
} from "../../MachineDiagram/flow/FlowDiagram";
import type { AtlasLevelTarget, AtlasMachineFlow } from "./buildMachineFlow";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { useAtlasPresentation } from "./useAtlasPresentation";

/** Shared scene with the Atlas inspector bridge; its host owns layout and camera. */
export function AtlasMachineScene({
  model,
  query,
  panelHost,
  onOpen,
  ...scene
}: Omit<FlowSceneProps, "interaction" | "presentation"> & {
  /** Opens the level a station or stub leads to. */
  onOpen?: (target: AtlasLevelTarget) => void;
  model: AtlasMachineFlow;
  query?: string;
  /** Where the connections list of a hovered element goes (outside the camera). */
  panelHost?: HTMLElement | null;
}) {
  const { trace, tracing, ...live } = useAtlasPresentation(
    model,
    scene.diagram,
    query,
    onOpen
  );
  return (
    <div className="uv-machine-layer" data-tracing={tracing || undefined}>
      <FlowScene {...scene} {...live} />
      {panelHost &&
        trace &&
        createPortal(<ConnectionsPanel trace={trace} />, panelHost)}
    </div>
  );
}
