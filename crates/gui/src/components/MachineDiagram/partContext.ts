import { createContext, useContext } from "react";
import type { FlowDirection } from "./orientation";

/**
 * Per-part drawing context, set by MachinePart for the fixtures it renders:
 * the loop fade, whether the part is removed/absent (rails turn dashed),
 * whether labels are shown, the hatch pattern id of the enclosing diagram,
 * and the flow direction the drawing is turned for.
 */
export interface PartDrawContext {
  /** Gallery leads are omitted when the flow owns the connections. */
  readonly inFlow?: boolean;
  readonly fade: number;
  readonly removed: boolean;
  readonly labels: boolean;
  readonly hatchId: string;
  /**
   * In a flow: the part's port positions (part space), with `leadFrame`
   * telling a rail's gallery leads (which the flow's wires replace) from
   * the part's own mechanism (see `mechanismPieces`). Absent in a flow: no
   * rail draws.
   */
  readonly leadPorts?: readonly (readonly [number, number])[];
  /** In a flow: the part's frame `[x, y, w, h]`; a lead runs out of it. */
  readonly leadFrame?: readonly [number, number, number, number];
  /**
   * The drawing is turned for a flow direction (MachinePart wraps it in the
   * turn); text inside it turns back upright around its anchor.
   */
  readonly turn?: FlowDirection;
}

export const PartContext = createContext<PartDrawContext>({
  fade: 1,
  removed: false,
  labels: true,
  hatchId: "md-hatch",
});

export const usePart = () => useContext(PartContext);
