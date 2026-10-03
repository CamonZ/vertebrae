/* ──────────────────────────────────────────────────────────────────
   Workflow Atlas — full (nested) graph layout.

   Port of `WFElk.layoutFull` (docs/design/wf-elk.js). Produces the GRAPH face:
   workflow containers ⊃ step nodes, orthogonal step + cross-workflow routing.

   Layout model:
     • Each workflow is an ELK container laid out DOWN (steps flow top→bottom).
     • The root lays linked workflow containers RIGHT.
     • Forward intra-workflow links are SYNTHESISED here from step order — the
       adapter deliberately does not emit them.
     • Cross-workflow edges route container→container (ELK routes top-level
       nodes reliably across the hierarchy). Their endpoints are re-anchored
       onto the workflow box borders afterwards.
     • Loop-backs (same-workflow `transitions_to`) are kept OUT of ELK and drawn
       up the left side of the step lane — feeding them to ELK would distort
       the clean top→bottom step flow.
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
  AtlasStep,
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
  /** Override width for every kind when a uniform layout is desired (px). */
  stepW?: number;
  /** Override height for every kind when a uniform layout is desired (px). */
  stepH?: number;
  /** Container header height (top padding inside each workflow box, px). */
  headH?: number;
}

interface StepSize {
  width: number;
  height: number;
}

