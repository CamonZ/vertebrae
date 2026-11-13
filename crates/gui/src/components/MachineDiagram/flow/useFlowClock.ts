import { useEffect, useState } from "react";
import type { Timeline } from "../timeline";
import { useReducedMotion } from "../useReducedMotion";
import {
  clockStep,
  initialClock,
  retarget,
  shownBeat,
  shownTime,
  type ClockAction,
  type ClockState,
} from "./clockModel";

export { beatOutcome } from "./clockModel";

export interface FlowClock {
  /** The time to draw: a beat outcome under reduced motion and after a chapter plays. */
  readonly t: number;
  readonly playing: boolean;
  /** Index of the beat showing at `t` (-1 before the first). */
  readonly beat: number;
  readonly beatCount: number;
  readonly reducedMotion: boolean;
  /** Timeline seconds per second of playback. */
  readonly speed: number;
  /** Loop at the end, or play once and stop on the last beat. */
  readonly loop: boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  stepForward(): void;
  stepBack(): void;
  /** One frame forward/back (a beat under reduced motion); pauses. */
  frameForward(): void;
  frameBack(): void;
  /** Jump to beat `i` and pause on its start. */
  seek(i: number): void;
  /** Play beat `i` (a chapter) from its start, pausing on its outcome; a jump under reduced motion. */
  playBeat(i: number): void;
  setSpeed(speed: number): void;
  setLoop(loop: boolean): void;
}

export interface FlowClockOptions {
  /** Override the prefers-reduced-motion media query. */
  reducedMotion?: boolean;
}

/**
 * Playback clock for a flow diagram, driven by requestAnimationFrame. The
 * rules live in the pure model (clockModel.ts): starts paused on the first
 * beat's start; play runs once to the last beat's outcome, or loops at the
 * timeline's period, at the chosen speed;
 * beat steps and jumps pause on a beat's start, wrapping at the ends; a chapter
 * plays just its beat and pauses on the outcome; frame steps pause one frame away. Under reduced motion only beat
 * outcomes are shown. When `tl` changes (another arrangement) the story beat is kept.
 */
export function useFlowClock(
  tl: Timeline,
  o: FlowClockOptions = {}
): FlowClock {
  const prefersReduced = useReducedMotion();
  const reduced = o.reducedMotion ?? prefersReduced;
  const [stored, setStored] = useState<ClockState>(() => initialClock(tl));
  const [seen, setSeen] = useState(tl);
  let s = stored;
  if (seen !== tl) {
    s = retarget(seen, tl, stored, reduced);
    setSeen(tl);
    setStored(s);
  }

  const dispatch = (a: ClockAction) =>
    setStored((cur) => clockStep(tl, cur, a, reduced));

  const playing = s.playing;
  useEffect(() => {
    if (!playing || !(tl.period > 0)) return;
    let last: number | null = null;
    let frame = 0;
    const tick = (now: number) => {
      if (last !== null) {
        const dt = (now - last) / 1000;
        setStored((cur) => clockStep(tl, cur, { type: "tick", dt }, reduced));
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, tl, reduced]);

  return {
    t: shownTime(tl, s, reduced),
    playing,
    beat: shownBeat(tl, s, reduced),
    beatCount: tl.beats?.length ?? 0,
    reducedMotion: reduced,
    speed: s.speed,
    loop: s.loop,
    play: () => dispatch({ type: "play" }),
    pause: () => dispatch({ type: "pause" }),
    toggle: () => dispatch({ type: "toggle" }),
    stepForward: () => dispatch({ type: "step", dir: 1 }),
    stepBack: () => dispatch({ type: "step", dir: -1 }),
    frameForward: () => dispatch({ type: "frame", dir: 1 }),
    frameBack: () => dispatch({ type: "frame", dir: -1 }),
    seek: (i: number) => dispatch({ type: "seek", beat: i }),
    playBeat: (i: number) => dispatch({ type: "playBeat", beat: i }),
    setSpeed: (speed: number) => dispatch({ type: "speed", speed }),
    setLoop: (loop: boolean) => dispatch({ type: "loop", loop }),
  };
}
