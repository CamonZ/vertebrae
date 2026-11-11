import { useMemo, type ReactNode } from "react";
import {
  scenarioLabel,
  stateLabel,
  type ChangeMark as Mark,
  type PartIdentity,
} from "./accessibility";
import { Card } from "./Card";
import { ChangeMark, RemovedGhost, type BBox } from "./ChangeMark";
import { Gate } from "./Gate";
import { PartContext, usePart } from "./partContext";
import { StatusLine } from "./StatusLine";
import { SvgText, type TextAlign } from "./SvgText";
import {
  stateAt,
  type DiagramFrame,
  type DiagramPose,
  type Timeline,
} from "./timeline";
import type { UniversalState } from "./universalStates";
import { useReducedMotion } from "./useReducedMotion";

/** Every part is drawn in its own 640×400 logical space, rail centre Y = 200 (VL-01). */
export const PART_WIDTH = 640;
export const PART_HEIGHT = 400;
export const RAIL_Y = 200;

/** Composition footprints: S 0.5, M 0.75, L 1 (catalogue "Footprint"). */
export const FOOTPRINT_SCALE = { S: 0.5, M: 0.75, L: 1 } as const;
export type Footprint = keyof typeof FOOTPRINT_SCALE;

export type PartView =
  | { readonly kind: "scenario"; readonly name: string }
  | { readonly kind: "state"; readonly state: UniversalState };

export interface MachinePartProps {
  part: PartIdentity;
  /** Frame bounding box in part space (where change marks and the ghost sit). */
  bb: BBox;
  timeline: Timeline;
  t: number;
  /** What the accessible text announces: a scenario or a universal state. */
  view: PartView;
  /** idle / absent still poses; `removed` is implied by `change`. */
  pose?: Exclude<DiagramPose, "removed">;
  change?: Mark;
  /** Line under the name saying what changed (~ changed). */
  changeNote?: string;
  /** Tab position override for the change mark. */
  tab?: readonly [number, number];
  /** Status line anchor in part space. */
  status: { x: number; y: number; align?: TextAlign };
  /** Placement in the enclosing diagram. */
  x?: number;
  y?: number;
  /**
   * Scale in the composition. Labels are only drawn at scale ≥ 1 so text is
   * never under 18 px; smaller cells name the part beside it instead.
   */
  scale?: number;
  /** Show text; defaults to the enclosing diagram's setting. */
  labels?: boolean;
  /** Draw the name · job title and "also" line. */
  title?: boolean;
  /** Draw smear ghosts (still views turn this off). */
  smear?: boolean;
  /** Override the prefers-reduced-motion media query. */
  reducedMotion?: boolean;
  /** Rails, frame and mechanism; receives the resolved frame. */
  children?: (frame: DiagramFrame) => ReactNode;
}

/**
 * One part: its fixtures (children), then the status line, cards, gates,
 * the removed/absent ghost, the title and the change mark — the gallery's
 * drawing order. Rendering is a pure function of `t` via `stateAt`.
 */
export function MachinePart({
  part,
  bb,
  timeline,
  t,
  view,
  pose = "live",
  change = "unchanged",
  changeNote,
  tab,
  status,
  x = 0,
  y = 0,
  scale = 1,
  labels,
  title = true,
  smear = true,
  reducedMotion,
  children,
}: MachinePartProps) {
  const parent = usePart();
  const prefersReduced = useReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const effective: DiagramPose = change === "removed" ? "removed" : pose;
  const frame = useMemo(
    () =>
      stateAt(timeline, t, { pose: effective, reducedMotion: reduced, smear }),
    [timeline, t, effective, reduced, smear]
  );
  const ghosted = effective === "removed" || effective === "absent";
  const showLabels = (labels ?? parent.labels) && scale >= 1;
  const ctx = useMemo(
    () => ({
      ...parent,
      fade: ghosted ? 1 : frame.fade,
      removed: ghosted,
      labels: showLabels,
    }),
    [parent, ghosted, frame.fade, showLabels]
  );
  const label =
    view.kind === "state"
      ? stateLabel(part, view.state, change)
      : scenarioLabel(part, view.name, change);
  const transform =
    x || y || scale !== 1
      ? `translate(${x} ${y})${scale !== 1 ? ` scale(${scale})` : ""}`
      : undefined;

  return (
    <PartContext.Provider value={ctx}>
      <g
        className="md-part"
        role="img"
        aria-label={label}
        data-part={part.name}
        data-pose={effective}
        transform={transform}
      >
        {children?.(frame)}
        <StatusLine
          status={frame.status}
          x={status.x}
          y={status.y}
          align={status.align}
        />
        {frame.cards.map((c) => (
          <Card key={c.index} frame={c} />
        ))}
        {frame.gates.map((g, i) => (
          <Gate key={i} frame={g} />
        ))}
        {ghosted && (
          <RemovedGhost bb={bb} width={PART_WIDTH} height={PART_HEIGHT} />
        )}
        {title && (
          <>
            <SvgText
              x={24}
              y={36}
              runs={[
                [part.name, 600, "ink"],
                [`  ·  ${part.job}`, 400, "dim"],
              ]}
              size={22}
            />
            {change === "changed" && changeNote && (
              <SvgText
                x={24}
                y={64}
                runs={[[changeNote, 400, "dim"]]}
                size={18}
              />
            )}
            {part.aka && (
              <SvgText
                x={24}
                y={380}
                runs={[[`also  ${part.aka}`, 400, "dim"]]}
                size={18}
              />
            )}
          </>
        )}
        <ChangeMark mark={change} bb={bb} tab={tab} />
      </g>
    </PartContext.Provider>
  );
}
