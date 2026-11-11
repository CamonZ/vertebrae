/**
 * Scenario timelines and the pure frame function `stateAt(timeline, t)`.
 *
 * A timeline is authored data: cards travelling on rails (legs), the gates
 * they cross, and the status notes. `stateAt` resolves every position,
 * opacity, lean, gate opening and status-line swap for one instant, so any
 * frame is deterministic and can be rendered forwards, backwards or at random.
 * Nothing here schedules time; the caller (player, still view, test) owns `t`.
 */
import {
  LEAN_DEGREES,
  SMEAR_GHOSTS,
  SMEAR_STEP,
  STATUS_SWAP,
  loopFade,
  smoothstep,
  thrown,
  valueAt,
  windowed,
} from "./motion";
import type { CardRole, StateRole } from "./palette";
import { pointAt, route, type Point, type Route } from "./route";

export interface CardTag {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  /** Offset from the card centre; tags ride 22 px above by default. */
  readonly dy: number;
}

export interface CardLeg {
  readonly route: Route;
  /** Start time of the leg. */
  readonly t: number;
  /** Duration until the thrown spring first reaches the end. */
  readonly d: number;
}

/**
 * What a card carries, so it can be inspected and followed (token kinds and
 * tags in the catalogue). `type` is a payload kind such as `symbol`,
 * `timestamp`, `value`, `version`, `session` or `text`.
 */
