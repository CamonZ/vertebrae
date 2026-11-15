import {
  FlowScene,
  type FlowSceneProps,
} from "../../MachineDiagram/flow/FlowDiagram";
import type { AtlasMachineFlow } from "./buildMachineFlow";
import { useAtlasPresentation } from "./useAtlasPresentation";

/** Shared scene with the Atlas inspector bridge; its host owns layout and camera. */
export function AtlasMachineScene({
  model,
  ...scene
}: Omit<FlowSceneProps, "interaction" | "presentation"> & {
  model: AtlasMachineFlow;
}) {
  const live = useAtlasPresentation(model, scene.diagram);
  return <FlowScene {...scene} {...live} />;
}
