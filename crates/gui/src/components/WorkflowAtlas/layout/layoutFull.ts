/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — full (nested) graph layout.

   Port of `WFElk.layoutFull` (docs/design/wf-elk.js). Produces the GRAPH face:
   workflow containers ⊃ step nodes, orthogonal step + cross-workflow routing.

   Layout model:
     • Each workflow is an ELK container laid out RIGHT (steps flow left→right).
     • The root lays containers DOWN.
     • Forward intra-workflow links are SYNTHESISED here from step order — the
       adapter deliberately does not emit them.
     • Cross-workflow edges route container→container (ELK routes top-level
       nodes reliably across the hierarchy). Their endpoints are re-anchored
       onto the workflow box borders afterwards.
     • Loop-backs (same-workflow `transitions_to`) are kept OUT of ELK and drawn
       as arcs under the step row from resolved step positions — feeding them to
       ELK would distort the clean left→right step rows.
     • "Hub" workflows (wired to most others, e.g. a shared review workflow) have
       their cross edges drawn as a light overlay and kept OUT of ELK so a
       fully-connected node doesn't inflate the board into a sparse canvas.

   IMPORTANT — keep SEPARATE_CHILDREN. The original handoff doc notes that
   INCLUDE_CHILDREN flattens the per-container direction and produces a
   "staircase" step layout. (ELK's default for nested graphs is already
   SEPARATE_CHILDREN; we set it explicitly to lock the behaviour against the
   0.9.3 → 0.11 bump the prototype was written against.)
   ────────────────────────────────────────────────────────────────── */

import ELK, {
  type ElkExtendedEdge,
  type ElkNode,
} from "elkjs/lib/elk.bundled.js";
import { anchorEdge, edgePoints, rayBox } from "./geometry";
import type {
  AtlasModel,
  EdgeKind,
  FullLayout,
  LabelPos,
  PlacedEdge,
  PlacedStep,
  PlacedWorkflow,
  Point,
} from "./types";

const elk = new ELK();

export interface LayoutFullOptions {
  /** Step node width (px). */
  stepW?: number;
  /** Step node height (px). */
  stepH?: number;
  /** Container header height (top padding inside each workflow box, px). */
  headH?: number;
}

/** Approximate the rendered width of an edge label (for ELK label reservation). */
function approxLabelW(t: string): number {
  return Math.max(28, t.length * 6.0 + 10);
}

/** Per-edge metadata threaded through ELK and rebuilt onto the output edges. */
interface EdgeMeta {
  fromWorkflow: string;
  toWorkflow: string;
  kind: EdgeKind;
  label: string | null;
  /** Source step ref (cross edges only). */
  from?: string;
  /** Target step ref (cross edges only). */
  to?: string;
  /** Cross edge that bypasses ELK (hub overlay). */
  hub?: boolean;
}

/** A loop-back edge held aside for arc drawing (not given to ELK). */
interface PendingLoop {
  id: string;
  workflowId: string;
  from: string; // full step ref
  to: string; // full step ref
  label: string | null;
}

/** An ELK edge section carrier (the `sections` ELK populates after layout). */
function firstSection(edge: ElkExtendedEdge) {
  return edge.sections?.[0];
}

/** Read an ELK label back into an absolute, centred label position. */
function elkLabel(edge: ElkExtendedEdge, ox: number, oy: number): LabelPos | null {
  const l = edge.labels?.[0];
  if (!l) return null;
  return {
    text: l.text ?? "",
    x: (l.x ?? 0) + ox + (l.width ?? 0) / 2,
    y: (l.y ?? 0) + oy + (l.height ?? 0) / 2,
  };
}

/**
 * Compute the nested graph layout for an `AtlasModel`.
 *
 * Pure w.r.t. inputs (no React); async because ELK runs in a worker/promise.
 */
