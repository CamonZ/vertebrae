import { useMemo } from "react";
import { FlowPlayer } from "../MachineDiagram/flow/FlowPlayer";
import {
  compileFlow,
  formatFlowError,
  parseFlowSpec,
  useFlowRegistry,
  type CompiledFlow,
  type FlowSpecError,
} from "../MachineDiagram/flow";

type FlowBlockState =
  | { ok: true; flow: CompiledFlow }
  | { ok: false; errors: readonly FlowSpecError[] };

function compileSource(
  source: string,
  registry: ReturnType<typeof useFlowRegistry>
): FlowBlockState {
  try {
    const parsed = parseFlowSpec(source);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    const compiled = compileFlow(parsed.value, { registry });
    return compiled.ok
      ? { ok: true, flow: compiled.flow }
      : { ok: false, errors: compiled.errors };
  } catch (e) {
    return {
      ok: false,
      errors: [{ path: "", message: (e as Error).message || String(e) }],
    };
  }
}

/** A ```flow block: parse and compile the spec, then play it or list its errors. */
export function FlowBlock({ source }: { source: string }) {
  const registry = useFlowRegistry();
  const state = useMemo(
    () => compileSource(source, registry),
    [source, registry]
  );
  return (
    <div
      className="mb-2 max-w-full overflow-hidden rounded-md border border-border/50 bg-bg p-3 whitespace-normal"
      data-testid="flow-block"
    >
      {state.ok ? (
        <FlowPlayer flow={state.flow} />
      ) : (
        <div role="alert" data-testid="flow-errors">
          <div className="mb-1 text-sm font-medium text-err">
            Flow spec has {state.errors.length}{" "}
            {state.errors.length === 1 ? "error" : "errors"}
          </div>
          <ul className="list-disc pl-5 font-mono text-xs text-fg">
            {state.errors.map((e, i) => (
              <li key={i} data-path={e.path}>
                {formatFlowError(e)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
