import type { StepType } from "../../bindings";

/**
 * Canonical step type after normalising the broader StepType union from
 * the bindings, which includes the `{ unsupported: string }` fallback and
 * future server-side additions.
 */
export type StepKind =
  | "execute"
  | "evaluate"
  | "route"
  | "human_input"
  | "wait_children"
  | "unknown";

export interface StepTypeStyle {
  kind: StepKind;
  /** Human-readable label (e.g., "AI" / "Review" / "Holding"). */
  label: string;
  /** Single-character glyph used in compact spaces (next to the name). */
  icon: string;
  /** CSS variable name (without `var()`) for the 3px top accent bar. */
  barVar: string;
  /** Background tint applied subtly to the node body. */
  washVar: string;
  /** Readable foreground colour on top of the tint. */
  fgVar: string;
}

export function normalizeStepType(stepType: StepType | null | undefined): StepKind {
  if (!stepType) return "unknown";
  if (typeof stepType === "string") return stepType as StepKind;
  return "unknown";
}

const styles: Record<StepKind, StepTypeStyle> = {
  execute: {
    kind: "execute",
    label: "Execute",
    icon: "⚡",
    barVar: "--color-step-execute",
    washVar: "--color-step-execute-wash",
    fgVar: "--color-step-execute-fg",
  },
  evaluate: {
    kind: "evaluate",
    label: "Evaluate",
    icon: "✓",
    barVar: "--color-step-eval",
    washVar: "--color-step-eval-wash",
    fgVar: "--color-step-eval-fg",
  },
  route: {
    kind: "route",
    label: "Route",
    icon: "⤳",
    barVar: "--color-step-route",
    washVar: "--color-step-route-wash",
    fgVar: "--color-step-route-fg",
  },
  human_input: {
    kind: "human_input",
    label: "Human Review",
    icon: "👁",
    barVar: "--color-step-human",
    washVar: "--color-step-human-wash",
    fgVar: "--color-step-human-fg",
  },
  wait_children: {
    kind: "wait_children",
    label: "Waiting",
    icon: "⏸",
    barVar: "--color-step-wait",
    washVar: "--color-step-wait-wash",
    fgVar: "--color-step-wait-fg",
  },
  unknown: {
    kind: "unknown",
    label: "Step",
    icon: "▸",
    barVar: "--color-line-strong",
    washVar: "--color-bg-1",
    fgVar: "--color-fg-mute",
  },
};

export function stepTypeStyle(
  stepType: StepType | null | undefined,
): StepTypeStyle {
  return styles[normalizeStepType(stepType)];
}
