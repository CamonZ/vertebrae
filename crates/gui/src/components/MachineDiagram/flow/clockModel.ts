/**
 * The flow player's clock as a pure state machine. `useFlowClock` only feeds
 * it actions (controls, keyboard, animation frames); every rule about where
 * the clock lands lives here, so it can be checked without React or timers.
 *
 * Playback either loops at the period or plays once: it stops on the last
 * beat's outcome, and playing again from there starts over. Playing a single
 * beat (a chapter) animates it from its start and stops on its outcome.
 *
 * `raw` is the running position on the timeline. What is drawn is
 * `shownTime`: `raw` itself, or under reduced motion the outcome of the beat
 * `raw` is in, so reduced motion only ever shows settled beat outcomes.
 */
import { beatIndex, beatOutcomeTime, type Timeline } from "../timeline";

/** Longest frame step, so a backgrounded tab does not jump whole beats. */
export const MAX_FRAME_DT = 0.1;
/** One frame step, in timeline seconds. */
export const FRAME = 1 / 30;
/** Playback speeds offered by the player, slowest first. */
export const SPEEDS = [0.25, 0.5, 1, 2] as const;

export interface ClockState {
  /** Running position, 0 ≤ raw < period. */
  readonly raw: number;
  readonly playing: boolean;
  /** Timeline seconds per wall-clock second. */
  readonly speed: number;
  /** Loop at the period; otherwise play once and stop at `playEnd`. */
  readonly loop: boolean;
  /** Playing a single beat: where to stop (its outcome). Only set while playing. */
  readonly until: number | null;
}

export type ClockAction =
  | { readonly type: "play" }
  | { readonly type: "pause" }
  | { readonly type: "toggle" }
  /** Previous/next beat, wrapping at the ends; pauses on its outcome. */
  | { readonly type: "step"; readonly dir: 1 | -1 }
  /** One frame back/forward; pauses. A beat step under reduced motion. */
  | { readonly type: "frame"; readonly dir: 1 | -1 }
  /** Jump to a beat; pauses on its outcome. */
  | { readonly type: "seek"; readonly beat: number }
  /**
   * Play one beat (a chapter): from its start to its outcome, then pause.
   * Under reduced motion this is a jump to its outcome.
   */
  | { readonly type: "playBeat"; readonly beat: number }
  /** Wall-clock seconds since the last animation frame. */
  | { readonly type: "tick"; readonly dt: number }
  | { readonly type: "speed"; readonly speed: number }
  | { readonly type: "loop"; readonly loop: boolean };

/** Outcome time of beat `i` on `tl` (clamped to the beats; 0 without beats). */
export function beatOutcome(tl: Timeline, i: number): number {
  const beats = tl.beats ?? [];
  if (beats.length === 0) return 0;
  const b = Math.max(0, Math.min(beats.length - 1, i));
  return beatOutcomeTime(tl, beats[b].t);
}

/** Start time of beat `i` (clamped; 0 without beats). */
function beatStart(tl: Timeline, i: number): number {
  const beats = tl.beats ?? [];
  if (beats.length === 0) return 0;
  return beats[Math.max(0, Math.min(beats.length - 1, i))].t;
}

/** `t` folded into [0, period); left exact when already inside, as `%` rounds. */
const wrap = (t: number, period: number) =>
  t >= 0 && t < period ? t : ((t % period) + period) % period;

/** Where a single play-through stops: the last beat's (or note's) outcome. */
export function playEnd(tl: Timeline): number {
  return beatOutcomeTime(tl, tl.period);
}

/** The clock at rest on the first beat's outcome, set to play once. */
export function initialClock(tl: Timeline): ClockState {
  return {
    raw: beatOutcome(tl, 0),
    playing: false,
    speed: 1,
    loop: false,
    until: null,
  };
}

/** The time to draw for `s` on `tl`. */
export function shownTime(
  tl: Timeline,
  s: ClockState,
  reduced: boolean
): number {
  if (!reduced) return s.raw;
  const beats = tl.beats ?? [];
  if (beats.length === 0) return beatOutcomeTime(tl, s.raw);
  return beatOutcome(tl, Math.max(0, beatIndex(beats, s.raw)));
}

/** Index of the beat drawn for `s` (-1 before the first beat). */
export function shownBeat(
  tl: Timeline,
  s: ClockState,
  reduced: boolean
): number {
  return beatIndex(tl.beats ?? [], shownTime(tl, s, reduced));
}

function stepBeat(
  tl: Timeline,
  s: ClockState,
  dir: 1 | -1,
  reduced: boolean
): ClockState {
  const n = tl.beats?.length ?? 0;
  if (n === 0) return s;
  const i = shownBeat(tl, s, reduced);
  const next = dir === 1 ? (i + 1 >= n ? 0 : i + 1) : i - 1 < 0 ? n - 1 : i - 1;
  return rest(s, beatOutcome(tl, next));
}

