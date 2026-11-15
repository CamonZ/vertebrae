import {
  FlowScene,
  type FlowSceneProps,
} from "../../MachineDiagram/flow/FlowDiagram";
import type { AtlasMachineFlow } from "./buildMachineFlow";
import { useAtlasPresentation } from "./useAtlasPresentation";

/** Shared scene with the Atlas inspector bridge; its host owns layout and camera. */
export function AtlasMachineScene({
  model,
  query,
  ...scene
}: Omit<FlowSceneProps, "interaction" | "presentation"> & {
  model: AtlasMachineFlow;
  query?: string;
}) {
  const live = useAtlasPresentation(model, scene.diagram, query);
  return <FlowScene {...scene} {...live} />;
}
