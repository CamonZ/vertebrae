import type { ReactNode } from "react";
import type { TaskLevel } from "../../bindings";
import { formatTokenCount, type ExecutionRollups } from "../../utils";
import { formatDurationMs } from "../Operations/formatDuration";

/** Temporarily hide the pop-out/detach control on side panels. Flip back to
 * `true` to restore the Detach button (the onDetach plumbing is left intact). */
const DETACH_ENABLED = false;

interface TracesHeaderProps {
  taskId: string | null;
  title: string | null;
  level: TaskLevel | null;
  rollups: ExecutionRollups;
  /** Status of the active run, drives the hero status pill. */
  runState?: string | null;
  isLoading?: boolean;
  error?: string | null;
  onBack?: () => void;
  onDetach?: () => void;
}

/** Map a run status to a hero pill: label, accent colour and left-edge colour. */
function heroState(state: string | null | undefined): {
  label: string;
  color: string;
  edge: string;
} {
  switch (state) {
    case "waiting":
      return { label: "Waiting", color: "var(--color-warn)", edge: "var(--color-step-wait)" };
    case "executing":
    case "in_progress":
    case "running":
      return { label: "Running", color: "var(--color-accent)", edge: "var(--color-accent)" };
    case "completed":
      return { label: "Completed", color: "var(--color-ok)", edge: "var(--color-ok)" };
    case "failed":
      return { label: "Failed", color: "var(--color-err)", edge: "var(--color-err)" };
    case "stopped":
    case "stopping":
      return { label: "Stopped", color: "var(--color-fg-mute)", edge: "var(--color-line-strong)" };
    default:
      return {
        label: state ? state.replace(/_/g, " ") : "—",
        color: "var(--color-fg-mute)",
        edge: "var(--color-line-strong)",
      };
  }
}

export function TracesHeader({
  taskId,
  title,
  level,
  rollups,
  runState,
  isLoading,
  error,
  onBack,
  onDetach,
}: TracesHeaderProps): ReactNode {
  const hasTask = taskId != null;
  const displayTitle = hasTask ? (title ?? "Unknown task") : "Pick a task to explore traces";
  const displayLevel = level ?? "task";
  const hero = heroState(runState);

  return (
    <header
      data-testid="traces-header"
      data-task-id={taskId ?? ""}
      className="flex flex-col border-b border-[var(--color-line)] bg-[var(--color-bg-1)]"
    >
      <div className="flex h-12 items-center gap-3 px-6">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            data-testid="traces-back-button"
            className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-bg-2)] px-2 py-1 text-xs text-[var(--color-fg-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
            aria-label="Back"
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            <span>Back</span>
          </button>
        )}

        <nav
          aria-label="Breadcrumb"
          data-testid="traces-breadcrumb"
          className="flex items-center gap-1 text-xs text-[var(--color-fg-mute)]"
        >
          <span>Traces</span>
          {hasTask && (
            <>
              <span aria-hidden="true">/</span>
              <span
                data-testid="traces-breadcrumb-level"
                className="font-mono uppercase tracking-wider"
              >
                {displayLevel}
              </span>
            </>
          )}
        </nav>

        <h1
          data-testid="traces-title"
          className="truncate font-serif text-base font-normal italic text-[var(--color-fg)]"
        >
          {displayTitle}
        </h1>

        {DETACH_ENABLED && onDetach && (
          <button
            type="button"
            onClick={onDetach}
            data-testid="traces-detach-button"
            className="ml-auto flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-[var(--color-bg-2)] px-2 py-1 text-xs text-[var(--color-fg-soft)] transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
            aria-label="Detach traces into a separate window"
            title="Detach into separate window"
          >
            <svg
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14 5l7 7m0 0l-7 7m7-7H3"
              />
            </svg>
            <span>Detach</span>
          </button>
        )}
      </div>

      {hasTask && (
        <div
          data-testid="traces-hero"
          className="mx-6 mb-2 flex flex-wrap items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-3.5 py-2 font-mono text-xs text-[var(--color-fg-soft)]"
          style={{ borderLeft: `3px solid ${hero.edge}` }}
        >
          <span
            data-testid="traces-hero-state"
            className="font-semibold uppercase tracking-wider"
            style={{ color: hero.color }}
          >
            {hero.label}
          </span>
          <span className="text-[var(--color-fg-ghost)]">·</span>
          <span
            data-testid="traces-hero-runtime"
            className="font-medium text-[var(--color-accent)]"
          >
            {formatDurationMs(rollups.totalWallTimeMs)}
          </span>

          <span className="ml-auto flex items-center gap-1.5 text-[var(--color-fg-mute)]">
            <span data-testid="traces-hero-runs">
              <b className="font-semibold text-[var(--color-fg)]">{rollups.totalRuns}</b> runs
            </span>
            <span className="text-[var(--color-fg-ghost)]">·</span>
            <span data-testid="traces-hero-executions">
              <b className="font-semibold text-[var(--color-fg)]">{rollups.totalAttempts}</b>{" "}
              executions
            </span>
            <span className="text-[var(--color-fg-ghost)]">·</span>
            <span
              data-testid="traces-hero-tokens"
              title="raw input · cache hits · output"
            >
              <b className="font-semibold text-[var(--color-fg)]">
                {formatTokenCount(rollups.totalTokens)}
              </b>{" "}
              tokens
              <span className="ml-1 text-[var(--color-fg-ghost)]">
                (
                <span data-testid="traces-hero-tokens-raw">
                  {formatTokenCount(rollups.rawInputTokens)} raw
                </span>
                <span className="px-1">·</span>
                <span data-testid="traces-hero-tokens-cache">
                  {formatTokenCount(rollups.cacheReadTokens)} cache
                </span>
                <span className="px-1">·</span>
                <span data-testid="traces-hero-tokens-output">
                  {formatTokenCount(rollups.outputTokens)} out
                </span>
                )
              </span>
            </span>
          </span>

          {isLoading && (
            <span
              data-testid="traces-hero-loading"
              className="text-2xs italic text-[var(--color-fg-mute)]"
            >
              Loading…
            </span>
          )}
          {error && !isLoading && (
            <span
              data-testid="traces-hero-error"
              className="rounded-[var(--radius-sm)] border border-[var(--color-err)]/30 bg-[var(--color-err-wash)] px-2 py-0.5 text-2xs text-[var(--color-err)]"
            >
              {error}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
