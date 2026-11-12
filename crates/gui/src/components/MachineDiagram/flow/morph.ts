/**
 * The Before/After morph: toggling arrangements blends the one being left
 * into the one arriving on their shared layout. Parts, rails and band rows
 * that read the same in both are drawn once and never move; only marked
 * ones change: an added part fades in while its + outline draws on, a
 * removed part ghosts out under its veil, a changed part's brackets flare
 * and settle. Under reduced motion there is no morph: the toggle snaps.
 *
 * The model is pure: which layers to draw, at what opacity, for a progress.
 */
import { smoothstep } from "../motion";
import type { DiagramBandRow } from "./band";
import type {
  DiagramPart,
  DiagramRail,
  DiagramTimeline,
  Presence,
} from "./compile";

/** Seconds a Before/After morph takes. */
export const MORPH_SECONDS = 0.6;

/** The arrangement being left, frozen at the time the toggle happened. */
export interface DiagramMorph {
  readonly from: DiagramTimeline;
  /** Shown time in `from` when the toggle happened. */
  readonly t: number;
  /** Linear progress, 0 at the toggle → 1 settled. */
  readonly progress: number;
}

/** Eased progress the layers use. */
export const morphEase = (progress: number) => smoothstep(0, 1, progress);

interface Marked {
  readonly presence: Presence;
}

export interface MorphLayers {
  /** Opacity of the arriving element; none when it is absent there. */
  readonly to?: number;
  /** Opacity of the leaving element drawn over it; none when drawn once. */
  readonly from?: number;
  /** The element changes between arrangements (its mark animates). */
  readonly morphing: boolean;
}

/**
 * Layers for one element. Unchanged: drawn once, fully opaque. Changed: the
 * arriving element underneath (fading in only if it was absent), the
 * leaving one on top fading out, so shared pixels never dip.
 */
export function morphLayers<T extends Marked>(
  to: T | undefined,
  from: T | undefined,
  e: number | undefined,
  differs: (a: T, b: T) => boolean
): MorphLayers {
  const live = (x: T | undefined) => x !== undefined && x.presence !== "absent";
  if (e === undefined || e >= 1 || (to && from && !differs(to, from)))
    return live(to) ? { to: 1, morphing: false } : { morphing: false };
  return {
    ...(live(to) ? { to: live(from) ? 1 : e } : {}),
    ...(live(from) ? { from: 1 - e } : {}),
    morphing: true,
  };
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Whether a part reads differently in the two arrangements. */
export function partDiffers(a: DiagramPart, b: DiagramPart): boolean {
  return (
    a.presence !== b.presence ||
    a.change !== b.change ||
    a.changeNote !== b.changeNote ||
    !same(a.portChanges, b.portChanges) ||
    !same(a.stageMarks, b.stageMarks) ||
    !same(a.props, b.props)
  );
}

/** Whether a rail reads differently in the two arrangements. */
export function railDiffers(a: DiagramRail, b: DiagramRail): boolean {
  return a.presence !== b.presence || a.change !== b.change;
}

/** Whether a band row reads differently (text or chips); lighting follows `t`. */
export function bandRowDiffers(a: DiagramBandRow, b: DiagramBandRow): boolean {
  return a.name !== b.name || a.note !== b.note || !same(a.chips, b.chips);
}