export async function layoutFull(
  model: AtlasModel,
  opts: LayoutFullOptions = {},
): Promise<FullLayout> {
  const STEP_W = opts.stepW ?? 148;
  const STEP_H = opts.stepH ?? 88;
  const HEAD = opts.headH ?? 96;

  // index the model
  const stepsByWorkflow = new Map<string, typeof model.steps>();
  for (const s of model.steps) {
    const list = stepsByWorkflow.get(s.workflowId);
    if (list) list.push(s);
    else stepsByWorkflow.set(s.workflowId, [s]);
  }
  // keep each workflow's steps in backend order (ascending)
  for (const list of stepsByWorkflow.values()) {
    list.sort((a, b) => a.order - b.order);
  }
  const stepById = new Map(model.steps.map((s) => [s.id, s]));

  const meta: Record<string, EdgeMeta> = {};

  // ── containers: one ELK node per workflow, step children laid out RIGHT ──
  const containers: ElkNode[] = model.workflows.map((w) => {
    const wSteps = stepsByWorkflow.get(w.id) ?? [];
    const node: ElkNode = {
      id: w.id,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        // explicit: keep child layout independent of the root's DOWN flow.
        "elk.hierarchyHandling": "SEPARATE_CHILDREN",
        "elk.padding": `[top=${HEAD},left=20,bottom=40,right=20]`,
        "elk.spacing.nodeNode": "22",
        "elk.layered.spacing.nodeNodeBetweenLayers": "34",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": "(216.0,0.0)",
      },
      children: wSteps.map((st) => ({
        id: st.id,
        width: STEP_W,
        height: STEP_H,
      })),
      edges: [],
    };
    // forward step links — implied by order, synthesised here (NOT in adapter)
    for (let i = 0; i < wSteps.length - 1; i++) {
      const id = `F_${w.id}_${i}`;
      node.edges!.push({
        id,
        sources: [wSteps[i].id],
        targets: [wSteps[i + 1].id],
      });
      meta[id] = {
        fromWorkflow: w.id,
        toWorkflow: w.id,
        kind: "forward",
        label: null,
      };
    }
    return node;
  });

  // ── hub detection (disabled) ──
  // Previously, workflows wired to many others ("hubs", e.g. Human Review) had
  // their cross edges pulled out of ELK and hidden at rest to reduce clutter —
  // but that left real handoffs invisible until you traced an endpoint. We now
  // route every cross edge through ELK and render it at rest. The empty set
  // keeps the hub plumbing below inert without special-casing.
  const hubSet = new Set<string>();

  // ── partition edges: intra forwards already on containers; here we handle
  //    cross edges (ELK or hub overlay) and loop-backs (held for arcs) ──
  const rootEdges: ElkExtendedEdge[] = [];
  const hubEdges: { id: string; fromWorkflow: string; toWorkflow: string }[] =
    [];
  const loops: PendingLoop[] = [];

  model.edges.forEach((e, idx) => {
    if (e.fromWorkflow === e.toWorkflow) {
      // intra-workflow link from the model is a loop-back (forwards are synthesised)
      loops.push({
        id: "L" + idx,
        workflowId: e.fromWorkflow,
        from: e.from,
        to: e.to,
        label: e.label,
      });
      return;
    }
    const id = "X" + idx;
    const hub = hubSet.has(e.fromWorkflow) || hubSet.has(e.toWorkflow);
    meta[id] = {
      fromWorkflow: e.fromWorkflow,
      toWorkflow: e.toWorkflow,
      kind: "cross",
      hub,
      label: e.label,
      from: e.from,
      to: e.to,
    };
    if (hub) {
      hubEdges.push({
        id,
        fromWorkflow: e.fromWorkflow,
        toWorkflow: e.toWorkflow,
      });
    } else {
      rootEdges.push({
        id,
        sources: [e.fromWorkflow],
        targets: [e.toWorkflow],
        labels: e.label
          ? [{ text: e.label, width: approxLabelW(e.label), height: 13 }]
          : [],
      });
    }
  });

  // ── root graph: containers laid out DOWN, cross edges polyline-routed ──
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.hierarchyHandling": "SEPARATE_CHILDREN",
      // Orthogonal so cross-workflow handoffs read as clean horizontal/vertical
      // runs with 90° turns (matching the map face), not diagonal polylines.
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "64",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
      "elk.layered.spacing.edgeNodeBetweenLayers": "34",
      "elk.spacing.edgeNode": "28",
      "elk.spacing.edgeEdge": "20",
      "elk.layered.mergeEdges": "true",
    },
    children: containers,
    edges: rootEdges,
  };

  const r = await elk.layout(graph);

  // ── lift step nodes into absolute coords; collect intra (forward) edges ──
  const placedWorkflows: PlacedWorkflow[] = (r.children ?? []).map((c) => {
    const w = model.workflows.find((x) => x.id === c.id)!;
    const cx = c.x ?? 0;
    const cy = c.y ?? 0;
    const steps: PlacedStep[] = (c.children ?? []).map((st, i) => {
      const def = stepById.get(st.id)!;
      return {
        id: st.id,
        stepId: def.stepId,
        workflowId: def.workflowId,
        name: def.name,
        kind: def.kind,
        role: def.role,
        idx: i + 1,
        x: cx + (st.x ?? 0),
        y: cy + (st.y ?? 0),
        w: st.width ?? STEP_W,
        h: st.height ?? STEP_H,
      };
    });
    const intra: PlacedEdge[] = ((c.edges ?? []) as ElkExtendedEdge[]).map(
      (e) => {
        const m = meta[e.id];
        return {
          id: e.id,
          kind: m.kind,
          from: m.from ?? "",
          to: m.to ?? "",
          fromWorkflow: m.fromWorkflow,
          toWorkflow: m.toWorkflow,
          label: m.label,
          points: edgePoints(firstSection(e), cx, cy),
          labelPos: elkLabel(e, cx, cy),
        };
      },
    );
    return {
      id: c.id,
      workflow: w,
      x: cx,
      y: cy,
      w: c.width ?? 0,
      h: c.height ?? 0,
      steps,
      intra,
    };
  });

  const wfById = new Map(placedWorkflows.map((w) => [w.id, w]));

  // ── loop-backs: arc under the step row, from resolved step positions ──
  const loopGeo: PlacedEdge[] = loops
    .map((lp): PlacedEdge | null => {
      const w = wfById.get(lp.workflowId);
      if (!w) return null;
      const from = w.steps.find((s) => s.id === lp.from);
      const to = w.steps.find((s) => s.id === lp.to);
      if (!from || !to) return null;
      const rowBottom = Math.max(...w.steps.map((s) => s.y + s.h));
      const lane = rowBottom + 18;
      const fx = from.x + from.w / 2;
      const tx = to.x + to.w / 2;
      const points: Point[] = [
        { x: fx, y: from.y + from.h },
        { x: fx, y: lane },
        { x: tx, y: lane },
        { x: tx, y: to.y + to.h },
      ];
      return {
        id: lp.id,
        kind: "loop" as EdgeKind,
        from: lp.from,
        to: lp.to,
        fromWorkflow: lp.workflowId,
        toWorkflow: lp.workflowId,
        label: lp.label,
        points,
        labelPos: { text: lp.label ?? "", x: (fx + tx) / 2, y: lane },
      };
    })
    .filter((x): x is PlacedEdge => x !== null);

  for (const w of placedWorkflows) {
    const mine = loopGeo.filter((l) => l.fromWorkflow === w.id);
    if (mine.length) w.intra = w.intra.concat(mine);
  }

  // ── cross edges from ELK: re-anchor onto box borders ──
  const cross: PlacedEdge[] = ((r.edges ?? []) as ElkExtendedEdge[]).map((e) => {
    const m = meta[e.id];
    const A = wfById.get(m.fromWorkflow);
    const B = wfById.get(m.toWorkflow);
    let points = edgePoints(firstSection(e), 0, 0);
    if (A && B) points = anchorEdge(points, A, B);
    return {
      id: e.id,
      kind: m.kind,
      from: m.from ?? "",
      to: m.to ?? "",
      fromWorkflow: m.fromWorkflow,
      toWorkflow: m.toWorkflow,
      label: m.label,
      points,
      labelPos: elkLabel(e, 0, 0),
      hub: m.hub,
    };
  });

  // ── hub overlay edges: straight border→border, computed after layout so
  //    they never participate in (or distort) the ELK packing ──
  const hubGeo: PlacedEdge[] = hubEdges
    .map((h): PlacedEdge | null => {
      const a = wfById.get(h.fromWorkflow);
      const b = wfById.get(h.toWorkflow);
      if (!a || !b) return null;
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const p1 = rayBox(ca.x, ca.y, cb.x, cb.y, a);
      const p2 = rayBox(cb.x, cb.y, ca.x, ca.y, b);
      const m = meta[h.id];
      return {
        id: h.id,
        kind: m.kind,
        from: m.from ?? "",
        to: m.to ?? "",
        fromWorkflow: m.fromWorkflow,
        toWorkflow: m.toWorkflow,
        label: m.label,
        points: [p1, p2],
        labelPos: m.label
          ? { text: m.label, x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
          : null,
        hub: true,
      };
    })
    .filter((x): x is PlacedEdge => x !== null);

  return {
    width: r.width ?? 0,
    height: r.height ?? 0,
    workflows: placedWorkflows,
    cross: cross.concat(hubGeo),
    hubIds: [...hubSet],
  };
}
