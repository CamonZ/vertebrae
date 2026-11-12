import { useMemo } from "react";
import { FlowPlayer } from "../MachineDiagram/flow/FlowPlayer";
import {
  formatFlowError,
  parseFlowSpec,
  useFlowRegistry,
  useLaidOutFlow,
  type FlowSpecError,
} from "../MachineDiagram/flow";

type Parsed =
  | { ok: true; value: unknown }
  | { ok: false; errors: readonly FlowSpecError[] };

function parseSource(source: string): Parsed {
  try {
    return parseFlowSpec(source);
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: "", message: (e as Error).message || String(e) }],
    };
  }
}

/**
 * A ```flow block: parse and compile the spec (auto-laying out parts without
 * a position), then play it or list its errors.
 */
export function FlowBlock({ source }: { source: string }) {
  const registry = useFlowRegistry();
  const parsed = useMemo(() => parseSource(source), [source]);
  const compiled = useLaidOutFlow(parsed.ok ? parsed.value : undefined, {
    registry,
  });
  const errors = !parsed.ok
    ? parsed.errors
    : compiled.status === "done" && !compiled.result.ok
      ? compiled.result.errors
      : undefined;
  return (
    <div
      className="mb-2 max-w-full overflow-hidden rounded-md border border-border/50 bg-bg p-3 whitespace-normal"
      data-testid="flow-block"
    >
      {errors ? (
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
      ) : compiled.status === "done" && compiled.result.ok ? (
        <FlowPlayer flow={compiled.result.flow} />
      ) : (
        <div
          aria-busy="true"
          className="font-mono text-xs text-[var(--color-fg-mute)]"
          data-testid="flow-laying-out"
        >
          Laying out the diagram…
        </div>
      )}
    </div>
  );
}
