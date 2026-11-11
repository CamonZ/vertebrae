/**
 * The five universal states are poses of a part's scenarios, never separate
 * drawings (catalogue "Universal states"):
 *
 * - idle: scenario 0 at t = 0, no cards;
 * - working: scenario 0 at its last in-progress status before the outcome;
 * - ok: scenario 0, 0.3 s after its last green status (capped before the next
 *   note), or after its last status when the happy outcome is not green;
 * - failed: scenario 1, 0.3 s after its last red status (else its still);
 * - absent: no instance, dashed and ghosted, no cards.
 */
import type { DiagramPose, StatusNote } from "./timeline";
import type { StateRole } from "./palette";

export const UNIVERSAL_STATES = [
  "idle",
  "working",
  "ok",
  "failed",
  "absent",
] as const;
export type UniversalState = (typeof UNIVERSAL_STATES)[number];

/** The timing facts of one scenario that the poses are derived from. */
export interface ScenarioTiming {
  readonly period: number;
  /** Sealed notes (including the closing return to idle). */
  readonly notes: readonly StatusNote[];
  /** Still time for static views. */
  readonly still: number;
}

export interface StatePose {
  readonly state: UniversalState;
  /** Scenario the pose is taken from: 1 for failed, else 0. */
  readonly scenario: 0 | 1;
  readonly t: number;
  readonly pose: DiagramPose;
}

/** Latest time a pose may use: before the loop's closing fade. */
const settleLimit = (s: ScenarioTiming) => s.period - 0.6;

export function firstNoteWithRole(
  s: ScenarioTiming,
  role: StateRole
): number | null {
  for (const [t, , r] of s.notes) if (t > 0 && r === role) return t;
  return null;
}

/** 0.3 s after the last status before the loop returns to idle (or `fallback`). */
export function lastStatusTime(s: ScenarioTiming, fallback: number): number {
  const limit = settleLimit(s);
  const list = s.notes.filter(
    ([t, text]) => t > 0 && t <= limit && text !== "idle"
  );
  if (list.length === 0) return fallback;
  return Math.min(list[list.length - 1][0] + 0.3, limit);
}

/**
 * Outcome time: 0.3 s after the last status of `role`, capped before the
 * next note and the closing fade; `fallback` when there is no such status.
 */
export function outT(
  s: ScenarioTiming,
  role: StateRole,
  fallback: number
): number {
  const n = s.notes;
  const limit = settleLimit(s);
  let r: number | null = null;
  for (let i = 0; i < n.length; i++) {
    const [t, , k] = n[i];
    if (t > 0 && k === role && t <= limit) {
      const next = n.slice(i + 1).find((x) => x[0] > t);
      r = Math.min(t + 0.3, limit, next ? next[0] - 0.02 : Infinity);
    }
  }
  return r ?? fallback;
}

/** Working time: shortly after the last in-progress status before the outcome. */
export function workT(s: ScenarioTiming): number {
  const end = firstNoteWithRole(s, "green") ?? lastStatusTime(s, s.still) - 0.3;
  let w: number | null = null;
  for (const [t, text, k] of s.notes) {
    if (
      t > 0 &&
      text !== "idle" &&
      k !== "green" &&
      k !== "red" &&
      t + 0.15 < end
    ) {
      w = Math.min(t + 0.35, end - 0.05);
    }
  }
  return w ?? Math.max(0.05, s.still * 0.5);
}

/**
 * Pose for a universal state. `scenarios[0]` is the happy path and
 * `scenarios[1]` the first failure (or the part's first variant).
 */
export function statePose(
  scenarios: readonly [ScenarioTiming, ScenarioTiming, ...ScenarioTiming[]],
  state: UniversalState
): StatePose {
  const [happy, failure] = scenarios;
  switch (state) {
    case "idle":
      return { state, scenario: 0, t: 0, pose: "idle" };
    case "absent":
      return { state, scenario: 0, t: 0, pose: "absent" };
    case "working":
      return { state, scenario: 0, t: workT(happy), pose: "live" };
    case "ok":
      return {
        state,
        scenario: 0,
        t: outT(happy, "green", lastStatusTime(happy, happy.still)),
        pose: "live",
      };
    case "failed":
      return {
        state,
        scenario: 1,
        t: outT(failure, "red", failure.still),
        pose: "live",
      };
  }
}
