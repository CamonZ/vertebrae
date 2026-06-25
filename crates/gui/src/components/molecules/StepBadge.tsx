import type { CSSProperties } from "react";
import type { StepType, TaskRunStatus } from "../../bindings";
import { formatStepName } from "../../utils/formatStepName";
import {
  hearthStepKind,
  hearthStepStyle,
} from "../WorkflowPipeline/stepTypeStyling";

interface StepBadgeProps {
  stepName: string | null;
  stepType?: StepType | null;
  runStatus?: TaskRunStatus | null;
  emptyLabel?: string;
  className?: string;
}

interface BadgeVisual {
  style: CSSProperties;
  glow?: string;
}

function runStatusVisual(
  runStatus: TaskRunStatus | null | undefined
): BadgeVisual | null {
  switch (runStatus) {
    case "queued":
    case "waiting":
      return {
        style: {
          backgroundColor: "var(--color-info-wash)",
          color: "var(--color-info)",
        },
      };
    case "executing":
      return {
        style: {
          backgroundColor: "var(--color-warn-wash)",
          color: "var(--color-warn)",
        },
        glow: "shadow-[0_0_8px_var(--color-accent-glow)]",
      };
    case "stopping":
    case "stopped":
      return {
        style: {
          backgroundColor: "var(--color-bg-2)",
          color: "var(--color-fg-mute)",
        },
      };
    case "completed":
      return {
        style: {
          backgroundColor: "var(--color-ok-wash)",
          color: "var(--color-ok)",
        },
      };
    case "failed":
      return {
        style: {
          backgroundColor: "var(--color-err-wash)",
          color: "var(--color-err)",
        },
      };
    default:
      return null;
  }
}

function stepTypeVisual(stepType: StepType | null | undefined): BadgeVisual {
  const stepStyle = hearthStepStyle(hearthStepKind(stepType));
  return {
    style: {
      backgroundColor: `var(${stepStyle.washVar})`,
      color: `var(${stepStyle.fgVar})`,
    },
  };
}

export function StepBadge({
  stepName,
  stepType,
  runStatus,
  emptyLabel = "No step",
  className,
}: StepBadgeProps) {
  const visual = runStatusVisual(runStatus) ?? stepTypeVisual(stepType);
  return (
    <span
      className={[
        "inline-flex items-center rounded-[var(--radius-sm)] border border-current/30 px-2 py-0.5 text-2xs font-medium",
        visual.glow,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={visual.style}
    >
      {formatStepName(stepName, emptyLabel)}
    </span>
  );
}
