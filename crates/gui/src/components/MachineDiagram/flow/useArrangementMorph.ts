import { useEffect, useState } from "react";
import type { DiagramTimeline } from "./compile";
import { MORPH_SECONDS, type DiagramMorph } from "./morph";

export interface ArrangementMorph {
  /** The morph in progress, if any (never under reduced motion). */
  readonly morph?: DiagramMorph;
  /** Begin a morph away from `from`, shown at `t`, unless motion is reduced. */
  start(from: DiagramTimeline, t: number): void;
}

interface Run {
  readonly from: DiagramTimeline;
  readonly t: number;
}

/**
 * Drives the Before/After morph with requestAnimationFrame for
 * MORPH_SECONDS. A toggle mid-morph starts a new morph from the arrangement
 * then showing. Under reduced motion nothing starts and a running morph is
 * dropped, so the toggle snaps to the settled arrangement.
 */
export function useArrangementMorph(reducedMotion: boolean): ArrangementMorph {
  const [run, setRun] = useState<Run | null>(null);
  const [progress, setProgress] = useState(0);
  const active = run !== null && !reducedMotion;

  useEffect(() => {
    if (!run || reducedMotion) return;
    let started: number | null = null;
    let frame = 0;
    const tick = (now: number) => {
      started ??= now;
      const p = Math.min(1, (now - started) / 1000 / MORPH_SECONDS);
      if (p >= 1) {
        setRun(null);
        return;
      }
      setProgress(p);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run, reducedMotion]);

  return {
    ...(active ? { morph: { from: run.from, t: run.t, progress } } : {}),
    start: (from, t) => {
      if (reducedMotion) return;
      setProgress(0);
      setRun({ from, t });
    },
  };
}
