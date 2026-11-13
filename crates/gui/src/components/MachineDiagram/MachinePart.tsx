import {
  useMemo,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  scenarioLabel,
  stateLabel,
  type ChangeMark as Mark,
  type PartIdentity,
} from "./accessibility";
import { Card } from "./Card";
import { ChangeMark, RemovedGhost, type BBox } from "./ChangeMark";
import { Gate } from "./Gate";
import { isActivationKey, useDiagramInteraction } from "./interaction";
import { PartContext, usePart } from "./partContext";
import { PART_HEIGHT, PART_WIDTH } from "./partGeometry";
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

export {
  FOOTPRINT_SCALE,
  PART_HEIGHT,
  PART_WIDTH,
  RAIL_Y,
  type Footprint,
} from "./partGeometry";

export type PartView =
  | { readonly kind: "scenario"; readonly name: string }
  | { readonly kind: "state"; readonly state: UniversalState };

export interface MachinePartProps {
  part: PartIdentity;
  /** Stable id from a flow spec (`data-part-id`), so cards and evidence can find the part. */
  id?: string;
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
  /** Before/After morph progress while the change mark arrives (see ChangeMark). */
  markMorph?: number;
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
  /** Appended to an interactive part's accessible name (what activation does). */
  activationHint?: string;
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
  id,
  bb,
  timeline,
  t,
  view,
  pose = "live",
  change = "unchanged",
  changeNote,
  tab,
  markMorph,
  status,
  x = 0,
  y = 0,
  scale = 1,
  labels,
  title = true,
  smear = true,
  activationHint,
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
  const interaction = useDiagramInteraction();
  const interactive =
    id !== undefined && interaction?.onActivatePart !== undefined;
  const transform =
    x || y || scale !== 1
      ? `translate(${x} ${y})${scale !== 1 ? ` scale(${scale})` : ""}`
      : undefined;

  return (
    <PartContext.Provider value={ctx}>
      <g
        className="md-part"
        role={interactive ? "button" : "img"}
        aria-label={
          interactive
            ? `${label} Now: ${frame.status.current.text}.${activationHint ? ` ${activationHint}` : ""}`
            : label
        }
        data-part={part.name}
        data-part-id={id}
        data-pose={effective}
        transform={transform}
        {...(interactive && id !== undefined
          ? partHandlers(id, interaction!)
          : {})}
        data-active={
          interactive && interaction?.activePart === id ? "true" : undefined
        }
      >
        {interactive && <PartHit bb={bb} />}
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
        <ChangeMark mark={change} bb={bb} tab={tab} morph={markMorph} />
        {interactive && <PartRing bb={bb} />}
      </g>
    </PartContext.Provider>
  );
}

/** Padding of the hover/focus target and ring around a part's frame. */
const RING_PAD = 14;

/** Transparent target so the whole frame, not just its strokes, takes hover. */
function PartHit({ bb }: { bb: BBox }) {
  return (
    <rect
      className="md-part-hit"
      x={bb[0] - RING_PAD}
      y={bb[1] - RING_PAD}
      width={bb[2] + RING_PAD * 2}
      height={bb[3] + RING_PAD * 2}
      fill="transparent"
    />
  );
}

/** Focus / hover / selected ring, shown by MachineDiagram.css. */
function PartRing({ bb }: { bb: BBox }) {
  return (
    <rect
      className="md-part-ring"
      x={bb[0] - RING_PAD}
      y={bb[1] - RING_PAD}
      width={bb[2] + RING_PAD * 2}
      height={bb[3] + RING_PAD * 2}
      rx={14}
      fill="none"
      pointerEvents="none"
    />
  );
}

function partHandlers(
  id: string,
  i: NonNullable<ReturnType<typeof useDiagramInteraction>>
) {
  return {
    tabIndex: 0,
    onClick: () => i.onActivatePart?.(id),
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
      if (!isActivationKey(e.key) || e.target !== e.currentTarget) return;
      e.preventDefault();
      e.stopPropagation();
      i.onActivatePart?.(id);
    },
    onMouseEnter: () => i.onInspectPart?.(id),
    onMouseLeave: () => i.onInspectPart?.(null),
    onFocus: (e: FocusEvent<SVGGElement>) => {
      if (e.target === e.currentTarget) i.onInspectPart?.(id);
    },
    onBlur: (e: FocusEvent<SVGGElement>) => {
      if (e.target === e.currentTarget) i.onInspectPart?.(null);
    },
  };
}
