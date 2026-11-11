import { createContext, useContext } from "react";
import { createFlowRegistry } from "./defaults";
import type { FlowRegistry } from "./registry";

let shared: FlowRegistry | null = null;

/** The app-wide registry: starter parts and built-in attachments. */
export function defaultFlowRegistry(): FlowRegistry {
  shared ??= createFlowRegistry();
  return shared;
}

/**
 * The registry ```flow blocks compile against. Provide one to make extra
 * part kinds available without touching FlowBlock or FlowDiagram.
 */
export const FlowRegistryContext = createContext<FlowRegistry | null>(null);

export function useFlowRegistry(): FlowRegistry {
  return useContext(FlowRegistryContext) ?? defaultFlowRegistry();
}
