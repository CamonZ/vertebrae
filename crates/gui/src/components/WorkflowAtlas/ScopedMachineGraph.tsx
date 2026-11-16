import { useEffect, useRef, useState } from "react";
import type { JsonValue, PipelineSummary } from "../../bindings";
import type { AtlasGraphLevel } from "./adapter/atlasLevels";
import type { AtlasLevelTarget } from "./adapter/buildMachineFlow";
import { useAtlasLevelFlow } from "./adapter/useAtlasLevelFlow";
import { AtlasMachineScene } from "./adapter/AtlasMachineScene";
import { TaskRunMotion } from "./adapter/TaskRunMotion";
import { usePanZoom, type PanZoomTransform } from "./hooks/usePanZoom";
import { ZoomWidget } from "./ZoomWidget";

interface Props {
  /** The whole project's summary; the level picks what it draws. */
  summary: PipelineSummary;
  routeConfigs: ReadonlyMap<string, JsonValue | null>;
  level: AtlasGraphLevel;
  scope: string;
  query: string;
  cameraSnapshot?: { current: PanZoomTransform | null };
  /** Opens the level a station or stub leads to. */
  onOpen?: (target: AtlasLevelTarget) => void;
}

const LEVEL_LABEL: Record<AtlasGraphLevel["kind"], string> = {
  factories: "Factory graph",
  workflows: "Factory workflow graph",
  steps: "Workflow step graph",
};

const LEVEL_NOUN: Record<AtlasGraphLevel["kind"], string> = {
  factories: "factory",
  workflows: "workflow",
  steps: "step",
};

/**
 * The Atlas Graph at one level: between factories, inside a factory or
 * inside a workflow. Each level is one shared machine scene; the host owns
 * its camera. Map and Board retain their existing hosts.
 */
export function ScopedMachineGraph(props: Props) {
  const [attempt, setAttempt] = useState(0);
  return (
    <MachineGraph
      key={attempt}
      {...props}
      retry={() => setAttempt((n) => n + 1)}
    />
  );
}

function MachineGraph({
  summary,
  routeConfigs,
  level,
  scope,
  query,
  retry,
  cameraSnapshot,
  onOpen,
}: Props & { retry: () => void }) {
  const model = useAtlasLevelFlow(summary, routeConfigs, level, scope);
  const state = model.layout;
  const diagram =
    state.status === "done" && state.result.ok
      ? state.result.flow.arrangements[0]
      : null;
  const canvas = useRef<HTMLDivElement>(null);
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
  const camera = usePanZoom(
    canvas,
    { w: diagram?.width ?? 0, h: diagram?.height ?? 0 },
    {
      min: 0.04,
      max: 2.4,
      initialTransform: cameraSnapshot?.current ?? undefined,
    }
  );
  const fit = camera.fit;
  useEffect(() => {
    // Automatic fits remain automatic after remounts. In particular, exiting
    // while layout is pending must not persist the initial identity transform.
    if (cameraSnapshot)
      cameraSnapshot.current = camera.userControlled
        ? { s: camera.scale, x: camera.x, y: camera.y }
        : null;
  }, [cameraSnapshot, camera.scale, camera.x, camera.y, camera.userControlled]);
  // Geometry identity changes only after a structural edit. Presentation updates
  // retain both the compiled arrangement and the user's camera transform.
  useEffect(() => {
    if (diagram && !camera.userControlled) fit();
  }, [diagram, fit, camera.userControlled]);
  const noun = LEVEL_NOUN[level.kind];
  return (
    <div
      className="uv-machine-canvas"
      ref={canvas}
      data-testid="atlas-graph"
      data-level={level.kind}
    >
      {state.status === "pending" && (
        <div className="uv-loading" role="status">
          laying out {noun} graph…
        </div>
      )}
      {state.status === "done" && !state.result.ok && (
        <div className="uv-empty" role="alert">
          Unable to compile {noun} graph:{" "}
          {state.result.errors.map((e) => e.message).join("; ")}
        </div>
      )}
      {state.status === "done" && state.fallbackError && (
        <div className="uv-machine-warning" role="alert" data-no-pan>
          Automatic layout failed. Showing a simplified layout.{" "}
          {state.fallbackError} <button onClick={retry}>Retry layout</button>
        </div>
      )}
      {diagram && (
        <>
          <div
            className="uv-scaler uv-machine-scene"
            style={{ transform: camera.transform }}
          >
            <AtlasMachineScene
              model={model}
              diagram={diagram}
              t={0}
              label={LEVEL_LABEL[level.kind]}
              query={query}
              panelHost={panelHost}
              onOpen={onOpen}
            />
            <TaskRunMotion
              summary={summary}
              level={level}
              model={model}
              diagram={diagram}
              viewport={canvas}
            />
          </div>
          <ZoomWidget
            onZoomIn={camera.zoomIn}
            onZoomOut={camera.zoomOut}
            onFit={camera.fit}
          />
        </>
      )}
      <div className="uv-connections-host" ref={setPanelHost} data-no-pan />
    </div>
  );
}