function stepSize(kind: AtlasStep["kind"], fallback: StepSize): StepSize {
  switch (kind) {
    case "llm":
      return { width: 240, height: 114 };
    case "structured":
      return { width: 240, height: 122 };
    case "execute":
      return { width: 220, height: 88 };
    case "route":
      return { width: 138, height: 72 };
    case "wait":
      return { width: 220, height: 100 };
    case "human":
      return { width: 240, height: 88 };
    case "stop":
      return { width: 184, height: 34 };
    case "finish":
      return { width: 112, height: 42 };
    default:
      return fallback;
  }
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
function elkLabel(
  edge: ElkExtendedEdge,
  ox: number,
  oy: number
): LabelPos | null {
  const l = edge.labels?.[0];
  if (!l) return null;
  return {
    text: l.text ?? "",
    x: (l.x ?? 0) + ox + (l.width ?? 0) / 2,
    y: (l.y ?? 0) + oy + (l.height ?? 0) / 2,
  };
}

/** Keep a cross-workflow handoff attached to its actual source and target step. */
function attachCrossEdgeToSteps(
  points: Point[],
  source: PlacedStep,
  target: PlacedStep
): Point[] {
  if (points.length < 2) return points;
  const sourcePortX = points[0].x;
  const targetPortX = points[points.length - 1].x;
  const start = { x: source.x + source.w, y: source.y + source.h / 2 };
  const end = { x: target.x, y: target.y + target.h / 2 };
  const expanded = [
    start,
    { x: sourcePortX, y: start.y },
    ...points,
    { x: targetPortX, y: end.y },
    end,
  ];
  return expanded.filter(
    (point, index) =>
      index === 0 ||
      point.x !== expanded[index - 1].x ||
      point.y !== expanded[index - 1].y
  );
}

/**
 * Compute the nested graph layout for an `AtlasModel`.
 *
 * Pure w.r.t. inputs (no React); async because ELK runs in a worker/promise.
 */
export async function layoutFull(
  model: AtlasModel,
  opts: LayoutFullOptions = {}
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
  const sizesByStep = new Map(
    model.steps.map((step) => {
      const size = stepSize(step.kind, { width: STEP_W, height: STEP_H });
      return [
        step.id,
        {
          width: opts.stepW ?? size.width,
          height: opts.stepH ?? size.height,
        },
      ] as const;
    })
  );
  const preferredLaneWidth = 640 / Math.max(1, model.workflows.length);

  const meta: Record<string, EdgeMeta> = {};

  // ── containers: one ELK node per workflow, step children laid out DOWN ──
  const containers: ElkNode[] = model.workflows.map((w) => {
    const wSteps = stepsByWorkflow.get(w.id) ?? [];
    const widestStep = Math.max(
      0,
      ...wSteps.map((step) => sizesByStep.get(step.id)!.width)
    );
    const laneMinWidth = Math.max(widestStep + 40, preferredLaneWidth);
    const node: ElkNode = {
      id: w.id,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        // explicit: keep child layout independent of the root's RIGHT flow.
        "elk.hierarchyHandling": "SEPARATE_CHILDREN",
        "elk.padding": `[top=${HEAD},left=20,bottom=40,right=20]`,
        "elk.spacing.nodeNode": "22",
        "elk.layered.spacing.nodeNodeBetweenLayers": "40",
        "elk.nodeSize.constraints": "MINIMUM_SIZE",
        "elk.nodeSize.minimum": `(${laneMinWidth}.0,0.0)`,
        "elk.contentAlignment": "H_CENTER V_TOP",
      },
      children: wSteps.map((st) => ({
        id: st.id,
        width: sizesByStep.get(st.id)!.width,
        height: sizesByStep.get(st.id)!.height,
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

  // ── root graph: linked workflow containers laid out RIGHT ──
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
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
    const workflowSteps = stepsByWorkflow.get(c.id) ?? [];
    const stopOrder = workflowSteps.find((step) => step.kind === "stop")?.order;
    const steps: PlacedStep[] = (c.children ?? []).map((st, i) => {
      const def = stepById.get(st.id)!;
      const nodeX = st.x ?? 0;
      const nodeY = st.y ?? 0;
      const nodeWidth = st.width ?? STEP_W;
      const isStop = def.kind === "stop";
      return {
        id: st.id,
        stepId: def.stepId,
        workflowId: def.workflowId,
        name: def.name,
        goal: def.goal,
        kind: def.kind,
        role: def.role,
        futureRun: stopOrder !== undefined && def.order > stopOrder,
        idx: i + 1,
        x: cx + (isStop ? 20 : nodeX),
        y: cy + nodeY,
        w: isStop ? Math.max(0, (c.width ?? nodeWidth + 40) - 40) : nodeWidth,
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
      }
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

  // ── loop-backs: return up the lane's left gutter ──
  const loopGeo: PlacedEdge[] = loops
    .map((lp): PlacedEdge | null => {
      const w = wfById.get(lp.workflowId);
      if (!w) return null;
      const from = w.steps.find((s) => s.id === lp.from);
      const to = w.steps.find((s) => s.id === lp.to);
      if (!from || !to) return null;
      const gutterX = Math.min(...w.steps.map((step) => step.x)) - 28;
      const sourceY = from.y + from.h / 2;
      const targetY = to.y + to.h / 2;
      const points: Point[] = [
        { x: from.x, y: sourceY },
        { x: gutterX, y: sourceY },
        { x: gutterX, y: targetY },
        { x: to.x, y: targetY },
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
        labelPos: {
          text: lp.label ?? "",
          x: (from.x + gutterX) / 2,
          y: sourceY,
        },
      };
    })
    .filter((x): x is PlacedEdge => x !== null);

  for (const w of placedWorkflows) {
    const mine = loopGeo.filter((l) => l.fromWorkflow === w.id);
    if (mine.length) w.intra = w.intra.concat(mine);
  }

  // ── cross edges from ELK: re-anchor onto box borders ──
  const cross: PlacedEdge[] = ((r.edges ?? []) as ElkExtendedEdge[]).map(
    (e) => {
      const m = meta[e.id];
      const A = wfById.get(m.fromWorkflow);
      const B = wfById.get(m.toWorkflow);
      let points = edgePoints(firstSection(e), 0, 0);
      if (A && B) {
        points = anchorEdge(points, A, B);
        const source = A.steps.find((step) => step.id === m.from);
        const target = B.steps.find((step) => step.id === m.to);
        if (source && target) {
          points = attachCrossEdgeToSteps(points, source, target);
        }
      }
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
    }
  );

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
