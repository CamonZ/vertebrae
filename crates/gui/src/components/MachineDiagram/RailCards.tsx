import { useMemo } from "react";
import { Card } from "./Card";
import { stateAt, type Timeline } from "./timeline";
import { useReducedMotion } from "./useReducedMotion";

export interface RailCardsProps {
  /** A diagram's rail layer (`DiagramTimeline.travel`): cards between parts, in diagram space. */
  timeline: Timeline;
  t: number;
  smear?: boolean;
  reducedMotion?: boolean;
}

/**
 * Cards travelling on rails between parts, on the diagram's shared clock.
 * Parts draw their own cards (MachinePart); this layer draws the hand-offs,
 * so one card id appears in a part, then on a rail, then in the next part.
 */
export function RailCards({
  timeline,
  t,
  smear = true,
  reducedMotion,
}: RailCardsProps) {
  const prefersReduced = useReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const frame = useMemo(
    () => stateAt(timeline, t, { reducedMotion: reduced, smear }),
    [timeline, t, reduced, smear]
  );
  return (
    <g className="md-rail-cards">
      {frame.cards.map((c) => (
        <Card key={c.index} frame={c} />
      ))}
    </g>
  );
}
