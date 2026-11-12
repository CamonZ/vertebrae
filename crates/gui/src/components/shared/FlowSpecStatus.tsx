import { formatFlowError, type FlowSpecError } from "../MachineDiagram/flow";

/** A flow spec's errors, each with its spec path. */
export function FlowSpecErrors({
  errors,
}: {
  errors: readonly FlowSpecError[];
}) {
  return (
    <div role="alert" data-testid="flow-errors">
      <div className="mb-1 text-sm font-medium text-err">
        Flow spec has {errors.length} {errors.length === 1 ? "error" : "errors"}
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

/** Shown while a spec is parsed and auto-laid out. */
export function FlowSpecProgress({
  children = "Laying out the diagram…",
}: {
  children?: string;
}) {
  return (
    <div
      aria-busy="true"
      className="font-mono text-xs text-[var(--color-fg-mute)]"
      data-testid="flow-laying-out"
    >
      {children}
    </div>
  );
}
