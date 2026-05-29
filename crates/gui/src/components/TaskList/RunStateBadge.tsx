import { useEffect, useState } from "react";
import type { RunStateChip } from "../../utils/runState";
import { formatStepName } from "../../utils/formatStepName";
import { formatDuration } from "../Operations/formatDuration";
import { Spinner } from "../Spinner";

interface RunStateBadgeProps {
  /** Derived run chip; the badge renders nothing unless this run is active. */
  chip: RunStateChip;
  /** Name of the step currently being run (the "step type" surfaced inline). */
  stepName: string | null;
  /** ISO 8601 start of the active run, used for the live elapsed timer. */
  startedAt: string | null;
}

/**
 * Tone -> Hearth semantic palette. Active runs are colored by state (queued =
 * info, running = ok, waiting = warn, stopping = muted) so the badge reads as a
 * live state rather than a neutral chip.
 */
function toneClasses(chip: RunStateChip): { bg: string; text: string } {
  switch (chip.tone) {
    case "success":
      return {
        bg: "bg-[var(--color-ok-wash)]",
        text: "text-[var(--color-ok)]",
      };
    case "info":
      return {
        bg: "bg-[var(--color-info-wash)]",
        text: "text-[var(--color-info)]",
      };
    case "warning":
      return {
        bg: "bg-[var(--color-warn-wash)]",
        text: "text-[var(--color-warn)]",
      };
    case "error":
      return {
        bg: "bg-[var(--color-err-wash)]",
        text: "text-[var(--color-err)]",
      };
    case "muted":
    case "neutral":
    default:
      return {
        bg: "bg-[var(--color-bg-2)]",
        text: "text-[var(--color-fg-mute)]",
      };
  }
}

/**
 * Live elapsed timer that re-renders every second while a run is in flight.
 */
function LiveElapsed({ startedAt }: { startedAt: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  return (
    <span className="tabular-nums" data-testid="task-tree-node-run-elapsed">
      {formatDuration(startedAt, null)}
    </span>
  );
}

/**
 * Run-state badge shown on the right edge of a row only while a run is active.
 * Colored by state, it pairs a spinner with the step type being run and a live
 * elapsed timer. It sits alongside (not in place of) the neutral
 * workflow|step `StatusBadge`, which remains the progress signal.
 */
export function RunStateBadge({
  chip,
  stepName,
  startedAt,
}: RunStateBadgeProps) {
  if (!chip.isActive) return null;

  const tone = toneClasses(chip);
  const stepType = stepName ? formatStepName(stepName, "") : null;

  return (
    <span
      data-testid="task-tree-node-run-badge"
      data-run-status={chip.status ?? "unknown"}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-2xs font-medium ${tone.bg} ${tone.text}`}
      title={`Run: ${chip.label}${stepType ? ` (${stepType})` : ""}`}
      aria-label={`Run state: ${chip.label}${stepType ? `, step ${stepType}` : ""}`}
    >
      <Spinner className="h-3 w-3" />
      <span className="truncate">{stepType ?? chip.label}</span>
      {startedAt && <LiveElapsed startedAt={startedAt} />}
    </span>
  );
}
