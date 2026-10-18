import type { ReactNode } from "react";
import type { HearthRunState } from "../../utils/runState";
import type { GateChatPhase, GateChatStatus } from "../../utils/gateChat";
import { RunChip } from "../shared/HearthPrimitives";

const PHASES: Record<
  GateChatPhase,
  { state: HearthRunState; label: (attempt: number) => string; detail: string }
> = {
  drafting: {
    state: "waiting",
    label: () => "Drafting",
    detail: "Work out an answer to the gate's question.",
  },
  rejected: {
    state: "failed",
    label: (attempt) => `Rejected · attempt ${attempt}`,
    detail: "The review rejected the previous answer. Revise it here.",
  },
  under_review: {
    state: "running",
    label: () => "Under review",
    detail: "Your answer was submitted and is being reviewed.",
  },
  accepted: {
    state: "completed",
    label: () => "Accepted",
    detail: "The review accepted your answer and the run moved on.",
  },
  closed: {
    state: "stopped",
    label: () => "Gate closed",
    detail: "The run is no longer waiting on this gate.",
  },
};

interface GateChatStatusBarProps {
  stepName: string;
  status: GateChatStatus;
}

/** Where the gate a chat resolves stands, shown above the thread. */
export function GateChatStatusBar({
  stepName,
  status,
}: GateChatStatusBarProps): ReactNode {
  const phase = PHASES[status.phase];
  return (
    <div
      data-testid="gate-chat-status"
      data-phase={status.phase}
      data-attempt={status.attempt}
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-fg-soft)]"
    >
      <RunChip
        force
        small
        state={phase.state}
        label={phase.label(status.attempt)}
      />
      <span className="min-w-0 truncate">
        <span className="font-mono text-[var(--color-fg)]">{stepName}</span>
        {" · "}
        {phase.detail}
      </span>
    </div>
  );
}
