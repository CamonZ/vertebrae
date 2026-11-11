/**
 * What the player says about a compiled flow at one instant: where a card
 * is, what state a part is in, which source refs a part carries, and the
 * sentence announced for a beat. Pure functions of the compiled diagram and
 * `t`, so the inspector, the narration and screen-reader text agree with
 * what is drawn.
 */
import type { StateRole } from "../palette";
import { stateAt } from "../timeline";
import type { CompiledFlow, DiagramPart, DiagramTimeline } from "./compile";

export type CardWhereabouts =
  /** Not drawn yet: its first step is later. */
  | { readonly kind: "pending" }
  | { readonly kind: "rail"; readonly rail: string; readonly to: string }
  | { readonly kind: "part"; readonly part: string }
  /** Between two appearances: it has left `from` (a part id, or "rail"). */
  | { readonly kind: "gap"; readonly from: string }
  /** Consumed, or its last appearance has ended. */
  | { readonly kind: "done" };

interface Span {
  readonly born: number;
  readonly dies: number;
  readonly at: CardWhereabouts;
}

function spans(d: DiagramTimeline, id: string): Span[] {
  const out: Span[] = [];
  const arrivals = d.markers.filter(
    (m) => m.kind === "arrival" && m.card === id
  );
  for (const c of d.travel.cards) {
    if (c.id !== id) continue;
    const arrival = arrivals
      .filter((m) => m.t >= c.born)
      .sort((a, b) => a.t - b.t)[0];
    out.push({
      born: c.born,
      dies: c.dies,
      at: {
        kind: "rail",
        rail: arrival?.rail ?? "",
        to: arrival?.part ?? "",
      },
    });
  }
  for (const p of d.parts)
    for (const c of p.timeline.cards)
      if (c.id === id)
        out.push({
          born: c.born,
          dies: c.dies,
          at: { kind: "part", part: p.id },
        });
  return out.sort((a, b) => a.born - b.born);
}

/**
 * Where card `id` is at `t`: on a rail, in a part, not yet sent, or done.
 * During a hand-off the newer appearance wins; between two appearances it
 * is in a gap after the last one.
 */
export function cardWhereabouts(
  d: DiagramTimeline,
  id: string,
  t: number
): CardWhereabouts {
  const all = spans(d, id);
  // A card is invisible at the instant it is born (it fades in from there).
  const started = all.filter((s) => s.born < t);
  if (started.length === 0) return { kind: "pending" };
  const live = started.filter((s) => t <= s.dies);
  if (live.length > 0) return live[live.length - 1].at;
  if (started.length < all.length) {
    const last = started[started.length - 1].at;
    return { kind: "gap", from: last.kind === "part" ? last.part : "rail" };
  }
  return { kind: "done" };
}

export interface PartStatus {
  readonly text: string;
  readonly role: StateRole;
}

/** The settled status line of `part` at `t`, as MachinePart draws it. */
export function partStatusAt(
  part: DiagramPart,
  t: number,
  reducedMotion = false
): PartStatus {
  const pose = part.change === "removed" ? "removed" : "live";
  const { current } = stateAt(part.timeline, t, {
    pose,
    reducedMotion,
    smear: false,
  }).status;
  return { text: current.text, role: current.role };
}

/** Ids of the cards drawn inside `part` at `t`. */
export function cardsInPart(part: DiagramPart, t: number): string[] {
  const ids = new Set<string>();
  for (const c of part.timeline.cards)
    if (c.id !== undefined && c.born <= t && t <= c.dies) ids.add(c.id);
  return [...ids];
}

export interface SourceRef {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly symbol?: string;
  readonly claim?: string;
  readonly status: "verified" | "inferred";
  /** `path:line` or `path:line-endLine`. */
  readonly location: string;
}

/** The part's `ref` attachments (file:line evidence), in spec order. */
export function partRefs(part: DiagramPart): SourceRef[] {
  return part.attachments
    .filter((a) => a.kind === "ref" && typeof a.path === "string")
    .map((a) => {
      const line = typeof a.line === "number" ? a.line : undefined;
      const endLine = typeof a.endLine === "number" ? a.endLine : undefined;
      const range =
        line === undefined
          ? ""
          : endLine !== undefined && endLine !== line
            ? `:${line}-${endLine}`
            : `:${line}`;
      return {
        path: a.path as string,
        ...(line !== undefined ? { line } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        ...(typeof a.symbol === "string" ? { symbol: a.symbol } : {}),
        ...(typeof a.claim === "string" ? { claim: a.claim } : {}),
        status: a.status === "verified" ? "verified" : "inferred",
        location: `${a.path as string}${range}`,
      };
    });
}

const partName = (d: DiagramTimeline, id: string) =>
  d.parts.find((p) => p.id === id)?.identity.name ?? id;

/** The card's tag text (its label), falling back to the id. */
export function cardLabel(flow: CompiledFlow, id: string): string {
  return flow.cards[id]?.label ?? id;
}

/** One sentence saying where a followed card is and what is happening to it. */
export function narrateCard(
  flow: CompiledFlow,
  d: DiagramTimeline,
  id: string,
  t: number,
  reducedMotion = false
): string {
  const label = cardLabel(flow, id);
  const w = cardWhereabouts(d, id, t);
  switch (w.kind) {
    case "pending":
      return `${label} has not been sent yet`;
    case "done":
      return `${label} is done`;
    case "gap":
      return w.from === "rail"
        ? `${label} has left the rail`
        : `${label} has left ${partName(d, w.from)}`;
    case "rail": {
      const rail = d.rails.find((r) => r.id === w.rail);
      const on = rail ? ` on ${rail.label ?? rail.id}` : "";
      const to = w.to ? ` to ${partName(d, w.to)}` : "";
      return `${label} is travelling${on}${to}`;
    }
    case "part": {
      const part = d.parts.find((p) => p.id === w.part)!;
      const status = partStatusAt(part, t, reducedMotion).text;
      return `${label} is in ${part.identity.name}: ${status}`;
    }
  }
}

/** End `text` with a full stop unless it already ends a sentence. */
const sentence = (text: string) =>
  /[.!?…]$/.test(text.trimEnd()) ? text.trimEnd() : `${text}.`;

/** What the live region announces for beat `i` (plus the followed card). */
export function beatAnnouncement(
  d: DiagramTimeline,
  i: number,
  following?: string
): string {
  const n = d.beats.length;
  if (n === 0) return "";
  const b = Math.max(0, i);
  const caption = d.beats[b]?.caption ?? "";
  const head = sentence(
    `Beat ${b + 1} of ${n}${caption ? `: ${caption}` : ""}`
  );
  return following ? `${head} ${sentence(following)}` : head;
}
