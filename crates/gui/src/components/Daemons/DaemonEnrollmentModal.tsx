import { useEffect, useMemo, useState } from "react";
import { commands, type DaemonBootstrap } from "../../bindings";
import { Button } from "../atoms/Button";
import { Input } from "../atoms/Input";
import { Modal } from "../molecules/Modal";
import { useDaemonMutations } from "../../hooks/useDaemonMutations";
import { unwrapCommand } from "../../query";

interface DaemonEnrollmentModalProps {
  open: boolean;
  onClose: () => void;
  initialBootstrap?: DaemonBootstrap | null;
}

type EnrollmentStep = "name" | "enroll";
type CopyTarget = "id" | "token" | "command";

function maskToken(token: string): string {
  return token.replace(/\S/g, "•");
}

function StepLabel({ step }: { step: EnrollmentStep }) {
  return (
    <p className="font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)]">
      <span className={step === "name" ? "text-[var(--color-accent)]" : ""}>
        1 · Name
      </span>
      <span className="mx-2 text-[var(--color-fg-faint)]" aria-hidden>
        →
      </span>
      <span className={step === "enroll" ? "text-[var(--color-accent)]" : ""}>
        2 · Enroll
      </span>
    </p>
  );
}

function CopyButton({
  target,
  value,
  copied,
  onCopy,
}: {
  target: CopyTarget;
  value: string;
  copied: CopyTarget | null;
  onCopy: (target: CopyTarget, value: string) => void;
}) {
  return (
    <button
      type="button"
      className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-1 font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
      onClick={() => onCopy(target, value)}
    >
      {copied === target ? "Copied" : "Copy"}
    </button>
  );
}

