import { useState } from "react";
import type { Daemon, DaemonErrorKind, DaemonNameUpdate } from "../../bindings";
import { Badge } from "../atoms/Badge";
import { Button } from "../atoms/Button";
import { EmptyState } from "../molecules/EmptyState";
import { Spinner } from "../atoms";
import { InlineEditField } from "../TaskDetail/InlineEditField";
import {
  CloseIcon,
  FloatingDetailPanel,
  IconButton,
  PanelHeader,
  TrashIcon,
} from "../panels";
import {
  daemonFieldValue,
  daemonStatusIntent,
  daemonStatusLabel,
  formatDaemonTimestamp,
} from "../../daemons/filters";
import { daemonNameUpdate, validateDaemonName } from "../../daemons/name";
import { DaemonLifecycleConfirmation } from "./DaemonLifecycleConfirmation";
import {
  DaemonLifecycleStatus,
  type DaemonLifecycleAction,
} from "./DaemonLifecycleStatus";

interface DaemonInspectorProps {
  daemon: Daemon | null;
  isLoading: boolean;
  error: string | null;
  errorKind?: DaemonErrorKind | null;
  actionError?: string | null;
  actionErrorKind?: DaemonErrorKind | null;
  lifecycleAction?: DaemonLifecycleAction | null;
  isBusy?: boolean;
  isRenaming?: boolean;
  isReissuing?: boolean;
  isUnregistering?: boolean;
  closing?: boolean;
  onClose: () => void;
  onRename?: (daemonId: string, name: DaemonNameUpdate) => Promise<boolean>;
  onReissue: (daemonId: string) => void;
  onUnregister: (daemonId: string) => Promise<boolean>;
  onExitAnimationEnd: (event: {
    target: EventTarget;
    currentTarget: EventTarget;
  }) => void;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-3 border-b border-[var(--color-line)] py-2.5 last:border-b-0">
      <dt className="text-xs text-[var(--color-fg-mute)]">{label}</dt>
      <dd className="min-w-0 break-words text-right text-xs text-[var(--color-fg-soft)]">
        {value}
      </dd>
    </div>
  );
}

function DetailEditorRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start gap-3 border-b border-[var(--color-line)] py-2.5 last:border-b-0">
      <dt className="pt-2 text-xs text-[var(--color-fg-mute)]">{label}</dt>
      <dd className="min-w-0 text-right text-xs text-[var(--color-fg-soft)]">
        {children}
      </dd>
    </div>
  );
}

