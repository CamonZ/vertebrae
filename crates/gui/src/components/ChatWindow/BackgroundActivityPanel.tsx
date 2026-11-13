import { useEffect, useState, type ReactNode } from "react";
import { RunChip } from "../shared/HearthPrimitives";
import { formatElapsed } from "./backgroundActivity";
import {
  activeBackgroundWorkCount,
  backgroundWorkRows,
  type BackgroundWorkKind,
  type BackgroundWorkRecord,
  type BackgroundWorkState,
} from "../../stores/backgroundWork";

const KIND_LABEL: Record<BackgroundWorkKind, string> = {
  command: "Command",
  other: "Task",
};

function elapsedLabel(
  record: BackgroundWorkRecord,
  nowMs: number
): string | null {
  // Unconfirmed work may have stopped long ago, so its clock is not shown.
  if (!record.fresh || !record.startedAt) return null;

  const started = Date.parse(record.startedAt);
  return Number.isNaN(started) ? null : formatElapsed(nowMs - started);
}

function backgroundSummary(work: BackgroundWorkState | null | undefined) {
  const active = activeBackgroundWorkCount(work);
  const unconfirmed = backgroundWorkRows(work).length - active;

  return [
    active > 0
      ? `${active} background ${active === 1 ? "task" : "tasks"} running`
      : null,
    unconfirmed > 0 ? `${unconfirmed} unconfirmed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

interface BackgroundActivityPanelProps {
  work: BackgroundWorkState | null | undefined;
  onClose?: () => void;
  now?: () => number;
}

export function BackgroundActivityPanel({
  work,
  onClose,
  now = Date.now,
}: BackgroundActivityPanelProps): ReactNode {
  const rows = backgroundWorkRows(work);
  const active = activeBackgroundWorkCount(work);
  const ticking = rows.some((row) => row.fresh && row.startedAt !== null);
  const [nowMs, setNowMs] = useState(now);

  useEffect(() => {
    if (!ticking) return;

    setNowMs(now());
    const timer = window.setInterval(() => setNowMs(now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking, now]);

  return (
    <section
      data-testid="background-activity"
      data-active-count={active}
      aria-label="Background tasks"
      className="flex min-h-0 flex-col text-xs text-[var(--color-fg-soft)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <span className="font-medium text-[var(--color-fg)]">
          Background tasks
        </span>
        {rows.length > 0 && (
          <RunChip
            force
            small
            state={active > 0 ? "running" : "stopped"}
            label={active > 0 ? "Running" : "Unconfirmed"}
          />
        )}
        <span className="min-w-0 flex-1 truncate">
          {backgroundSummary(work)}
        </span>
        {onClose && (
          <button
            type="button"
            aria-label="Close Background tasks panel"
            onClick={onClose}
            className="shrink-0 px-1 hover:text-[var(--color-fg)]"
          >
            ✕
          </button>
        )}
      </header>

      {rows.length === 0 ? (
        <p className="px-3 py-3">No background tasks are running.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {rows.map((row) => (
            <BackgroundActivityRow
              key={row.workId}
              row={row}
              elapsed={elapsedLabel(row, nowMs)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function BackgroundActivityRow({
  row,
  elapsed,
}: {
  row: BackgroundWorkRecord;
  elapsed: string | null;
}) {
  return (
    <li
      data-testid="background-activity-row"
      data-work-id={row.workId}
      data-fresh={row.fresh}
      className="flex items-start gap-2 px-3 py-1.5"
    >
      <span className="w-16 shrink-0 font-mono text-[var(--color-fg-faint)]">
        {KIND_LABEL[row.kind]}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block break-words text-[var(--color-fg)]">
          {row.description ?? row.workId}
        </span>
        {row.fresh ? (
          row.progress && (
            <span
              data-testid="background-activity-progress"
              className="block break-words"
            >
              {row.progress}
            </span>
          )
        ) : (
          <span className="block">
            Not confirmed running · connection to the provider was lost
          </span>
        )}
      </span>

      {elapsed && (
        <span
          data-testid="background-activity-elapsed"
          className="shrink-0 font-mono tabular-nums"
        >
          {elapsed}
        </span>
      )}
    </li>
  );
}
