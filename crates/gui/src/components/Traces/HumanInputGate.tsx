import { useState, type ReactNode } from "react";
import { MarkdownContent } from "../shared/MarkdownContent";
import { Spinner } from "../Spinner";
import type { HumanInputGateContext } from "../../utils/humanInputGate";
import { DiagnosticId } from "../shared/EntityId";

interface HumanInputGateProps {
  context: HumanInputGateContext;
  stoppable?: boolean;
  isStopping?: boolean;
  onStop?: () => void;
  className?: string;
}

interface DisclosureProps {
  label: string;
  testIdBase: string;
  children: ReactNode;
}

function Disclosure({ label, testIdBase, children }: DisclosureProps): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        data-testid={`${testIdBase}-toggle`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-fg-mute)] hover:text-[var(--color-fg-soft)]"
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span>{label}</span>
      </button>
      {open && children}
    </div>
  );
}

function formatSchema(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

export function HumanInputGate({
  context,
  stoppable = false,
  isStopping = false,
  onStop,
  className,
}: HumanInputGateProps): ReactNode {
  const { run, execution, stepName, prompt, outputSchema } = context;

  const hasPrompt = !!prompt && prompt.trim().length > 0;
  const schemaJson = formatSchema(outputSchema);

  const containerClass = [
    "rounded-[var(--radius-lg)] border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 p-4 shadow-[var(--shadow-2)]",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      data-testid="human-input-gate"
      data-run-id={run.id}
      data-execution-id={execution?.id ?? ""}
      data-stoppable={stoppable ? "1" : "0"}
      className={containerClass}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <svg
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-info)]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--color-fg)]">
              Waiting on human input
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-fg-soft)]">
              {stepName ? (
                <>
                  Step{" "}
                  <span
                    data-testid="human-input-gate-step"
                    className="font-mono text-[var(--color-fg)]"
                  >
                    {stepName}
                  </span>{" "}
                  is parked until an operator resumes it.
                </>
              ) : (
                <>This run is parked until an operator resumes it.</>
              )}
            </p>
          </div>
        </div>
        {stoppable && onStop && (
          <button
            type="button"
            data-testid="human-input-gate-stop"
            onClick={onStop}
            disabled={isStopping}
            className="cursor-pointer flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-err)] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--color-err)]/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-err)] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Stop waiting run"
            title="Stop the orchestrator for this waiting run"
          >
            {isStopping ? (
              <Spinner />
            ) : (
              <svg
                className="h-3.5 w-3.5"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            )}
            <span>{isStopping ? "Stopping..." : "Stop"}</span>
          </button>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-2">
        <div>
          <dt className="font-mono uppercase tracking-wider text-[var(--color-fg-mute)]">
            Run
          </dt>
          <dd>
            <DiagnosticId
              id={run.id}
              kind="task run"
              className="text-[11px]"
              testId="human-input-gate-run-id"
            />
          </dd>
        </div>
        <div>
          <dt className="font-mono uppercase tracking-wider text-[var(--color-fg-mute)]">
            Execution
          </dt>
          <dd>
            <DiagnosticId
              id={execution?.id}
              kind="step execution"
              className="text-[11px]"
              testId="human-input-gate-execution-id"
              emptyValue="—"
            />
          </dd>
        </div>
      </dl>
      {(hasPrompt || schemaJson !== null) && (
        <div className="mt-3 space-y-2">
          {hasPrompt && (
            <Disclosure label="Prompt" testIdBase="human-input-gate-prompt">
              <div
                data-testid="human-input-gate-prompt"
                className="mt-1 max-h-96 overflow-auto rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
              >
                <MarkdownContent text={prompt as string} />
              </div>
            </Disclosure>
          )}
          {schemaJson !== null && (
            <Disclosure
              label="Output schema"
              testIdBase="human-input-gate-schema"
            >
              <pre
                data-testid="human-input-gate-schema"
                className="mt-1 max-h-96 overflow-auto rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[11px] text-[var(--color-fg)]"
              >
                {schemaJson}
              </pre>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  );
}
