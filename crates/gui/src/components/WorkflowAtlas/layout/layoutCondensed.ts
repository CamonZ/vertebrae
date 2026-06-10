/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — condensed (map) layout.

   Port of `WFElk.layoutCondensed` (docs/design/wf-elk.js). Produces the MAP
   face: a workflow-only value-stream where step edges are aggregated up to
   workflow→workflow handoffs.

   This is fully DETERMINISTIC — no ELK. Columns are the phases (in the model's
   declared order), members stacked and vertically centred within their column.
   Edges route orthogonally so nothing ever crosses a card:
     • same column   → a left side-bus (one lane per same-column pair)
     • adjacent fwd   → the vertical bus in the gap right of the source column
     • distant fwd    → a top corridor (one horizontal lane per hop)
     • backward       → a bottom corridor (one horizontal lane per hop)

   ELK is intentionally avoided: its layered engine can't pin a phase to a
   single column when the phase has internal edges. The graph face still uses
   ELK (`layoutFull`); the map face is pure arithmetic.
   ────────────────────────────────────────────────────────────────── */

import { splitRef } from "./geometry";
import type {
  AtlasModel,
  CondensedColumn,
  CondensedEdge,
  CondensedLayout,
  CondensedNode,
  Point,
} from "./types";

export interface LayoutCondensedOptions {
  /** Card width (px). */
  boxW?: number;
  /** Card height (px). */
  boxH?: number;
}

const COLGAP = 188;
const ROWGAP = 44;
const PADX = 100;
const PADTOP = 150;
const PADBOT = 120;

/**
 * Compute the deterministic phase-column map layout for an `AtlasModel`.
 * Synchronous and pure — given the same model it always yields identical
 * geometry (no ELK, no randomness).
 */
