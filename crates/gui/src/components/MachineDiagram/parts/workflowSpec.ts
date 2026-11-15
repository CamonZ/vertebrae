/**
 * workflow station layout (catalogue v2.2 "workflow", Props and layout): the
 * only prop-driven part. `steps` (step types in order, 1–20) and
 * `transitions` (the workflow's outgoing workflow transitions, by target)
 * derive the frame, the lamps, the out ports (at most four, the fourth
 * bundling the rest), the status anchor and one stage per lamp. Shared by
 * the gallery part and the flow kind so both draw the same station.
 *
 * Nothing here reads a step or workflow name: lamps are placed and coloured
 * by position and `step_type` only.
 */
import type { BBox } from "../ChangeMark";
import { textWidth } from "../flow/measure";
import type { StepHueRole, SurfaceRole } from "../palette";

/** Step types a workflow station draws (crates/core StepType). */
export const WORKFLOW_STEP_TYPES = [
  "llm_inference",
  "structured_inference",
  "execute",
  "route",
  "wait_children",
  "human_input",
  "stop",
  "finish",
] as const;
export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

export const isWorkflowStepType = (v: unknown): v is WorkflowStepType =>
  typeof v === "string" &&
  (WORKFLOW_STEP_TYPES as readonly string[]).includes(v);

/** Palette role of each step type's lamp core (Hearth --color-step-*; execute is neutral). */
export const STEP_HUE: Readonly<Record<WorkflowStepType, StepHueRole>> = {
  llm_inference: "step-llm",
  structured_inference: "step-structured",
  execute: "step-execute",
  route: "step-route",
  wait_children: "step-wait",
  human_input: "step-human",
  stop: "step-stop",
  finish: "step-finish",
};

/** Lamp core role for a step type; anything unrecognised gets the plain edge grey. */
export const stepHue = (type: string): StepHueRole | SurfaceRole =>
  isWorkflowStepType(type) ? STEP_HUE[type] : "edge";

/** Only these step types park a run (the waiting rim). */
export const PARKING_STEP_TYPES: readonly WorkflowStepType[] = [
  "human_input",
  "wait_children",
];

export const WORKFLOW_MIN_STEPS = 1;
export const WORKFLOW_MAX_STEPS = 20;
/** Out ports drawn at most; past this the last port bundles the rest. */
export const WORKFLOW_PORT_CAP = 4;

/**
 * Pitch of the second lamp row (11–20 steps). The catalogue says 44 px, but
 * a 14 px rim under a type mark 26 + 6 px below the row above needs 46 px
 * plus stroke; 52 px keeps them apart. No gallery scenario has two rows.
 */
export const ROW_PITCH = 52;

/** Port labels are right-aligned here, 18 px above their rail. */
export const LABEL_X = 616;
/** Rails leave the part canvas here (in W and out E). */
export const EDGE_IN = 24;
export const EDGE_OUT = 616;

export interface WorkflowOut {
  /** Flow port name: `out1` … `out4` (`in1` … `in4` on a factory's W side). */
  readonly port: string;
  readonly label: string;
  /** Transitions leaving by this port (more than one for the bundle). */
  readonly targets: readonly string[];
  readonly y: number;
  readonly bundle: boolean;
}

export interface WorkflowLamp {
  readonly x: number;
  readonly y: number;
  readonly type: string;
}

export interface WorkflowStage {
  readonly name: string;
  readonly bb: BBox;
  readonly tag: readonly [number, number];
}

export interface WorkflowLayout {
  readonly n: number;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
  /** Track the TaskRun card rides, 40 px above the bottom. */
  readonly ty: number;
  /** Lamp spacing (56 up to four per row, else 36). */
  readonly spacing: number;
  /** x of the inner rail's turn up to the ports, 30 px inside the E edge. */
  readonly turn: number;
  readonly lamps: readonly WorkflowLamp[];
  readonly outs: readonly WorkflowOut[];
  readonly bb: BBox;
  readonly status: { readonly x: number; readonly y: number };
  /** Chip tray: right edge chip centre and row. */
  readonly chips: { readonly x: number; readonly y: number };
  readonly stages: readonly WorkflowStage[];
}

