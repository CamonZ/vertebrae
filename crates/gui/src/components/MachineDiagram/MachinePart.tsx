import {
  useMemo,
  useState,
  useContext,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  scenarioLabel,
  stateLabel,
  type ChangeMark as Mark,
  type PartIdentity,
} from "./accessibility";
import { roleColor } from "./palette";
import { createPortal } from "react-dom";
import { LabelLayerContext } from "./labelLayer";
import { placedLabels, type PartLabels } from "./partLabels";
import { Card } from "./Card";
import { ChangeMark, RemovedGhost, tabWidth, type BBox } from "./ChangeMark";
import { Gate } from "./Gate";
import { isActivationKey, useDiagramInteraction } from "./interaction";
import { PartContext, usePart } from "./partContext";
import {
  applyRect,
  besideAxis,
  partTurn,
  svgMatrix,
  tabAnchor,
  titleAnchors,
  turnStatus,
  turnedLabelGeometry,
  type FlowDirection,
} from "./orientation";
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
  /** Static structure has no observed execution status to display or announce. */
  neutral?: boolean;
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
  labelPlacement?: PartLabels;
  /** Appended to an interactive part's accessible name (what activation does). */
  activationHint?: string;
  /** Additional current information included in the accessible name. */
  accessibleDetail?: string;
  /**
   * Flow direction the part is turned for (default right: as drawn). The
   * mechanism, cards and gates turn; the title, status line and change
   * mark are placed in the turned cell and stay upright.
   */
  direction?: FlowDirection;
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
  neutral = false,
  x = 0,
  y = 0,
  scale = 1,
  labels,
  title = true,
  labelPlacement,
  smear = true,
  activationHint,
  accessibleDetail,
  reducedMotion,
  direction = "right",
  children,
}: MachinePartProps) {
  const parent = usePart();
  const layer = useContext(LabelLayerContext);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
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
  const turn = direction === "right" ? undefined : direction;
  const turnedCtx = useMemo(() => ({ ...ctx, turn }), [ctx, turn]);
  /** Drawn in part space, turned with the part. */
  const turned = (node: ReactNode) =>
    turn ? (
      <PartContext.Provider value={turnedCtx}>
        <g transform={svgMatrix(partTurn(turn))}>{node}</g>
      </PartContext.Provider>
    ) : (
      node
    );
  const flatBb = turn ? applyRect(partTurn(turn), bb) : bb;
  const flatStatus = turn ? turnStatus(turn, status) : status;
  const anchors = titleAnchors(direction, bb);
  const flatTab =
    tab ??
    (change === "unchanged"
      ? undefined
      : tabAnchor(direction, bb, tabWidth(change)));
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

  const reveal =
    labelPlacement?.title === "hover" || labelPlacement?.subtitle === "hover";
  const handlers =
    interactive && id !== undefined
      ? partHandlers(id, interaction!)
      : undefined;
  const labelLines = (hover: boolean) =>
    labelPlacement && title && (labels ?? parent.labels) ? (
      <PartContext.Provider value={{ ...ctx, labels: true }}>
        <g
          transform={`scale(${1 / scale})`}
          pointerEvents="none"
          aria-hidden
          data-part-labels={id ?? part.name}
        >
          {besideAxis(
            direction,
            scale,
            placedLabels({
              identity: part,
              ...turnedLabelGeometry(direction, bb, timeline),
              scale,
              labels: labelPlacement,
              change,
              changeNote,
            })
          )
            .filter((l) => l.hover === hover && (!hover || hovered || focused))
            .map((l) => (
              <g key={l.key}>
                {hover && (
                  <rect
                    x={l.box.x0 - 6}
                    y={l.box.y0 - 3}
                    width={l.box.x1 - l.box.x0 + 12}
                    height={l.box.y1 - l.box.y0 + 6}
                    rx={4}
                    fill={roleColor("bg")}
                  />
                )}
                <SvgText
                  x={l.x}
                  y={l.y}
                  size={l.size}
                  runs={[[l.text, l.weight, l.role]]}
                />
              </g>
            ))}
        </g>
      </PartContext.Provider>
    ) : null;
  return (
    <PartContext.Provider value={ctx}>
      <g
        className="md-part"
        role={interactive ? "button" : "img"}
        aria-label={
          interactive
            ? `${label}${neutral ? "" : ` Now: ${frame.status.current.text}.`}${activationHint ? ` ${activationHint}` : ""}${accessibleDetail ? ` ${accessibleDetail}` : ""}`
            : label
        }
        data-part={part.name}
        data-part-id={id}
        data-pose={effective}
        transform={transform}
        {...handlers}
        {...(reveal
          ? {
              tabIndex: 0,
              onMouseEnter: () => {
                setHovered(true);
                handlers?.onMouseEnter();
              },
              onMouseLeave: () => {
                setHovered(false);
                handlers?.onMouseLeave();
              },
              onFocus: (e: FocusEvent<SVGGElement>) => {
                setFocused(true);
                handlers?.onFocus(e);
              },
              onBlur: (e: FocusEvent<SVGGElement>) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setFocused(false);
                handlers?.onBlur(e);
              },
            }
          : {})}
        data-active={
          interactive && interaction?.activePart === id ? "true" : undefined
        }
      >
        {turned(
          <>
            {(interactive || reveal) && <PartHit bb={bb} />}
            {children?.(frame)}
          </>
        )}
        {!neutral && (
          <StatusLine
            status={frame.status}
            x={flatStatus.x}
            y={flatStatus.y}
            align={flatStatus.align}
          />
        )}
        {turned(
          <>
            {frame.cards.map((c) => (
              <Card key={c.index} frame={c} />
            ))}
            {frame.gates.map((g, i) => (
              <Gate key={i} frame={g} />
            ))}
            {ghosted && (
              <RemovedGhost bb={bb} width={PART_WIDTH} height={PART_HEIGHT} />
            )}
          </>
        )}
        {title && (
          <>
            {!labelPlacement && (
              <SvgText
                x={anchors.title[0]}
                y={anchors.title[1]}
                runs={[
                  [part.name, 600, "ink"],
                  [`  ·  ${part.job}`, 400, "dim"],
                ]}
                size={22}
              />
            )}
            {change === "changed" && changeNote && (
              <SvgText
                x={anchors.note[0]}
                y={anchors.note[1]}
                runs={[[changeNote, 400, "dim"]]}
                size={18}
              />
            )}
            {part.aka && (
              <SvgText
                x={anchors.aka[0]}
                y={anchors.aka[1]}
                runs={[[`also  ${part.aka}`, 400, "dim"]]}
                size={18}
              />
            )}
          </>
        )}
        <ChangeMark mark={change} bb={flatBb} tab={flatTab} morph={markMorph} />
        {(interactive || reveal) && turned(<PartRing bb={bb} />)}
        {labelLines(false)}
        {(hovered || focused) &&
          (layer
            ? createPortal(
                <g transform={transform}>{labelLines(true)}</g>,
                layer
              )
            : labelLines(true))}
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
    ...(i.onOpenPart
      ? {
          onDoubleClick: (e: MouseEvent<SVGGElement>) => {
            e.stopPropagation();
            i.onOpenPart?.(id);
          },
        }
      : {}),
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
      if (!isActivationKey(e.key) || e.target !== e.currentTarget) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Enter" && i.onOpenPart) i.onOpenPart(id);
      else i.onActivatePart?.(id);
    },
    onMouseEnter: () => {
      i.onInspectPart?.(id);
      i.onHoverPart?.(id);
    },
    onMouseLeave: () => {
      i.onInspectPart?.(null);
      i.onHoverPart?.(null);
    },
    onFocus: (e: FocusEvent<SVGGElement>) => {
      if (e.target === e.currentTarget) {
        i.onInspectPart?.(id);
        i.onFocusPart?.(id);
      }
    },
    onBlur: (e: FocusEvent<SVGGElement>) => {
      if (e.target === e.currentTarget) {
        i.onInspectPart?.(null);
        i.onFocusPart?.(null);
      }
    },
  };
}
