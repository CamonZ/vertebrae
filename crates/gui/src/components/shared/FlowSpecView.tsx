import { FlowPlayer } from "../MachineDiagram/flow/FlowPlayer";
import { formatFlowError } from "../MachineDiagram/flow";
import { useFlowSpec, type FlowSpecState } from "./useFlowSpec";

/** Play a compiled flow, list its errors with spec paths, or show progress. */
export function FlowSpecBody({
  state,
  onActivatePart,
}: {
  state: FlowSpecState;
  onActivatePart?: (partId: string) => void;
}) {
  if (state.status === "ready")
    return <FlowPlayer flow={state.flow} onActivatePart={onActivatePart} />;
  if (state.status === "invalid") {
    const { errors } = state;
    return (
      <div role="alert" data-testid="flow-errors">
        <div className="mb-1 text-sm font-medium text-err">
          Flow spec has {errors.length}{" "}
          {errors.length === 1 ? "error" : "errors"}
        </div>
        <ul className="list-disc pl-5 font-mono text-xs text-fg">
          {errors.map((e, i) => (
            <li key={i} data-path={e.path}>
              {formatFlowError(e)}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div
      aria-busy="true"
      className="font-mono text-xs text-[var(--color-fg-mute)]"
      data-testid="flow-laying-out"
    >
      Laying out the diagram…
    </div>
  );
}

/** A flow spec source rendered as a playable diagram (or its errors). */
export function FlowSpecView({
  source,
  onActivatePart,
}: {
  source: string;
  onActivatePart?: (partId: string) => void;
}) {
  const state = useFlowSpec(source);
  return (
    <div
      className="max-w-full overflow-hidden whitespace-normal"
      data-testid="flow-preview"
    >
      <FlowSpecBody state={state} onActivatePart={onActivatePart} />
    </div>
  );
}
