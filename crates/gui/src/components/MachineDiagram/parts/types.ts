import type { ReactNode } from "react";
import type { PartIdentity } from "../accessibility";
import type { BBox } from "../ChangeMark";
import type { Footprint } from "../MachinePart";
import type { Timeline } from "../timeline";

/** One named scenario of a part: its looping story and the still it rests on. */
export interface PartScenario<E> {
  readonly name: string;
  /** Static and reduced-motion still time (VL-06). */
  readonly still: number;
  readonly timeline: Timeline;
  /** Scenario data the draw function needs beyond the timeline (clamp times, rings, lamps). */
  readonly extra: E;
}

/**
 * A catalogue part on the motion core: its scenario timelines and a draw
 * function for its fixtures (frame, rails, mechanism) at frame time `t`.
 * MachinePart supplies everything else (states, marks, status, cards, gates,
 * accessible text). Scenario 0 is the happy path, scenario 1 the first failure.
 */
export interface MachinePartDef<E = unknown> {
  readonly part: PartIdentity;
  /** Catalogue family (v2.1). */
  readonly family: string;
  readonly footprint: Footprint;
  /** Frame bounding box in part space (where change marks and the ghost sit). */
  readonly bb: BBox;
  /** Status line anchor in part space. */
  readonly status: { readonly x: number; readonly y: number };
  readonly scenarios: readonly [
    PartScenario<E>,
    PartScenario<E>,
    ...PartScenario<E>[],
  ];
  readonly draw: (t: number, extra: E) => ReactNode;
}