export function DaemonInspector({
  daemon,
  isLoading,
  error,
  errorKind = null,
  actionError = null,
  actionErrorKind = null,
  lifecycleAction = null,
  isBusy = false,
  isRenaming = false,
  isReissuing = false,
  isUnregistering = false,
  closing = false,
  onClose,
  onRename = async () => false,
  onReissue,
  onUnregister,
  onExitAnimationEnd,
}: DaemonInspectorProps) {
  const label = daemon?.display_name || daemon?.name || "Daemon";
  const [confirmation, setConfirmation] = useState<Exclude<
    DaemonLifecycleAction,
    "rename"
  > | null>(null);
  const actionBusy = isBusy || isRenaming || isReissuing || isUnregistering;
  const terminal = daemon?.status === "removed";
  const revoked = daemon?.status === "revoked";

  const confirmLifecycleAction = async (): Promise<boolean> => {
    if (!daemon || !confirmation) return false;
    return onUnregister(daemon.id);
  };

  return (
    <FloatingDetailPanel
      panelId="daemon-inspector"
      widthStorageKey="daemon-inspector-panel-width"
      closing={closing}
      onExitAnimationEnd={onExitAnimationEnd}
      onClose={onClose}
      shouldHandleEscape={() => !confirmation && !actionBusy}
      isOpen={!closing}
      className="daemons-page"
      testId="daemon-inspector"
    >
      <div
        className="flex h-full min-h-0 flex-col"
        role="complementary"
        aria-label="Daemon inspector"
      >
        <PanelHeader
          title={<span data-testid="daemon-inspector-title">{label}</span>}
          metadata={
            daemon ? (
              <Badge
                intent={daemonStatusIntent(daemon.status)}
                dot
                testId="daemon-inspector-status"
              >
                {daemonStatusLabel(daemon.status)}
              </Badge>
            ) : (
              <span>Daemon details</span>
            )
          }
          controls={
            <>
              {daemon && (
                <IconButton
                  onClick={() => setConfirmation("unregister")}
                  ariaLabel="Delete daemon"
                  title="Delete this daemon"
                  testId="daemon-inspector-delete-button"
                  disabled={actionBusy || terminal}
                >
                  <TrashIcon />
                </IconButton>
              )}
              <IconButton
                onClick={onClose}
                ariaLabel="Close daemon inspector"
                testId="daemon-inspector-close"
              >
                <CloseIcon />
              </IconButton>
            </>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div
              className="flex justify-center py-10"
              role="status"
              aria-label="Loading daemon details"
              data-testid="daemon-inspector-loading"
            >
              <Spinner />
            </div>
          ) : error && !daemon ? (
            <div
              className="rounded-[var(--radius-md)] border border-[var(--color-err)]/40 bg-[var(--color-err-wash)] p-4 text-sm text-[var(--color-err)]"
              role="alert"
              data-testid="daemon-inspector-error"
            >
              {error}
            </div>
          ) : !daemon ? (
            <div data-testid="daemon-inspector-not-found">
              <EmptyState
                title="Daemon not found"
                description={
                  errorKind === "not_found"
                    ? "This daemon is no longer available to this account. Refresh the fleet to reconcile the selection."
                    : (error ??
                      "This daemon is no longer available in the current account.")
                }
              />
            </div>
          ) : (
            <div className="space-y-5" data-testid="daemon-inspector-content">
              {daemon.status === "pending" && (
                <p
                  className="rounded-[var(--radius-md)] border border-[var(--color-warn)]/35 bg-[var(--color-warn-wash)] p-3 text-xs leading-relaxed text-[var(--color-warn)]"
                  role="status"
                  data-testid="daemon-inspector-pending"
                >
                  This daemon is pending enrollment. Heartbeat and capability
                  telemetry are not available yet.
                </p>
              )}
              <section aria-labelledby="daemon-identity-heading">
                <h2
                  id="daemon-identity-heading"
                  className="mb-2 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--color-fg-mute)]"
                >
                  Identity
                </h2>
                <dl className="border-t border-[var(--color-line)]">
                  <DetailRow label="ID" value={daemon.id} />
                  <DetailEditorRow label="Name">
                    <div data-testid="daemon-inspector-name-editor">
                      <InlineEditField
                        value={daemon.name ?? ""}
                        placeholder="Unnamed"
                        compact
                        allowEmpty
                        disabled={actionBusy}
                        validate={(value) => validateDaemonName(value)}
                        onSave={async (value) => {
                          const renamed = await onRename(
                            daemon.id,
                            daemonNameUpdate(value)
                          );
                          if (!renamed) {
                            throw new Error(
                              "The daemon name was not saved on the server."
                            );
                          }
                        }}
                      />
                    </div>
                  </DetailEditorRow>
                  <DetailRow
                    label="Host"
                    value={daemonFieldValue(daemon, "host") ?? "Unavailable"}
                  />
                  <DetailRow
                    label="Operating system"
                    value={daemonFieldValue(daemon, "os") ?? "Unavailable"}
                  />
                  <DetailRow
                    label="Architecture"
                    value={
                      daemonFieldValue(daemon, "architecture") ?? "Unavailable"
                    }
                  />
                  <DetailRow
                    label="Harness"
                    value={daemonFieldValue(daemon, "harness") ?? "Unavailable"}
                  />
                </dl>
              </section>
              <section aria-labelledby="daemon-readiness-heading">
                <h2
                  id="daemon-readiness-heading"
                  className="mb-2 font-mono text-2xs uppercase tracking-[0.12em] text-[var(--color-fg-mute)]"
                >
                  Readiness
                </h2>
                <dl className="border-t border-[var(--color-line)]">
                  <DetailRow label="Heartbeat age" value="Unavailable" />
                  <DetailRow label="Binary version" value="Unavailable" />
                  <DetailRow label="Capability readiness" value="Unavailable" />
                  <DetailRow
                    label="Enrolled"
                    value={formatDaemonTimestamp(daemon.enrolled_at)}
                  />
                  <DetailRow
                    label="Record updated"
                    value={formatDaemonTimestamp(daemon.updated_at)}
                  />
                </dl>
                <p className="mt-3 text-xs leading-relaxed text-[var(--color-fg-mute)]">
                  Fleet telemetry is pending its backend publication. These
                  values are not inferred from shell connectivity or local
                  installation state.
                </p>
              </section>
              {lifecycleAction && actionError && (
                <DaemonLifecycleStatus
                  action={lifecycleAction}
                  phase="error"
                  error={actionError}
                  errorKind={actionErrorKind}
                />
              )}
              {revoked && (
                <p
                  className="rounded-[var(--radius-md)] border border-[var(--color-warn)]/35 bg-[var(--color-warn-wash)] p-3 text-xs leading-relaxed text-[var(--color-warn)]"
                  role="status"
                  data-testid="daemon-inspector-reenrollment-status"
                >
                  Existing credentials are no longer valid. Re-enrollment
                  eligibility is controlled by the server and is not inferred by
                  this client.
                </p>
              )}
            </div>
          )}
        </div>
        {daemon && (
          <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--color-line)] px-4 py-3">
            {lifecycleAction &&
              !actionError &&
              (isRenaming || isUnregistering) && (
                <DaemonLifecycleStatus
                  action={lifecycleAction}
                  phase="submitting"
                />
              )}
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={isReissuing}
                disabled={actionBusy || revoked || terminal}
                onClick={() => onReissue(daemon.id)}
                data-testid="daemon-inspector-reissue"
              >
                Re-issue token
              </Button>
            </div>
          </div>
        )}
        {actionError && !lifecycleAction && (
          <p
            className="shrink-0 border-t border-[var(--color-line)] px-4 py-2 text-xs text-[var(--color-err)]"
            role="alert"
            data-testid="daemon-inspector-action-error"
          >
            {actionError}
          </p>
        )}
      </div>
      {daemon && confirmation && (
        <DaemonLifecycleConfirmation
          open
          action={confirmation}
          daemon={daemon}
          isSubmitting={isUnregistering}
          error={actionError}
          errorKind={actionErrorKind}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmLifecycleAction}
        />
      )}
    </FloatingDetailPanel>
  );
}
