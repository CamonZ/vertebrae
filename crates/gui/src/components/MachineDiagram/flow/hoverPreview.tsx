/* eslint-disable react-refresh/only-export-components -- preview builders with their private payload component */
/**
 * Hover previews: a short looping run of a part's own mechanism while the
 * pointer (or keyboard focus) rests on it, with a payload card going
 * through, so a station or step shows what it does instead of sitting still.
 * Nothing here claims an observed TaskRun: the preview is the part's generic
 * motion, never live state, and its card carries no tags.
 *
 *   workflow   the card rides the track lamp to lamp; each lamp runs, then completes
 *   factory    the card rides dock to dock; each workflow mark runs, then completes
 *   route      the card waits at the pivot while each decision row is tried in
 *              order; the last row takes it out
 *   step       the catalogue scenario plays with its card, clipped to the part
 *
 * Under reduced motion the clock advances in whole beats, so states change
 * and the card jumps without tweening.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { Card } from "../Card";
import { RAIL_Y } from "../MachinePart";
import { roleColor, type CardRole } from "../palette";
import { MACHINE_PARTS } from "../parts";
import { factoryMachine } from "../parts/factory";
import { workflowMachine, type WorkflowLampStep } from "../parts/workflow";
import { EDGE_IN, EDGE_OUT } from "../parts/workflowSpec";
import { SvgText } from "../SvgText";
import { stateAt, type CardFrame } from "../timeline";
import type { DiagramPart } from "./compile";
import { factoryExtra, type FactoryState } from "./parts/factory";
import { routeTopology } from "./parts/topology";
import { workflowExtra, type WorkflowState } from "./parts/workflow";

type Point = readonly [number, number];

export interface HoverPreview {
  /** Loop length, seconds. */
  readonly period: number;
  readonly draw: (t: number, reducedMotion: boolean) => ReactNode;
}

/** One lamp's (or decision's) beat, seconds. */
export const PREVIEW_BEAT = 0.45;
/** The card's entry before the first beat, and the hold before the loop restarts. */
export const PREVIEW_LEAD = 0.5;
const LEAD = PREVIEW_LEAD;
const HOLD = 0.9;
/** How long a card takes to hop between stops. */
const HOP = 0.18;

/** Lamps lit in order: each runs for one beat, then completes. */
export function sequenceLamps(count: number): WorkflowLampStep[][] {
  return Array.from({ length: count }, (_, i) => [
    [0, "off"],
    [LEAD + i * PREVIEW_BEAT, "run"],
    [LEAD + (i + 1) * PREVIEW_BEAT, "ok"],
  ]);
}
const sequencePeriod = (count: number) => LEAD + count * PREVIEW_BEAT + HOLD;

const lerp = (a: Point, b: Point, k: number): Point => {
  const f = Math.max(0, Math.min(1, k));
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
};

/**
 * Where the card is on a path of stops it seats at, one per beat after an
 * entry leg; it leaves along `exit` after the last beat, or null once gone.
 */
export function hopAt(
  t: number,
  entry: Point,
  stops: readonly Point[],
  exit: Point | null
): Point | null {
  if (!stops.length) return null;
  if (t < LEAD) return lerp(entry, stops[0], t / LEAD);
  const beat = Math.floor((t - LEAD) / PREVIEW_BEAT);
  if (beat < stops.length) {
    const into = t - LEAD - beat * PREVIEW_BEAT;
    return beat === 0
      ? stops[0]
      : lerp(stops[beat - 1], stops[beat], into / HOP);
  }
  const after = t - LEAD - stops.length * PREVIEW_BEAT;
  if (!exit) return after < HOLD / 2 ? stops[stops.length - 1] : null;
  return after < HOLD / 2
    ? lerp(stops[stops.length - 1], exit, after / (HOLD / 2))
    : null;
}

