import { useState } from "react";
import type { Daemon, DaemonErrorKind } from "../../bindings";
import { Button } from "../atoms/Button";
import { Modal } from "../molecules/Modal";
import {
  DaemonLifecycleStatus,
  type DaemonLifecycleAction,
} from "./DaemonLifecycleStatus";

interface DaemonLifecycleConfirmationProps {
  open: boolean;
  action: Extract<DaemonLifecycleAction, "unregister">;
  daemon: Daemon;
  isSubmitting?: boolean;
  error?: string | null;
  errorKind?: DaemonErrorKind | null;
  onCancel: () => void;
  onConfirm: () => Promise<boolean> | boolean;
}

function daemonLabel(daemon: Daemon): string {
  return daemon.display_name || daemon.name || daemon.id;
}

export function DaemonLifecycleConfirmation({
  open,
  action,
  daemon,
  isSubmitting = false,
  error = null,
  errorKind = null,
  onCancel,
  onConfirm,
}: DaemonLifecycleConfirmationProps) {
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = isSubmitting || localSubmitting;
  const label = daemonLabel(daemon);

  const handleConfirm = async () => {
    if (busy) return;
    setLocalSubmitting(true);
    setLocalError(null);
    try {
      const succeeded = await onConfirm();
      if (succeeded) onCancel();
    } catch (reason) {
      setLocalError(
        reason instanceof Error
          ? reason.message
          : "The daemon lifecycle operation was not applied."
      );
    } finally {
      setLocalSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      preventClose={busy}
      hideClose
      variant="dialog"
      title="Delete daemon"
      className="w-[480px] max-w-[calc(100vw-2rem)]"
    >
      <div data-testid="daemon-lifecycle-confirmation">
        <p className="text-sm leading-relaxed text-[var(--color-fg-soft)]">
          Delete <strong>{label}</strong>? This permanently unregisters it from
          the active fleet and revokes access only after the server confirms
          the operation. Active work, live sessions, or unknown ownership will
          block the request, so no runs will be orphaned. Drain the daemon
          first when the server reports work is present.
        </p>
        <dl className="mt-4 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-bg-1)] px-3 py-2">
          <div className="flex items-start justify-between gap-3 py-1">
            <dt className="text-xs text-[var(--color-fg-mute)]">Daemon</dt>
            <dd className="text-right text-xs text-[var(--color-fg)]">
              {label}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3 py-1">
            <dt className="text-xs text-[var(--color-fg-mute)]">ID</dt>
            <dd className="max-w-[65%] break-all text-right font-mono text-2xs text-[var(--color-fg-soft)]">
              {daemon.id}
            </dd>
          </div>
        </dl>
        {(error || errorKind || localError) && (
          <div className="mt-4">
            <DaemonLifecycleStatus
              action={action}
              phase="error"
              error={localError ?? error}
              errorKind={localError ? null : errorKind}
              testId="daemon-lifecycle-confirmation-status"
            />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2 border-t border-[var(--color-line)] pt-3">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={busy}
            onClick={() => void handleConfirm()}
            data-testid={`daemon-lifecycle-confirm-${action}`}
          >
            Delete daemon
          </Button>
        </div>
      </div>
    </Modal>
  );
}
