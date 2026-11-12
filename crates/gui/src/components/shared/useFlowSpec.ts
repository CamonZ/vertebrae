import { useMemo } from "react";
import {
  parseFlowSpec,
  useFlowRegistry,
  useLaidOutFlow,
  type CompiledFlow,
  type FlowSpecError,
} from "../MachineDiagram/flow";

export type FlowSpecState =
  | { readonly status: "laying-out" }
  | { readonly status: "invalid"; readonly errors: readonly FlowSpecError[] }
  | { readonly status: "ready"; readonly flow: CompiledFlow };

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
 * Parse and compile a flow spec against the registry in context, auto-laying
 * out parts without a position.
 */
export function useFlowSpec(source: string): FlowSpecState {
  const registry = useFlowRegistry();
  const parsed = useMemo(() => parseSource(source), [source]);
  const compiled = useLaidOutFlow(parsed.ok ? parsed.value : undefined, {
    registry,
  });
  if (!parsed.ok) return { status: "invalid", errors: parsed.errors };
  if (compiled.status === "pending") return { status: "laying-out" };
  return compiled.result.ok
    ? { status: "ready", flow: compiled.result.flow }
    : { status: "invalid", errors: compiled.result.errors };
}
