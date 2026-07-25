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
  | "finish"
  | "unknown";

export type HearthStepKind =
  | "execute"
  | "eval"
  | "route"
  | "human"
  | "wait"
  | "finish"
  | "unknown";

export interface StepTypeStyle {
  kind: StepKind;
  /** V2-facing kind used for stable Hearth classes such as `kind-eval`. */
  hearthKind: HearthStepKind;
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

export interface HearthStepStyle {
  kind: HearthStepKind;
  label: string;
  barVar: string;
  washVar: string;
  fgVar: string;
}

export function normalizeStepType(
  stepType: StepType | null | undefined
): StepKind {
  if (!stepType) return "unknown";
  if (typeof stepType === "string") return stepType as StepKind;
  return "unknown";
}

const styles: Record<StepKind, StepTypeStyle> = {
  execute: {
    kind: "execute",
    hearthKind: "execute",
    label: "Execute",
    icon: "⚡",
    barVar: "--color-step-execute",
    washVar: "--color-step-execute-wash",
    fgVar: "--color-step-execute-fg",
  },
  evaluate: {
    kind: "evaluate",
    hearthKind: "eval",
    label: "Evaluate",
    icon: "✓",
    barVar: "--color-step-eval",
    washVar: "--color-step-eval-wash",
    fgVar: "--color-step-eval-fg",
  },
  route: {
    kind: "route",
    hearthKind: "route",
    label: "Route",
    icon: "⤳",
    barVar: "--color-step-route",
    washVar: "--color-step-route-wash",
    fgVar: "--color-step-route-fg",
  },
  human_input: {
    kind: "human_input",
    hearthKind: "human",
    label: "Human Review",
    icon: "👁",
    barVar: "--color-step-human",
    washVar: "--color-step-human-wash",
    fgVar: "--color-step-human-fg",
  },
  wait_children: {
    kind: "wait_children",
    hearthKind: "wait",
    label: "Waiting",
    icon: "⏸",
    barVar: "--color-step-wait",
    washVar: "--color-step-wait-wash",
    fgVar: "--color-step-wait-fg",
  },
  finish: {
    kind: "finish",
    hearthKind: "finish",
    label: "Finish",
    icon: "✓",
    barVar: "--color-step-finish",
    washVar: "--color-step-finish-wash",
    fgVar: "--color-step-finish-fg",
  },
  unknown: {
    kind: "unknown",
    hearthKind: "unknown",
    label: "Step",
    icon: "▸",
    barVar: "--color-line-strong",
    washVar: "--color-bg-1",
    fgVar: "--color-fg-mute",
  },
};

export function stepTypeStyle(
  stepType: StepType | null | undefined
): StepTypeStyle {
  return styles[normalizeStepType(stepType)];
}

export function hearthStepKind(
  stepType: StepType | null | undefined
): HearthStepKind {
  return stepTypeStyle(stepType).hearthKind;
}

export function hearthStepStyle(kind: HearthStepKind): HearthStepStyle {
  const style =
    Object.values(styles).find((candidate) => candidate.hearthKind === kind) ??
    styles.unknown;

  return {
    kind: style.hearthKind,
    label: style.label,
    barVar: style.barVar,
    washVar: style.washVar,
    fgVar: style.fgVar,
  };
}
