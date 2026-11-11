import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { beatIndex, beatOutcomeTime, type Timeline } from "../timeline";
import { useReducedMotion } from "../useReducedMotion";

/** Longest frame step, so a backgrounded tab does not jump whole beats. */
const MAX_FRAME_DT = 0.1;

export interface FlowClock {
  /** The time to draw: an outcome time whenever paused or under reduced motion. */
  readonly t: number;
  readonly playing: boolean;
  /** Index of the beat showing at `t` (-1 before the first). */
  readonly beat: number;
  readonly beatCount: number;
  readonly reducedMotion: boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  stepForward(): void;
  stepBack(): void;
}

export interface FlowClockOptions {
  /** Override the prefers-reduced-motion media query. */
  reducedMotion?: boolean;
}

/** Outcome time of beat `i` on `tl`. */
export function beatOutcome(tl: Timeline, i: number): number {
  const beats = tl.beats ?? [];
  if (beats.length === 0) return 0;
  const b = Math.max(0, Math.min(beats.length - 1, i));
  return beatOutcomeTime(tl, beats[b].t);
}

/** Where a beat-by-beat (reduced motion) run resumes: the start of the beat showing at `t`. */
function beatStart(tl: Timeline, t: number): number {
  const beats = tl.beats ?? [];
  const i = beatIndex(beats, t);
  return i < 0 ? 0 : beats[i].t;
}

/**
 * Playback clock for a flow diagram, driven by requestAnimationFrame. Starts
 * paused on the first beat's outcome; play loops at the timeline's period.
 * Steps pause and land exactly on a beat's outcome time, wrapping at the ends.
 * Under reduced motion, play advances beat by beat and only ever shows beat
 * outcomes. When `tl` changes (Before/After), the clock keeps its beat index.
 */
export function useFlowClock(
  tl: Timeline,
  o: FlowClockOptions = {}
): FlowClock {
  const prefersReduced = useReducedMotion();
  const reduced = o.reducedMotion ?? prefersReduced;
  const beats = tl.beats ?? [];
  const n = beats.length;
  const [t, setT] = useState(() => beatOutcome(tl, 0));
  const [playing, setPlaying] = useState(false);
  const [seen, setSeen] = useState(tl);
  let shown = t;
  if (seen !== tl) {
    const i = beatIndex(seen.beats ?? [], t);
    shown = i < 0 ? 0 : beatOutcome(tl, i);
    setSeen(tl);
    setT(shown);
  }

  const current = useRef(shown);
  useLayoutEffect(() => {
    current.current = shown;
  });

  useEffect(() => {
    if (!playing || !(tl.period > 0)) return;
    let raw = reduced ? beatStart(tl, current.current) : current.current;
    let last: number | null = null;
    let frame = 0;
    const tick = (now: number) => {
      if (last !== null) {
        const dt = Math.min(MAX_FRAME_DT, Math.max(0, (now - last) / 1000));
        raw = (raw + dt) % tl.period;
        setT(reduced && n > 0 ? beatOutcomeTime(tl, raw) : raw);
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, tl, reduced, n]);

  function step(dir: 1 | -1) {
    if (n === 0) return;
    setPlaying(false);
    const i = beatIndex(beats, current.current);
    const next =
      dir === 1 ? (i + 1 >= n ? 0 : i + 1) : i - 1 < 0 ? n - 1 : i - 1;
    const at = beatOutcome(tl, next);
    current.current = at;
    setT(at);
  }

  return {
    t: shown,
    playing,
    beat: beatIndex(beats, shown),
    beatCount: n,
    reducedMotion: reduced,
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    toggle: () => setPlaying((p) => !p),
    stepForward: () => step(1),
    stepBack: () => step(-1),
  };
}