/** A plain payload card: ink, untagged, not interactive. */
function payload(at: Point, role: CardRole = "ink", index = 0): CardFrame {
  return {
    index,
    x: at[0],
    y: at[1],
    w: 28,
    h: 18,
    dot: false,
    hollow: false,
    badge: false,
    role,
    alpha: 1,
    angle: 0,
    ghosts: [],
    tags: [],
  };
}

/** Cards clipped to the part's span, so they enter and leave at its ports. */
function Payload({
  cards,
  span,
}: {
  cards: readonly CardFrame[];
  span: readonly [number, number];
}) {
  const id = useId();
  if (!cards.length) return null;
  return (
    <g className="md-preview-payload" pointerEvents="none">
      <clipPath id={id}>
        <rect
          x={span[0]}
          y={-1e4}
          width={Math.max(0, span[1] - span[0])}
          height={2e4}
        />
      </clipPath>
      <g clipPath={`url(#${id})`}>
        {cards.map((c) => (
          <Card key={c.index} frame={c} />
        ))}
      </g>
    </g>
  );
}

const portX = (p: DiagramPart, name: string, fallback: number) =>
  p.ports[name]?.local[0] ?? fallback;

const STEP_KINDS = [
  "inference step",
  "structured step",
  "execute step",
  "wait children",
  "human gate",
] as const;
type StepKind = (typeof STEP_KINDS)[number];
const isStepKind = (kind: string): kind is StepKind =>
  (STEP_KINDS as readonly string[]).includes(kind);

function workflowPreview(p: DiagramPart): HoverPreview | null {
  const extra = workflowExtra(p.state as WorkflowState);
  const L = extra.layout;
  if (!L.lamps.length) return null;
  const lamps = sequenceLamps(L.lamps.length);
  const stops = L.lamps.map((l): Point => [l.x, L.ty]);
  const exit: Point | null = L.outs.length ? [EDGE_OUT, L.outs[0].y] : null;
  return {
    period: sequencePeriod(L.lamps.length),
    draw: (t) => {
      const at = hopAt(t, [EDGE_IN, L.ty], stops, exit);
      return (
        <>
          {workflowMachine.draw(t, { ...extra, lamps })}
          <Payload
            cards={at ? [payload(at)] : []}
            span={[portX(p, "in", EDGE_IN), EDGE_OUT]}
          />
        </>
      );
    },
  };
}

function factoryPreview(p: DiagramPart): HoverPreview | null {
  const extra = factoryExtra(p.state as FactoryState);
  const L = extra.layout;
  if (!L.marks.length) return null;
  const marks = sequenceLamps(L.marks.length);
  const stops = L.marks.map((m) => m.dock);
  const entry: Point = [EDGE_IN, L.ins[0]?.y ?? stops[0][1]];
  const exit: Point | null = L.outs.length ? [EDGE_OUT, L.outs[0].y] : null;
  return {
    period: sequencePeriod(L.marks.length),
    draw: (t) => {
      const at = hopAt(t, entry, stops, exit);
      return (
        <>
          {factoryMachine.draw(t, { ...extra, marks })}
          <Payload cards={at ? [payload(at)] : []} span={[EDGE_IN, EDGE_OUT]} />
        </>
      );
    },
  };
}

/** The pivot the topology route draws its decisions from. */
const PIVOT: Point = [220, RAIL_Y];

