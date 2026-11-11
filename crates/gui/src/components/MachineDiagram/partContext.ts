import { createContext, useContext } from "react";

/**
 * Per-part drawing context, set by MachinePart for the fixtures it renders:
 * the loop fade, whether the part is removed/absent (rails turn dashed),
 * whether labels are shown, and the hatch pattern id of the enclosing diagram.
 */
export interface PartDrawContext {
  readonly fade: number;
  readonly removed: boolean;
  readonly labels: boolean;
  readonly hatchId: string;
}

export const PartContext = createContext<PartDrawContext>({
  fade: 1,
  removed: false,
  labels: true,
  hatchId: "md-hatch",
});

export const usePart = () => useContext(PartContext);