/** Index into `outs` of the port a transition leaves by (-1 if none); bundled targets share the last. */
export const outIndex = (L: WorkflowLayout, target: string) =>
  L.outs.findIndex((o) => o.targets.includes(target));

/** Room for a port label between the frame's E edge and x 616. */
export const labelRoom = (x1: number) => LABEL_X - x1 - 8;

/** A port label cut with an ellipsis to fit `room` px at 18 px. */
export function fitLabel(label: string, room: number): string {
  if (textWidth(label, 18) <= room) return label;
  let s = label;
  while (s.length > 1 && textWidth(`${s}…`, 18) > room) s = s.slice(0, -1);
  return `${s}…`;
}

/**
 * Station ports for `targets` (catalogue "Bundling", shared by the workflow
 * and factory stations): at most four, port 4 bundling the rest as
 * `+k more`. One port sits at `ty`; 2–4 are spread from `y0 + 30` to
 * `y0 + h − 30`. Labels are cut to `room` px.
 */
export function bundlePorts(
  targets: readonly string[],
  prefix: string,
  y0: number,
  h: number,
  ty: number,
  room: number
): WorkflowOut[] {
  const bundled = targets.length > WORKFLOW_PORT_CAP;
  const shown = bundled ? WORKFLOW_PORT_CAP : targets.length;
  const outs: WorkflowOut[] = [];
  for (let j = 0; j < shown; j++) {
    const more = bundled && j === shown - 1;
    outs.push({
      port: `${prefix}${j + 1}`,
      label: fitLabel(
        more ? `+${targets.length - shown + 1} more` : targets[j],
        room
      ),
      targets: more ? targets.slice(j) : [targets[j]],
      y: shown === 1 ? ty : Math.round(y0 + 30 + (j * (h - 60)) / (shown - 1)),
      bundle: more,
    });
  }
  return outs;
}

/** Ports a list of targets draws: at most four. */
export const shownPorts = (n: number) => Math.min(n, WORKFLOW_PORT_CAP);

/** The catalogue layout rules for `steps` and `transitions`. */
export function workflowLayout(
  steps: readonly string[],
  transitions: readonly string[]
): WorkflowLayout {
  const n = Math.max(1, steps.length);
  const per = n > 10 ? Math.ceil(n / 2) : n;
  const rows = Math.ceil(n / per);
  const shown = shownPorts(transitions.length);
  const s = per <= 4 ? 56 : 36;
  const w = Math.max(228, per * s + 60);
  const x0 = Math.round(320 - w / 2);
  const x1 = x0 + w;
  const y0 = 112;
  const h = Math.max(150, 60 + (shown - 1) * 44) + ROW_PITCH * (rows - 1);
  const ty = y0 + h - 40;
  const lx = (i: number) => x0 + (w - (per - 1) * s) / 2 + (i % per) * s;
  const ly = (i: number) => 150 + ROW_PITCH * Math.floor(i / per);
  const outs = bundlePorts(transitions, "out", y0, h, ty, labelRoom(x1));
  const lamps = steps.map((type, i) => ({ x: lx(i), y: ly(i), type }));
  const half = Math.min(s, 56) / 2 - 2;
  return {
    n,
    x0,
    x1,
    y0,
    w,
    h,
    ty,
    spacing: s,
    turn: x1 - 30,
    lamps,
    outs,
    bb: [x0, y0, w, h],
    // 40 px under the frame, at most y 346 (catalogue); the tallest frames
    // (two lamp rows and four ports) reach past 306, so stay 24 px under them.
    status: { x: 320, y: Math.max(Math.min(y0 + h + 40, 346), y0 + h + 24) },
    chips: { x: x1 - 10, y: y0 - 26 },
    stages: lamps.map((l, i) => ({
      name: `step ${i + 1}`,
      bb: [l.x - half, l.y - 18, half * 2, 52],
      tag: [l.x, l.y - 30],
    })),
  };
}

/** Status-line position words: `step 2/3 · execute` (types and positions, never names). */
export const stepWords = (steps: readonly string[], i: number) =>
  `step ${i + 1}/${steps.length} · ${steps[i] ?? "step"}`;