export function layoutCondensed(
  model: AtlasModel,
  opts: LayoutCondensedOptions = {},
): CondensedLayout {
  const W = opts.boxW ?? 264;
  const H = opts.boxH ?? 140;

  // ── aggregate step edges → workflow→workflow conditions ──
  const agg = new Map<string, { from: string; to: string; labels: string[] }>();
  for (const e of model.edges) {
    const [fw] = splitRef(e.from);
    const [tw] = splitRef(e.to);
    if (fw === tw) continue;
    const k = fw + ">" + tw;
    let entry = agg.get(k);
    if (!entry) {
      entry = { from: fw, to: tw, labels: [] };
      agg.set(k, entry);
    }
    if (e.label && entry.labels.indexOf(e.label) === -1) {
      entry.labels.push(e.label);
    }
  }
  const conds = [...agg.values()];

  // ── columns = phases (in declared order) that actually have members ──
  const phaseOrder = model.phases
    .map((p) => p.name)
    .filter((name) => model.workflows.some((w) => w.phase === name));
  const nCols = phaseOrder.length;
  const colX = (c: number): number => PADX + c * (W + COLGAP);

  // members per column, in display order, stacked + vertically centred
  const members: (typeof model.workflows)[] = phaseOrder.map((p) =>
    model.workflows
      .filter((w) => w.phase === p)
      .sort((a, b) => a.displayOrder - b.displayOrder),
  );
  const blockH = (k: number): number => k * H + (k - 1) * ROWGAP;
  const contentH = members.length
    ? Math.max(...members.map((m) => blockH(m.length)))
    : 0;

  const nodes: CondensedNode[] = [];
  members.forEach((list, c) => {
    const startY = PADTOP + (contentH - blockH(list.length)) / 2;
    list.forEach((w, k) => {
      const x = colX(c);
      const y = startY + k * (H + ROWGAP);
      nodes.push({
        id: w.id,
        workflow: w,
        phase: w.phase,
        col: c,
        x,
        y,
        w: W,
        h: H,
        cx: x + W / 2,
        cy: y + H / 2,
        left: x,
        right: x + W,
      });
    });
  });
  const nById = new Map(nodes.map((n) => [n.id, n]));
  const width = nCols > 0 ? colX(nCols - 1) + W + PADX : PADX * 2;
  const height = PADTOP + contentH + PADBOT;

  // ── orthogonal routing infrastructure ──
  // vertical bus living in the gap right of column g
  const xGap = (g: number): number => colX(g) + W + COLGAP / 2;
  const topBase = 46;
  const botBase = PADTOP + contentH + 34;
  let topK = 0;
  let botK = 0;
  const leftK: Record<number, number> = {};
  // Per-gap lane counters so forward and return edges through the same gap never
  // share an x: forward edges ride the gap centre and to its right; adjacent
  // return edges ride to its left. Each direction staggers per edge.
  const gapFwdK: Record<number, number> = {};
  const gapBwdK: Record<number, number> = {};
  const LANE = 14;

  const edges: CondensedEdge[] = conds
    .map((cd, i): CondensedEdge | null => {
      const a = nById.get(cd.from);
      const b = nById.get(cd.to);
      if (!a || !b) return null; // edge endpoints not on the map (defensive)
      const ca = a.col;
      const cb = b.col;
      let pts: Point[];
      let lp: Point;
      if (ca === cb) {
        // same column → left side-bus (one lane per same-column pair)
        const k = (leftK[ca] = (leftK[ca] ?? 0) + 1);
        const xL = colX(ca) - 26 - (k - 1) * 13;
        pts = [
          { x: a.left, y: a.cy },
          { x: xL, y: a.cy },
          { x: xL, y: b.cy },
          { x: b.left, y: b.cy },
        ];
        lp = { x: xL, y: (a.cy + b.cy) / 2 };
      } else if (cb === ca + 1) {
        // adjacent forward → gap bus, centre + staggered right (clear of returns)
        const k = (gapFwdK[ca] = (gapFwdK[ca] ?? 0) + 1);
        const bx = xGap(ca) + (k - 1) * LANE;
        pts = [
          { x: a.right, y: a.cy },
          { x: bx, y: a.cy },
          { x: bx, y: b.cy },
          { x: b.left, y: b.cy },
        ];
        lp = { x: bx, y: (a.cy + b.cy) / 2 };
      } else if (cb === ca - 1) {
        // adjacent backward → same gap as the forward pair, but to the LEFT of
        // the forward lanes so a return never overlaps the forward path.
        const g = cb;
        const k = (gapBwdK[g] = (gapBwdK[g] ?? 0) + 1);
        const bx = xGap(g) - LANE - (k - 1) * LANE;
        pts = [
          { x: a.left, y: a.cy },
          { x: bx, y: a.cy },
          { x: bx, y: b.cy },
          { x: b.right, y: b.cy },
        ];
        lp = { x: bx, y: (a.cy + b.cy) / 2 };
      } else if (cb > ca) {
        // distant forward → top corridor (one horizontal lane per hop)
        const lane = topBase + topK++ * 16;
        const bxA = xGap(ca);
        const bxB = xGap(cb - 1);
        pts = [
          { x: a.right, y: a.cy },
          { x: bxA, y: a.cy },
          { x: bxA, y: lane },
          { x: bxB, y: lane },
          { x: bxB, y: b.cy },
          { x: b.left, y: b.cy },
        ];
        lp = { x: (bxA + bxB) / 2, y: lane };
      } else {
        // distant backward → bottom corridor
        const lane = botBase + botK++ * 16;
        const bxA = xGap(ca - 1);
        const bxB = xGap(cb);
        pts = [
          { x: a.left, y: a.cy },
          { x: bxA, y: a.cy },
          { x: bxA, y: lane },
          { x: bxB, y: lane },
          { x: bxB, y: b.cy },
          { x: b.right, y: b.cy },
        ];
        lp = { x: (bxA + bxB) / 2, y: lane };
      }
      return {
        id: "C" + i,
        from: cd.from,
        to: cd.to,
        labels: cd.labels,
        points: pts,
        labelPos: lp,
      };
    })
    .filter((x): x is CondensedEdge => x !== null);

  const columns: CondensedColumn[] = phaseOrder.map((p, i) => ({
    index: i,
    x: colX(i),
    cx: colX(i) + W / 2,
    phase: p,
    members: members[i].map((w) => w.id),
    top: PADTOP,
  }));

  return {
    width: width + 60,
    height: height + 30,
    nodes,
    edges,
    columns,
  };
}
