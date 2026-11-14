import type { PortSide } from "../route";
/** Pure two-channel interval planner. Endpoints are ordered geometrically, never by rail id. */
export interface SpanPort {
  readonly part: string;
  readonly port: string;
  readonly side: PortSide;
  /** Position among every port on the side, including unused ports. */
  readonly order: number;
  readonly count: number;
}
export interface ReturnSpan {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly preferred?: "top" | "bottom";
  readonly from?: SpanPort;
  readonly to?: SpanPort;
}
export interface ReturnLane {
  readonly channel: "top" | "bottom";
  readonly lane: number;
  readonly depth: number;
  readonly fromDrop: number;
  readonly toDrop: number;
}

/** Self-loops turn toward the nearby end of their side's port order. */
export function preferredChannel(span: ReturnSpan): "top" | "bottom" {
  if (span.preferred) return span.preferred;
  const from = span.from;
  if (!from) return "bottom";
  if (from.side === "N") return "top";
  if (from.side === "S") return "bottom";
  return from.part === span.to?.part && from.order < (from.count - 1) / 2
    ? "top"
    : "bottom";
}

/** Interleaved ends cannot share a channel without a crossing; nested ends can. */
export function interleaved(a: ReturnSpan, b: ReturnSpan): boolean {
  return (
    (a.x0 < b.x0 && b.x0 < a.x1 && a.x1 < b.x1) ||
    (b.x0 < a.x0 && a.x0 < b.x1 && b.x1 < a.x1)
  );
}

export function planReturnLanes(
  spans: readonly ReturnSpan[],
  gap = 40,
  pitch = 20
): ReturnLane[] {
  // Exact channel assignment for the small interactive case. For large diagrams,
  // greedily extend the best six-span prefix instead of exponential work.
  const n = Math.min(spans.length, 6);
  let best: boolean[] = [];
  let bestCrossings = Infinity;
  let bestPreference = Infinity;
  for (let mask = 0; mask < 2 ** n; mask++) {
    const channels = spans.map((s, i) =>
      i < n ? (mask & (1 << i)) !== 0 : preferredChannel(s) === "top"
    );
    for (let i = n; i < spans.length; i++) {
      const cost = (top: boolean) =>
        spans
          .slice(0, i)
          .filter((s, j) => channels[j] === top && interleaved(s, spans[i]))
          .length;
      if (cost(true) !== cost(false)) channels[i] = cost(true) < cost(false);
    }
    let crossings = 0;
    let preference = 0;
    for (const [i, s] of spans.entries()) {
      if (channels[i] !== (preferredChannel(s) === "top")) preference++;
      for (let j = 0; j < i; j++)
        if (channels[i] === channels[j] && interleaved(s, spans[j]))
          crossings++;
    }
    if (
      crossings < bestCrossings ||
      (crossings === bestCrossings && preference < bestPreference)
    ) {
      bestCrossings = crossings;
      bestPreference = preference;
      best = channels;
    }
  }
  const plan: ReturnLane[] = [];
  // Inner intervals first. Disjoint spans reuse a lane beside their own parts.
  const order = spans
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        a.s.x1 - a.s.x0 - (b.s.x1 - b.s.x0) ||
        a.s.y0 - b.s.y0 ||
        (a.s.from &&
        b.s.from &&
        a.s.from.part === b.s.from.part &&
        a.s.from.side === b.s.from.side &&
        best[a.i] === best[b.i]
          ? (a.s.from.order - b.s.from.order) * (best[a.i] ? 1 : -1)
          : 0) ||
        a.i - b.i
    );
  for (const { s, i } of order) {
    const channel = best[i] ? "top" : "bottom";
    let lane = best[i] ? s.y0 - gap : s.y1 + gap;
    let depth = 0;
    for (const { s: inner, i: j } of order) {
      const p = plan[j];
      if (
        !p ||
        p.channel !== channel ||
        inner.x1 < s.x0 ||
        s.x1 < inner.x0 ||
        inner.y1 + gap < s.y0 ||
        s.y1 + gap < inner.y0
      )
        continue;
      depth = Math.max(depth, p.depth + 1);
      lane = best[i]
        ? Math.min(lane, p.lane - pitch)
        : Math.max(lane, p.lane + pitch);
    }
    const drop = (port: SpanPort | undefined) => {
      if (!port) return depth;
      const sideRank =
        channel === "top" ? port.order : port.count - 1 - port.order;
      return sideRank * (spans.length + 1) + depth;
    };
    plan[i] = {
      channel,
      lane,
      depth,
      fromDrop: drop(s.from),
      toDrop: drop(s.to),
    };
  }
  return plan;
}
