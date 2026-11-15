import { useEffect, useRef, useState } from "react";
import type { JsonValue, PipelineSummary } from "../../bindings";
import { useAtlasMachineFlow } from "./adapter/useAtlasMachineFlow";
import { AtlasMachineScene } from "./adapter/AtlasMachineScene";
import { usePanZoom } from "./hooks/usePanZoom";
import { ZoomWidget } from "./ZoomWidget";

interface Props {
  summary: PipelineSummary;
  routeConfigs: ReadonlyMap<string, JsonValue | null>;
  scope: string;
  query: string;
}

/** Mounted only for the internal scoped Graph rollout. Map and Board retain their hosts. */
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
  scope,
  query,
  retry,
}: Props & { retry: () => void }) {
  const model = useAtlasMachineFlow(summary, routeConfigs, scope);
  const state = model.layout;
  const diagram =
    state.status === "done" && state.result.ok
      ? state.result.flow.arrangements[0]
      : null;
  const canvas = useRef<HTMLDivElement>(null);
  const camera = usePanZoom(
    canvas,
    { w: diagram?.width ?? 0, h: diagram?.height ?? 0 },
    { min: 0.04, max: 2.4 }
  );
  const fit = camera.fit;
  // Geometry identity changes only after a structural edit. Presentation updates
  // retain both the compiled arrangement and the user's camera transform.
  useEffect(() => {
    if (diagram) fit();
  }, [diagram, fit]);
  return (
    <div className="uv-machine-canvas" ref={canvas}>
      {state.status === "pending" && (
        <div className="uv-loading" role="status">
          laying out workflow graph…
        </div>
      )}
      {state.status === "done" && !state.result.ok && (
        <div className="uv-empty" role="alert">
          Unable to compile workflow graph:{" "}
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
              label="Factory workflow graph"
              query={query}
            />
          </div>
          <ZoomWidget
            onZoomIn={camera.zoomIn}
            onZoomOut={camera.zoomOut}
            onFit={camera.fit}
          />
        </>
      )}
    </div>
  );
}
