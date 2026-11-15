/**
 * Web worker entry for flow auto-layout. ELK placement and rail routing can
 * take long enough on a large flow to drop frames, so `layoutClient` posts the
 * compiled flow (plain data) here and receives the finished `FlowLayout`.
 * The worker keeps its own layout value cache across requests.
 */
// Order matters: see elkWorkerShim.
import "./elkWorkerShim";
// Creates the shared ELK instance, which loads elkjs's in-thread worker.
import "../../../hooks/useElkLayout";
import "./elkWorkerUnshim";
import type { CompiledFlow } from "./compile";
import { layoutFlow } from "./layout";
import { layoutFlowComposite } from "./composite";
import type { LayoutRequest, LayoutResponse } from "./layoutClient";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
  postMessage(message: LayoutResponse): void;
};

scope.onmessage = (event) => {
  const { id, flow, composite } = event.data;
  (composite ? layoutFlowComposite : layoutFlow)(flow as CompiledFlow).then(
    (layout) => scope.postMessage({ id, layout }),
    (error: unknown) =>
      scope.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      })
  );
};
