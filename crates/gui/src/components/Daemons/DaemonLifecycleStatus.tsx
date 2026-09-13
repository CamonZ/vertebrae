import type { DaemonErrorKind } from "../../bindings";
import { daemonActionErrorMessage } from "../../daemons/errors";

export type DaemonLifecycleAction = "rename" | "unregister";
export type DaemonLifecyclePhase = "submitting" | "success" | "error";

interface DaemonLifecycleStatusProps {
  action: DaemonLifecycleAction;
  phase: DaemonLifecyclePhase;
  error?: string | null;
  errorKind?: DaemonErrorKind | null;
  testId?: string;
}

const SUBMIT_LABELS: Record<DaemonLifecycleAction, string> = {
  rename: "Saving daemon name on the server…",
  unregister: "Checking server eligibility and unregistering…",
};

const SUCCESS_LABELS: Record<DaemonLifecycleAction, string> = {
  rename: "Daemon name saved on the server.",
  unregister: "Daemon unregistered on the server.",
};

export function DaemonLifecycleStatus({
  action,
  phase,
  error = null,
  errorKind = null,
  testId = "daemon-lifecycle-status",
}: DaemonLifecycleStatusProps) {
  const message =
    phase === "submitting"
      ? SUBMIT_LABELS[action]
      : phase === "success"
        ? SUCCESS_LABELS[action]
        : daemonActionErrorMessage(
            errorKind,
            error ?? "The daemon lifecycle operation was not applied."
          );

  return (
    <p
      className={[
        "rounded-[var(--radius-sm)] border px-3 py-2 text-xs leading-relaxed",
        phase === "error"
          ? "border-[var(--color-err)]/40 bg-[var(--color-err-wash)] text-[var(--color-err)]"
          : phase === "success"
            ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
            : "border-[var(--color-line)] bg-[var(--color-bg-1)] text-[var(--color-fg-mute)]",
      ].join(" ")}
      role={phase === "error" ? "alert" : "status"}
      aria-live="polite"
      data-testid={testId}
    >
      {message}
    </p>
  );
}
