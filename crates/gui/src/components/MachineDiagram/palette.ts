/**
 * Diagram colour roles. Colour means state only (VL-03): grey idle or in
 * progress, ink just happened, amber waiting or in flight, green ok, red
 * failed. Surface roles draw the machines themselves.
 *
 * Every role resolves through a `--md-*` custom property declared in
 * MachineDiagram.css, which maps it onto the app theme tokens. Components
 * never carry colour values, so switching light/dark recolours a rendered
 * diagram without re-rendering it.
 */
export type StateRole = "dim" | "ink" | "amber" | "green" | "red";
export type SurfaceRole =
  | "bg"
  | "fill"
  | "div"
  | "rail"
  | "edge"
  | "plate"
  | "hole"
  | "ghost";
/**
 * Step-type hues: the one sanctioned exception to VL-03 (catalogue v2.2
 * "Step-type hues"). A workflow station's lamp core takes its `step_type`'s
 * app colour (Hearth `--color-step-*`; `execute` has no hue and uses the
 * neutral `--color-fg-soft`). Identity only: state stays on the rim.
 */
export type StepHueRole =
  | "step-llm"
  | "step-structured"
  | "step-execute"
  | "step-route"
  | "step-human"
  | "step-wait"
  | "step-stop"
  | "step-finish";
export type Role = StateRole | SurfaceRole | StepHueRole;
export type WashRole = "amber" | "green" | "red";
/**
 * Roles a card, ring or lamp can take: the state roles plus the edge grey
 * the gallery uses for work that was discarded or cancelled (still no
 * colour beyond state, VL-03).
 */
export type CardRole = StateRole | "edge";

export const STATE_ROLES: readonly StateRole[] = [
  "dim",
  "ink",
  "amber",
  "green",
  "red",
];
export const SURFACE_ROLES: readonly SurfaceRole[] = [
  "bg",
  "fill",
  "div",
  "rail",
  "edge",
  "plate",
  "hole",
  "ghost",
];

export const STEP_HUE_ROLES: readonly StepHueRole[] = [
  "step-llm",
  "step-structured",
  "step-execute",
  "step-route",
  "step-human",
  "step-wait",
  "step-stop",
  "step-finish",
];

export function roleColor(role: Role): string {
  return `var(--md-${role})`;
}

export function washColor(role: WashRole): string {
  return `var(--md-${role}-wash)`;
}

/** Text never drops below 18 px in the 640×400 logical part space (VL-04).
 *  These are SVG user units, a documented type-scale exception: diagram text
 *  scales with the canvas zoom, not the CSS type tokens. */
export const MIN_TEXT_SIZE = 18;
