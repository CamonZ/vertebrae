import { FlowDrill } from "./FlowDrill";
import { FlowSpecErrors, FlowSpecProgress } from "./FlowSpecStatus";
import { useFlowSpec, type FlowSpecState } from "./useFlowSpec";

/**
 * Play a compiled flow (drilling into parts with a sub-spec), list its
 * errors with spec paths, or show progress.
 */
export function FlowSpecBody({
  state,
  onActivatePart,
}: {
  state: FlowSpecState;
  /** A part of the top-level diagram was activated. */
  onActivatePart?: (partId: string) => void;
}) {
  if (state.status === "ready")
    return <FlowDrill flow={state.flow} onActivatePart={onActivatePart} />;
  if (state.status === "invalid")
    return <FlowSpecErrors errors={state.errors} />;
  return <FlowSpecProgress />;
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
