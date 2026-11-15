/**
 * factory station layout (catalogue v2.2 "factory", Props and layout): the
 * workflow station one level up. `workflows` (the step count of each
 * workflow, in factory order, 1–20), `inbound` and `outbound` (the Atlas
 * factory routes, `factoryOverviewModel.ts` factoryRoutes from/to) derive
 * the frame, one workflow mark per workflow, the in and out ports (at most
 * four a side, bundled past that as on the workflow station), the status
 * anchor and one stage per mark. Shared by the gallery part and the flow
 * kind so both draw the same station.
 *
 * Nothing here reads a factory or workflow name for placement or colour:
 * marks are placed by order and drawn from step counts; factory names are
 * port labels only.
 */
import { windowed } from "../motion";
import { gateV } from "../timeline";
import {
  WORKFLOW_MAX_STEPS,
  bundlePorts,
  fitLabel,
  labelRoom,
  shownPorts,
  type WorkflowLayout,
  type WorkflowOut,
  type WorkflowStage,
} from "./workflowSpec";

export const FACTORY_MIN_WORKFLOWS = 1;
export const FACTORY_MAX_WORKFLOWS = 20;
/** Step counts a workflow mark can stand for (a workflow's own bounds). */
export const FACTORY_MAX_STEPS = WORKFLOW_MAX_STEPS;
/** Dots a workflow mark draws at most (one per step). */
export const MARK_DOTS = 5;

/** Marks per row: all up to seven, else two rows. */
const ROW_CAP = 7;
/** Mark spacing in a row, and the pitch between rows. */
export const MARK_SPACING = 44;
export const MARK_ROW_PITCH = 64;
/** A mark's dock (where the task card waits) sits this far under it. */
export const DOCK_DY = 30;
/** In labels are left-aligned here, 18 px above their rail. */
export const IN_LABEL_X = 24;

export interface FactoryMark {
  readonly x: number;
  readonly y: number;
  /** The workflow's step count (dots: up to five). */
  readonly steps: number;
  readonly dock: readonly [number, number];
}

export interface FactoryLayout extends Pick<
  WorkflowLayout,
  "n" | "x0" | "x1" | "y0" | "w" | "h" | "bb" | "status" | "chips"
> {
  readonly per: number;
  readonly rows: number;
  /** The last row's track, where out ports leave and the lone entry arrives. */
  readonly ty: number;
  readonly marks: readonly FactoryMark[];
  /** Row tracks the card rides dock to dock: `[x from, x to, y]`. */
  readonly tracks: readonly (readonly [number, number, number])[];
  /** W ports: one per inbound factory (`in1`…`in4`), or one unlabelled `in`. */
  readonly ins: readonly WorkflowOut[];
  /** E ports: one per outbound factory (`out1`…`out4`). */
  readonly outs: readonly WorkflowOut[];
  /** x of the in ports' turn to the first dock, 24 px inside the W edge. */
  readonly inTurn: number;
  /** x of the out ports' turn off the last track, 24 px inside the E edge. */
  readonly turn: number;
  readonly stages: readonly WorkflowStage[];
}

/** Room for an in label between x 24 and the frame's W edge. */
export const inLabelRoom = (x0: number) => x0 - IN_LABEL_X - 8;

/** The catalogue layout rules for `workflows`, `inbound` and `outbound`. */
export function factoryLayout(
  workflows: readonly number[],
  inbound: readonly string[],
  outbound: readonly string[]
): FactoryLayout {
  const n = Math.max(1, workflows.length);
  const per = n > ROW_CAP ? Math.ceil(n / 2) : n;
  const rows = Math.ceil(n / per);
  const s = MARK_SPACING;
  const ports = Math.max(
    shownPorts(inbound.length),
    shownPorts(outbound.length),
    1
  );
  const w = Math.max(228, per * s + 84);
  const x0 = Math.round(320 - w / 2);
  const x1 = x0 + w;
  const y0 = 112;
  const h = Math.max(150 + MARK_ROW_PITCH * (rows - 1), 60 + (ports - 1) * 44);
  const mx = (i: number) => x0 + (w - (per - 1) * s) / 2 + (i % per) * s;
  const my = (i: number) => 150 + MARK_ROW_PITCH * Math.floor(i / per);
  const ty = my(n - 1) + DOCK_DY;
  const marks = Array.from({ length: n }, (_, i) => ({
    x: mx(i),
    y: my(i),
    steps: Math.max(1, workflows[i] ?? 1),
    dock: [mx(i), my(i) + DOCK_DY] as const,
  }));
  const tracks = Array.from({ length: rows }, (_, r) => {
    const a = r * per;
    const b = Math.min(n, a + per) - 1;
    return [mx(a), mx(b), my(a) + DOCK_DY] as const;
  });
  const ins = inbound.length
    ? bundlePorts(inbound, "in", y0, h, ty, inLabelRoom(x0))
    : [{ port: "in", label: "", targets: [], y: ty, bundle: false }];
  const outs = bundlePorts(outbound, "out", y0, h, ty, labelRoom(x1));
  const half = s / 2 - 2;
  return {
    n,
    per,
    rows,
    x0,
    x1,
    y0,
    w,
    h,
    ty,
    marks,
    tracks,
    ins,
    outs,
    inTurn: x0 + 24,
    turn: x1 - 24,
    bb: [x0, y0, w, h],
    // 40 px under the frame, at most y 346 (catalogue); the tallest frame
    // (two rows, 214 px) ends at 326.
    status: { x: 320, y: Math.min(y0 + h + 40, 346) },
    chips: { x: x1 - 10, y: y0 - 26 },
    stages: marks.map((m, i) => ({
      name: `workflow ${i + 1}`,
      bb: [m.x - half, m.y - 18, half * 2, 56],
      tag: [m.x, m.y - 30],
    })),
  };
}

/** Index into `ins` of the port a factory's work arrives by (the bundle past the cap; 0 if none). */
export const inIndex = (L: FactoryLayout, factory: string) =>
  Math.max(
    0,
    L.ins.findIndex((o) => o.targets.includes(factory))
  );

/** Index into `outs` of the port a hand-off to `factory` leaves by (-1 if none). */
export const factoryOutIndex = (L: FactoryLayout, factory: string) =>
  L.outs.findIndex((o) => o.targets.includes(factory));

/** The lit label of a bundled port: `<factory> →` on the W side, `→ <factory>` on the E. */
export const litInLabel = (L: FactoryLayout, factory: string) =>
  fitLabel(`${factory} →`, inLabelRoom(L.x0));
export const litOutLabel = (L: FactoryLayout, factory: string) =>
  fitLabel(`→ ${factory}`, labelRoom(L.x1));

/** Status-line position words: `workflow 2/13` (positions, never names). */
export const workflowWords = (n: number, i: number) => `workflow ${i + 1}/${n}`;

/** A lit port window (the workflow station's WorkflowPortLight). */
type PortLight = { readonly w: readonly [number, number] };

const glow = (list: readonly PortLight[]) => (t: number) =>
  Math.max(0, ...list.map((p) => windowed(t, ...p.w)));

/** One gate per in port on the W edge and per out port on the E edge, amber while lit. */
export const factoryGates = (
  L: FactoryLayout,
  ins: readonly (readonly PortLight[])[] = [],
  outs: readonly (readonly PortLight[])[] = []
) => [
  ...L.ins.map((o, j) => gateV(L.x0, o.y, ins[j] ? glow(ins[j]) : undefined)),
  ...L.outs.map((o, j) =>
    gateV(L.x1, o.y, outs[j] ? glow(outs[j]) : undefined)
  ),
];