export interface CardPayload {
  readonly type: string;
  readonly value: string | number | boolean | null;
  /** When the fact happened, as opposed to when the card arrives (shared clock seconds or a label). */
  readonly eventTime?: number | string;
  readonly fields?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CardSpec {
  /** Stable identity across parts and rails (one id per authored card). */
  readonly id?: string;
  readonly payload?: CardPayload;
  readonly w: number;
  readonly h: number;
  /** Small round signal or event dot instead of a rectangular card. */
  readonly dot: boolean;
  /** Control card (cancel, stop, resume, approve): outline only, no smear. */
  readonly hollow: boolean;
  readonly badge: boolean;
  /** Colour over time, `[from, role]`, first entry at -∞. */
  readonly colors: readonly (readonly [number, CardRole])[];
  readonly legs: readonly CardLeg[];
  readonly born: number;
  readonly dies: number;
  readonly tags: readonly CardTag[];
  /** Times at which the card leans 38° as it leaves a slot. */
  readonly lean: readonly number[];
}

export type GateOrientation = "v" | "h";

export interface GateSpec {
  readonly x: number;
  readonly y: number;
  /** `v`: the two pills sit above and below a horizontal rail. */
  readonly orientation: GateOrientation;
  /** Optional amber hold (0..1), e.g. while plates clamp a card. */
  readonly amber?: (t: number) => number;
}

export type StatusNote = readonly [t: number, text: string, role: StateRole];

/** A diagram-wide beat: one caption explaining what happens from `t` on. */
export interface Beat {
  readonly t: number;
  readonly caption: string;
  readonly id?: string;
}

/**
 * Timeline markers explain behaviour without drawing it: a durable
 * checkpoint, the arrival order of a card at a part (vs its event time), or
 * a lifecycle event such as `spawn` / `resume`.
 */
export interface TimelineMarker {
  readonly t: number;
  readonly kind: string;
  readonly label: string;
  /** Spec id of the part the marker belongs to. */
  readonly part?: string;
  readonly card?: string;
  /** Arrival markers: spec id of the rail the card arrived on. */
  readonly rail?: string;
  /** Arrival markers: 1-based arrival order at the part. */
  readonly order?: number;
  readonly eventTime?: number | string;
}

export interface Timeline {
  readonly period: number;
  readonly cards: readonly CardSpec[];
  readonly gates: readonly GateSpec[];
  /** Sorted by time; starts with `idle` at 0 and returns to it before the loop ends. */
  readonly notes: readonly StatusNote[];
  /**
   * Diagram-wide beats on a shared clock. When present, reduced motion snaps
   * to the outcome of the current beat instead of the current status note.
   */
  readonly beats?: readonly Beat[];
  readonly markers?: readonly TimelineMarker[];
}

/* ---------- authoring ---------- */

export type LegInput = readonly [
  path: readonly Point[] | Route,
  t: number,
  d: number,
];
export type TagInput = readonly [
  text: string,
  from: number,
  to: number,
  dy?: number,
];

export interface CardOptions {
  id?: string;
  payload?: CardPayload;
  h?: number;
  dot?: boolean;
  hollow?: boolean;
  badge?: boolean;
  /** Colour changes after the initial role: `[[t, role], ...]`. */
  col?: readonly (readonly [number, CardRole])[];
  tags?: readonly TagInput[];
  lean?: readonly number[];
}

const isRoute = (p: readonly Point[] | Route): p is Route => "cumulative" in p;

export function card(
  w: number,
  role: CardRole,
  legs: readonly LegInput[],
  born: number,
  dies: number,
  o: CardOptions = {}
): CardSpec {
  return {
    ...(o.id !== undefined ? { id: o.id } : {}),
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
    w,
    h: o.h ?? w * 0.64,
    dot: o.dot ?? false,
    hollow: o.hollow ?? false,
    badge: o.badge ?? false,
    colors: [[-1e9, role], ...(o.col ?? [])],
    legs: legs.map(([p, t, d]) => ({ route: isRoute(p) ? p : route(p), t, d })),
    born,
    dies,
    tags: (o.tags ?? []).map(([text, from, to, dy]) => ({
      text,
      from,
      to,
      dy: dy || -22,
    })),
    lean: o.lean ?? [],
  };
}

/** A leg that holds a card still at one point from `t`. */
export const stay = (x: number, y: number, t: number): LegInput => [
  [
    [x, y],
    [x, y],
  ],
  t,
  0.05,
];

/** A signal / event dot travelling one path. */
export function dot(
  pts: readonly Point[],
  at: number,
  d: number,
  role: CardRole = "ink",
  o: CardOptions & { dies?: number } = {}
): CardSpec {
  return card(14, role, [[pts, at, d]], at, o.dies ?? at + d + 0.05, {
    ...o,
    dot: true,
  });
}

export const gateV = (
  x: number,
  y: number,
  amber?: (t: number) => number
): GateSpec => ({
  x,
  y,
  orientation: "v",
  amber,
});
export const gateH = (
  x: number,
  y: number,
  amber?: (t: number) => number
): GateSpec => ({
  x,
  y,
  orientation: "h",
  amber,
});

/** Mutable builder for one scenario; `seal` freezes it into a Timeline. */
export interface StoryDraft {
  period: number;
  cards: CardSpec[];
  gates: GateSpec[];
  notes: [number, string, StateRole][];
}

export function story(period: number): StoryDraft {
  return { period, cards: [], gates: [], notes: [[0, "idle", "dim"]] };
}

export function note(
  s: StoryDraft,
  t: number,
  text: string,
  role: StateRole = "dim"
) {
  s.notes.push([t, text, role]);
}

/** Return-to-idle note time, before the last 0.6 s fade completes. */
export const IDLE_RETURN = 0.45;

export function seal(s: StoryDraft): Timeline {
  const notes = [...s.notes].sort((a, b) => a[0] - b[0]);
  notes.push([s.period - IDLE_RETURN, notes[0][1], notes[0][2]]);
  return { period: s.period, cards: [...s.cards], gates: [...s.gates], notes };
}

/* ---------- evaluation ---------- */

export function cardPosition(c: CardSpec, t: number): Point {
  let j = 0;
  for (let i = 0; i < c.legs.length; i++) if (c.legs[i].t <= t) j = i;
  const leg = c.legs[j];
  return pointAt(leg.route, thrown(t - leg.t, leg.d));
}

export function cardRole(c: CardSpec, t: number): CardRole {
  return valueAt(c.colors, t);
}

/** Opacity before the loop fade: in over 0.1 s from birth, out over 0.12 s. */
export function cardOpacity(c: CardSpec, t: number): number {
  return (
    smoothstep(c.born, c.born + 0.1, t) *
    (1 - smoothstep(c.dies, c.dies + 0.12, t))
  );
}

export function cardLean(c: CardSpec, t: number): number {
  let lean = 0;
  for (const at of c.lean)
    lean += smoothstep(at - 0.22, at, t) * (1 - smoothstep(at, at + 0.3, t));
  return lean * LEAN_DEGREES;
}

/** Cards considered at `t` (a 0.2 s margin either side of their life). */
export function isLive(c: CardSpec, t: number): boolean {
  return t >= c.born - 0.2 && t <= c.dies + 0.2;
}

/** Gate opening 0..1: pills part while a card is within 30 px (VL-05). */
export function gateOpening(
  g: GateSpec,
  cards: readonly CardSpec[],
  t: number
): number {
  let open = 0;
  for (const c of cards) {
    if (c.dot) continue;
    for (let k = -3; k <= 4; k++) {
      const tt = t + k * 0.04;
      if (tt < c.born || tt > c.dies) continue;
      const p = cardPosition(c, tt);
      open = Math.max(
        open,
        1 - smoothstep(10, 30, Math.hypot(p[0] - g.x, p[1] - g.y))
      );
    }
  }
  return open;
}

export interface StatusText {
  readonly text: string;
  readonly role: StateRole;
  /** Vertical offset from the status line's baseline position. */
  readonly dy: number;
  readonly alpha: number;
}

export interface StatusFrame {
  readonly current: StatusText;
  /** The outgoing line while a swap is in progress. */
  readonly previous: StatusText | null;
}

/** Index of the note showing at `t`. */
export function noteIndex(notes: readonly StatusNote[], t: number): number {
  let i = 0;
  while (i + 1 < notes.length && notes[i + 1][0] <= t) i++;
  return i;
}

/**
 * Status line at `t` (VL-04): the old text rises 16 px and fades within
 * 0.1 s; the new one rises in from 14 px. `swap: false` shows the settled line.
 */
export function statusAt(
  notes: readonly StatusNote[],
  t: number,
  swap = true
): StatusFrame {
  const i = noteIndex(notes, t);
  const [at, text, role] = notes[i];
  const dt = t - at;
  if (!swap || i === 0 || dt >= STATUS_SWAP.inDuration) {
    return { current: { text, role, dy: 0, alpha: 1 }, previous: null };
  }
  const [, ptext, prole] = notes[i - 1];
  const k = smoothstep(0, STATUS_SWAP.outDuration, dt);
  return {
    previous: {
      text: ptext,
      role: prole,
      dy: -STATUS_SWAP.outDistance * k,
      alpha: 1 - k,
    },
    current: {
      text,
      role,
      dy:
        STATUS_SWAP.inDistance *
        (1 - smoothstep(0, STATUS_SWAP.inDuration, dt)),
      alpha: smoothstep(0.08, 0.24, dt),
    },
  };
}

/** A fixed status line (idle, absent, removed). */
export const fixedStatus = (
  text: string,
  role: StateRole = "dim"
): StatusFrame => ({
  current: { text, role, dy: 0, alpha: 1 },
  previous: null,
});

export interface GhostFrame {
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
}

export interface TagFrame {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly alpha: number;
  readonly role: CardRole;
}

export interface CardFrame {
  /** Index into `timeline.cards` (stable React key). */
  readonly index: number;
  /** The card's stable id when it has one (follow a card across parts). */
  readonly id?: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly dot: boolean;
  readonly hollow: boolean;
  readonly badge: boolean;
  readonly role: CardRole;
  readonly alpha: number;
  /** Lean in degrees. */
  readonly angle: number;
  /** Smear ghosts, oldest first. Empty when smear is off or the card is hollow. */
  readonly ghosts: readonly GhostFrame[];
  readonly tags: readonly TagFrame[];
}

export interface GateFrame {
  readonly x: number;
  readonly y: number;
  readonly orientation: GateOrientation;
  readonly open: number;
  /** Pill centre offset from the rail: 11 closed, 24 fully open. */
  readonly offset: number;
  readonly amber: boolean;
}

export type DiagramPose = "live" | "idle" | "absent" | "removed";

export interface DiagramFrame {
  /** The time actually drawn (snapped under reduced motion; 0 for still poses). */
  readonly t: number;
  /** Loop fade multiplier already applied to card, tag and ghost alpha. */
  readonly fade: number;
  readonly pose: DiagramPose;
  readonly cards: readonly CardFrame[];
  readonly gates: readonly GateFrame[];
  readonly status: StatusFrame;
}

export interface StateAtOptions {
  /** Draw smear ghosts (default true). Off for still views. */
  smear?: boolean;
  /**
   * prefers-reduced-motion: draw the outcome pose of the beat containing `t`
   * with no smear and no status swap.
   */
  reducedMotion?: boolean;
  /** Still poses: idle (scenario at rest), absent (no instance), removed (− mark). */
  pose?: DiagramPose;
}

/**
 * The outcome time of the beat (status note interval) containing `t`: just
 * before the next note, and never inside the closing fade of the loop.
 */
export function beatOutcomeTime(tl: Timeline, t: number): number {
  const starts =
    tl.beats && tl.beats.length > 0
      ? [0, ...tl.beats.map((b) => b.t).filter((b) => b > 0)]
      : tl.notes.map((n) => n[0]);
  let i = 0;
  while (i + 1 < starts.length && starts[i + 1] <= t) i++;
  const start = starts[i];
  const next = i + 1 < starts.length ? starts[i + 1] : tl.period;
  const fadeStart = tl.period - 0.6;
  const end = start <= fadeStart ? Math.min(next, fadeStart) : next;
  return Math.max(start, end - 0.02);
}

/** Index of the beat showing at `t`, or -1 before the first beat. */
export function beatIndex(beats: readonly Beat[], t: number): number {
  let i = -1;
  while (i + 1 < beats.length && beats[i + 1].t <= t) i++;
  return i;
}

/** The caption showing at `t` (null before the first beat). */
export function captionAt(beats: readonly Beat[], t: number): Beat | null {
  const i = beatIndex(beats, t);
  return i < 0 ? null : beats[i];
}

const POSE_STATUS: Record<Exclude<DiagramPose, "live">, string> = {
  idle: "idle",
  absent: "absent · no instance",
  removed: "removed in this change",
};

/** Resolve every visible element of a timeline at time `t`. Pure. */
export function stateAt(
  tl: Timeline,
  t: number,
  o: StateAtOptions = {}
): DiagramFrame {
  const pose = o.pose ?? "live";
  if (pose !== "live") {
    return {
      t: 0,
      fade: 1,
      pose,
      cards: [],
      gates: tl.gates.map((g) => gateFrame(g, [], 0)),
      status: fixedStatus(POSE_STATUS[pose]),
    };
  }
  const reduced = o.reducedMotion ?? false;
  const time = reduced ? beatOutcomeTime(tl, t) : t;
  const smear = !reduced && (o.smear ?? true);
  const fade = loopFade(tl.period, time);
  const live = tl.cards.filter((c) => isLive(c, time));
  const cards: CardFrame[] = [];
  tl.cards.forEach((c, index) => {
    if (!isLive(c, time)) return;
    const alpha = cardOpacity(c, time) * fade;
    if (alpha <= 0) return;
    const [x, y] = cardPosition(c, time);
    const role = cardRole(c, time);
    const ghosts: GhostFrame[] = [];
    if (smear && !c.hollow) {
      for (let i = SMEAR_GHOSTS; i >= 1; i--) {
        const tt = time - SMEAR_STEP * i;
        if (tt < c.born) continue;
        const [gx, gy] = cardPosition(c, tt);
        ghosts.push({
          x: gx,
          y: gy,
          alpha: alpha * 0.16 * (1 - i / (SMEAR_GHOSTS + 1)),
        });
      }
    }
    const tags: TagFrame[] = [];
    for (const tag of c.tags) {
      const k = windowed(time, tag.from, tag.to);
      if (k > 0)
        tags.push({ text: tag.text, x, y: y + tag.dy, alpha: k * fade, role });
    }
    cards.push({
      index,
      ...(c.id !== undefined ? { id: c.id } : {}),
      x,
      y,
      w: c.w,
      h: c.h,
      dot: c.dot,
      hollow: c.hollow,
      badge: c.badge,
      role,
      alpha,
      angle: cardLean(c, time),
      ghosts,
      tags,
    });
  });
  return {
    t: time,
    fade,
    pose,
    cards,
    gates: tl.gates.map((g) => gateFrame(g, live, time)),
    status: statusAt(tl.notes, time, !reduced),
  };
}

function gateFrame(
  g: GateSpec,
  cards: readonly CardSpec[],
  t: number
): GateFrame {
  const open = gateOpening(g, cards, t);
  return {
    x: g.x,
    y: g.y,
    orientation: g.orientation,
    open,
    offset: 11 + 13 * open,
    amber: (g.amber?.(t) ?? 0) > 0.3,
  };
}