/** Paused at `raw`. */
function rest(s: ClockState, raw: number): ClockState {
  return { ...s, playing: false, raw, until: null };
}

/** Apply one action. Pure: the same inputs always give the same clock. */
export function clockStep(
  tl: Timeline,
  s: ClockState,
  a: ClockAction,
  reduced: boolean
): ClockState {
  const n = tl.beats?.length ?? 0;
  switch (a.type) {
    case "play": {
      if (s.playing) return s;
      // Playing once from the end (or past it) starts over.
      const from =
        !s.loop && shownTime(tl, s, reduced) >= playEnd(tl)
          ? { ...s, raw: 0 }
          : s;
      // Under reduced motion a beat is held for its whole length, so resume
      // from the start of the beat showing rather than just before the next.
      const raw =
        reduced && n > 0
          ? beatStart(tl, Math.max(0, shownBeat(tl, from, reduced)))
          : from.raw;
      return { ...s, playing: true, raw };
    }
    case "pause":
      return s.playing ? rest(s, shownTime(tl, s, reduced)) : s;
    case "toggle":
      return clockStep(tl, s, { type: s.playing ? "pause" : "play" }, reduced);
    case "step":
      return stepBeat(tl, s, a.dir, reduced);
    case "frame":
      if (reduced) return stepBeat(tl, s, a.dir, reduced);
      if (!(tl.period > 0)) return s;
      return rest(s, wrap(s.raw + a.dir * FRAME, tl.period));
    case "seek":
      if (n === 0 || !Number.isFinite(a.beat)) return s;
      return rest(s, beatOutcome(tl, Math.trunc(a.beat)));
    case "playBeat": {
      if (n === 0 || !Number.isFinite(a.beat)) return s;
      const i = Math.trunc(a.beat);
      const start = beatStart(tl, i);
      const until = beatOutcome(tl, i);
      if (reduced || !(until > start)) return rest(s, until);
      return { ...s, playing: true, raw: start, until };
    }
    case "tick": {
      if (!s.playing || !(tl.period > 0)) return s;
      const dt = Math.min(MAX_FRAME_DT, Math.max(0, a.dt || 0));
      const next = s.raw + dt * s.speed;
      if (s.until !== null && next >= s.until) return rest(s, s.until);
      const end = playEnd(tl);
      if (!s.loop && s.raw < end && next >= end) return rest(s, end);
      return { ...s, raw: wrap(next, tl.period) };
    }
    case "speed":
      return Number.isFinite(a.speed) && a.speed > 0
        ? { ...s, speed: a.speed }
        : s;
    case "loop":
      return { ...s, loop: a.loop };
  }
}

/**
 * The beat of `to` showing the story beat that beat `i` of `from` starts at:
 * the last of `to`'s beats starting at or before it (its first beat when none
 * does). Arrangements caption different story beats, and an uncaptioned one
 * continues the previous caption. Timelines without story indices keep `i`.
 */
export function sameBeat(from: Timeline, to: Timeline, i: number): number {
  const story = from.beats?.[i]?.story;
  const beats = to.beats ?? [];
  if (story === undefined || beats.some((b) => b.story === undefined)) return i;
  let j = 0;
  beats.forEach((b, k) => {
    if (b.story! <= story) j = k;
  });
  return j;
}

/**
 * The clock moved onto another arrangement's timeline: keep the story beat
 * (see `sameBeat`), landing on its outcome (its start while playing under
 * reduced motion, so the beat is held in full). A beat being played on its
 * own stops on the new arrangement's outcome of that beat.
 */
export function retarget(
  from: Timeline,
  to: Timeline,
  s: ClockState,
  reduced: boolean
): ClockState {
  const i = shownBeat(from, s, reduced);
  if (i < 0 && s.until === null) return { ...s, raw: 0 };
  const j = sameBeat(from, to, Math.max(0, i));
  if (s.until !== null) return rest(s, beatOutcome(to, j));
  return {
    ...s,
    raw: reduced && s.playing ? beatStart(to, j) : beatOutcome(to, j),
  };
}

/** The next slower or faster offered speed (stays at the ends). */
export function nextSpeed(speed: number, dir: 1 | -1): number {
  const i = SPEEDS.findIndex((v) => v >= speed);
  const at = i < 0 ? SPEEDS.length - 1 : i;
  const exact = SPEEDS[at] === speed;
  const to = dir === 1 ? (exact ? at + 1 : at) : at - 1;
  return SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, to))];
}