function routePreview(p: DiagramPart): HoverPreview | null {
  const props = {
    decisions: Array.isArray(p.props.decisions) ? p.props.decisions : [],
    defaultDecision: p.props.defaultDecision === true,
  };
  const { rows } = routeTopology(props);
  if (!rows.length) return null;
  const base = MACHINE_PARTS["route step"].draw(0, {
    topology: props,
    tiles: [],
    arm: [1e9, 0],
  });
  const inX = portX(p, "in", 200);
  // The card waits at the pivot while each row is tried, then leaves by the last.
  const last = rows[rows.length - 1];
  const exit: Point = [last.x + 40, last.y];
  const stops = rows.map(() => PIVOT);
  return {
    period: sequencePeriod(rows.length),
    draw: (t) => {
      const beat = Math.floor((t - LEAD) / PREVIEW_BEAT);
      const done = beat >= rows.length;
      const at =
        done && t - LEAD - rows.length * PREVIEW_BEAT < HOLD / 2
          ? hopOut((t - LEAD - rows.length * PREVIEW_BEAT) / (HOLD / 2), last)
          : hopAt(t, [inX - 40, RAIL_Y], stops, null);
      return (
        <>
          {base}
          {rows.map((row, i) => {
            const role: CardRole | null =
              i === rows.length - 1 && done
                ? "green"
                : i === beat
                  ? "amber"
                  : null;
            return role ? (
              <g key={row.id} data-preview-row={row.id} data-role={role}>
                <line
                  x1={row.x - 32}
                  y1={row.y}
                  x2={row.x}
                  y2={row.y}
                  stroke={roleColor(role)}
                  strokeWidth={4}
                  strokeLinecap="round"
                />
                <SvgText
                  x={240}
                  y={row.y + 1}
                  runs={[[row.label, 600, role]]}
                  size={18}
                />
              </g>
            ) : null;
          })}
          <Payload cards={at ? [payload(at)] : []} span={[inX, exit[0] - 40]} />
        </>
      );
    },
  };
}

/** From the pivot down to the chosen row, then out along it. */
function hopOut(k: number, row: { x: number; y: number }): Point {
  const corner: Point = [PIVOT[0], row.y];
  const end: Point = [row.x + 20, row.y];
  return k < 0.4
    ? lerp(PIVOT, corner, k / 0.4)
    : lerp(corner, end, (k - 0.4) / 0.6);
}

function stepPreview(p: DiagramPart, kind: StepKind): HoverPreview {
  const def = MACHINE_PARTS[kind];
  const scenario = def.scenarios[0];
  // As the topology still: the gate's example question stays hidden.
  const extra =
    kind === "human gate"
      ? { ...(scenario.extra as object), topology: true }
      : scenario.extra;
  const draw = def.draw as (t: number, extra: unknown) => ReactNode;
  const span: [number, number] = [
    portX(p, "in", p.bb[0]),
    portX(p, "out", p.bb[0] + p.bb[2]),
  ];
  return {
    period: scenario.timeline.period,
    draw: (t, reducedMotion) => {
      const cards = stateAt(scenario.timeline, t, { reducedMotion }).cards.map(
        // Untagged and anonymous: the scenario's words are not this step's.
        (c) => ({ ...c, id: undefined, tags: [] })
      );
      return (
        <>
          {draw(t, extra)}
          <Payload cards={cards} span={span} />
        </>
      );
    },
  };
}

/** The preview a compiled part plays on hover, or null when it has none. */
export function hoverPreview(p: DiagramPart): HoverPreview | null {
  if (p.kind === "workflow") return workflowPreview(p);
  if (p.kind === "factory") return factoryPreview(p);
  if (!p.props.topology) return null;
  if (p.kind === "route step") return routePreview(p);
  if (isStepKind(p.kind)) return stepPreview(p, p.kind);
  return null;
}

/**
 * Seconds into the preview loop while `period` is set; 0 otherwise. Frames
 * run only while a preview plays; reduced motion snaps to whole beats.
 */
export function usePreviewClock(
  period: number | null,
  reducedMotion: boolean
): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (period === null) {
      setT(0);
      return;
    }
    let start: number | null = null;
    let frame = requestAnimationFrame(function tick(now) {
      start ??= now;
      const s = ((now - start) / 1000) % period;
      setT(reducedMotion ? Math.floor(s / PREVIEW_BEAT) * PREVIEW_BEAT : s);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [period, reducedMotion]);
  return t;
}
