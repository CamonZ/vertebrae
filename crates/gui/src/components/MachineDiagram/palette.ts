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
export type Role = StateRole | SurfaceRole;
export type WashRole = "amber" | "green" | "red";

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

export function roleColor(role: Role): string {
  return `var(--md-${role})`;
}

export function washColor(role: WashRole): string {
  return `var(--md-${role}-wash)`;
}

/** Text never drops below 18 px in the 640×400 logical part space (VL-04). */
export const MIN_TEXT_SIZE = 18;