export function DaemonEnrollmentModal({
  open,
  onClose,
  initialBootstrap = null,
}: DaemonEnrollmentModalProps) {
  const [step, setStep] = useState<EnrollmentStep>(
    initialBootstrap ? "enroll" : "name"
  );
  const [name, setName] = useState("");
  const [bootstrap, setBootstrap] = useState<DaemonBootstrap | null>(
    initialBootstrap
  );
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [serverEndpoint, setServerEndpoint] = useState<string | null>(null);
  const [serverEndpointError, setServerEndpointError] = useState<string | null>(
    null
  );
  const { createDaemon, isBusy, error } = useDaemonMutations();
  const isReissue = initialBootstrap !== null;

  useEffect(() => {
    if (!open) {
      setStep("name");
      setName("");
      setBootstrap(null);
      setTokenVisible(false);
      setCopied(null);
      setServerEndpoint(null);
      setServerEndpointError(null);
      return;
    }
    setStep(initialBootstrap ? "enroll" : "name");
    setBootstrap(initialBootstrap);
    setCopied(null);
    setTokenVisible(false);
  }, [initialBootstrap, open]);

  useEffect(() => {
    if (!open || step !== "enroll") return;
    let cancelled = false;
    setServerEndpointError(null);
    void unwrapCommand(commands.sacrumConfigStatus())
      .then((status) => {
        if (!cancelled) setServerEndpoint(status.url);
      })
      .catch((reason) => {
        if (!cancelled) {
          setServerEndpointError(
            reason instanceof Error
              ? reason.message
              : "The configured Sacrum endpoint could not be read."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, step]);

  const command = useMemo(() => {
    if (!bootstrap) return "";
    const endpoint = serverEndpoint ?? "<configured-sacrum-endpoint>";
    return `vtb-daemon enroll --endpoint '${endpoint}' --daemon-id '${bootstrap.daemon.id}' --token-stdin < /path/to/protected-bootstrap-token`;
  }, [bootstrap, serverEndpoint]);

  const handleCopy = async (target: CopyTarget, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setCopied(null);
    }
  };

  const handleCreate = async () => {
    const created = await createDaemon(name.trim() || null);
    if (!created) return;
    setBootstrap(created);
    setStep("enroll");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      hideClose
      variant="dialog"
      className="w-[520px] max-w-[calc(100vw-2rem)]"
    >
      {step === "name" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
          data-testid="daemon-enrollment-name-step"
        >
          <StepLabel step={step} />
          <h2 className="mt-2 font-serif text-2xl text-[var(--color-fg)]">
            Register a <em className="text-[var(--color-accent)]">daemon</em>
          </h2>
          <p className="mt-2 text-sm italic leading-relaxed text-[var(--color-fg-mute)]">
            Naming reserves an id now; the machine claims it later with a
            one-time token. Capabilities are read from the machine on first
            heartbeat, so there is nothing else to fill in.
          </p>

          <div className="mt-5 border-t border-[var(--color-line)] pt-4">
            <label
              htmlFor="daemon-enrollment-name"
              className="font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)]"
            >
              Name
            </label>
            <Input
              id="daemon-enrollment-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="rack-03"
              aria-label="Daemon name"
              data-testid="daemon-enrollment-name"
              className="mt-2"
              disabled={isBusy}
            />
            <p className="mt-1 text-xs text-[var(--color-fg-mute)]">
              How you will recognise this machine in run logs. Renameable later.
            </p>
            {error && (
              <p
                className="mt-3 text-xs text-[var(--color-err)]"
                role="alert"
                data-testid="daemon-enrollment-error"
              >
                {error}
              </p>
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2 border-t border-[var(--color-line)] pt-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={isBusy}
              data-testid="daemon-enrollment-create"
            >
              Register &amp; mint token
            </Button>
          </div>
        </form>
      ) : (
        <div data-testid="daemon-enrollment-token-step">
          <StepLabel step={step} />
          <h2 className="mt-2 font-serif text-2xl text-[var(--color-fg)]">
            {isReissue ? (
              <>
                Re-issue <em className="text-[var(--color-accent)]">token</em>
              </>
            ) : (
              <>
                Enroll the{" "}
                <em className="text-[var(--color-accent)]">machine</em>
              </>
            )}
          </h2>
          <p className="mt-2 text-sm italic leading-relaxed text-[var(--color-fg-mute)]">
            {isReissue
              ? "Run the new one-time enrollment command on the remote machine."
              : "The daemon is registered but has never checked in. Run this on the machine — the token is accepted once, then burned."}
          </p>

          {bootstrap && (
            <div className="mt-5 space-y-4 border-t border-[var(--color-line)] pt-4">
              <div>
                <p className="font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)]">
                  Daemon ID
                </p>
                <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] bg-[var(--color-bg)] px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-fg)]">
                    {bootstrap.daemon.id}
                  </code>
                  <CopyButton
                    target="id"
                    value={bootstrap.daemon.id}
                    copied={copied}
                    onCopy={handleCopy}
                  />
                </div>
              </div>

              <div>
                <p className="font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)]">
                  One-time enrollment token
                </p>
                <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] bg-[var(--color-bg)] px-3 py-2">
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-fg)]"
                    aria-label={
                      tokenVisible
                        ? "Enrollment token"
                        : "Hidden enrollment token"
                    }
                  >
                    {tokenVisible
                      ? bootstrap.enrollment_token
                      : maskToken(bootstrap.enrollment_token)}
                  </code>
                  <button
                    type="button"
                    className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-1 font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)] transition-colors hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
                    onClick={() => setTokenVisible((visible) => !visible)}
                  >
                    {tokenVisible ? "Hide" : "Reveal"}
                  </button>
                  <CopyButton
                    target="token"
                    value={bootstrap.enrollment_token}
                    copied={copied}
                    onCopy={handleCopy}
                  />
                </div>
                <p className="mt-2 text-xs text-[var(--color-warn)]">
                  ⚠ Shown once. Expires{" "}
                  {new Date(bootstrap.expires_at).toLocaleString()}. Re-issue
                  from the daemon&apos;s panel if it is lost.
                </p>
              </div>

              <div>
                <p className="font-mono text-eyebrow uppercase tracking-wider text-[var(--color-fg-mute)]">
                  Or paste this
                </p>
                <div className="mt-2 flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--color-line-strong)] bg-[var(--color-bg)] p-3">
                  <code className="min-w-0 flex-1 break-words font-mono text-xs leading-relaxed text-[var(--color-fg)]">
                    {command}
                  </code>
                  <CopyButton
                    target="command"
                    value={command}
                    copied={copied}
                    onCopy={handleCopy}
                  />
                </div>
                {serverEndpointError && (
                  <p
                    className="mt-2 text-xs text-[var(--color-warn)]"
                    role="status"
                  >
                    {serverEndpointError} Use the endpoint configured for this
                    account before running the command.
                  </p>
                )}
                <p className="mt-2 text-xs text-[var(--color-fg-mute)]">
                  Save the token to a protected file and pipe it to
                  <span className="mx-1 font-mono text-[var(--color-fg-soft)]">
                    --token-stdin
                  </span>
                  as shown.
                </p>
              </div>
            </div>
          )}

          <div className="mt-5 flex justify-end border-t border-[var(--color-line)] pt-3">
            <Button
              variant="primary"
              size="sm"
              onClick={onClose}
              data-testid="daemon-enrollment-done"
            >
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
