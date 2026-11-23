import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { RunChip } from "../shared/HearthPrimitives";
import { formatElapsed } from "./backgroundActivity";
import { CHAT_AREA_ATTRIBUTE, enterFirstRow } from "./chatAreas";
import {
  BACKGROUND_LIST_HINTS,
  DIFF_COPY_SHORTCUT,
  matchesExactChatShortcut,
} from "./chatShortcuts";
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

const ROW_SELECTOR = '[data-testid="background-activity-row"]';

/** What ⌘C copies: the command (or task description) as launched. */
function commandText(record: BackgroundWorkRecord): string | null {
  return record.description ?? null;
}

/** The progress and error a row can expand to show. */
function hasOutput(record: BackgroundWorkRecord): boolean {
  return !!(record.progress || record.error);
}

/**
 * The list keys (decision 49d12c2c §4.1): ↑/↓ between tasks, ↵ shows or
 * hides a task's output, ⌘C copies its command.
 */
function onListKeyDown(
  event: KeyboardEvent<HTMLElement>,
  rows: readonly BackgroundWorkRecord[],
  toggle: (workId: string) => void
) {
  if (event.defaultPrevented || event.nativeEvent.isComposing) return;
  const section = event.currentTarget;
  const items = Array.from(section.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const target = event.target as HTMLElement;
  const at = items.indexOf(target);
  const plain =
    !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (plain && step && items.length > 0) {
    event.preventDefault();
    const next =
      at < 0
        ? step === 1
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, at + step));
    items[next]?.focus();
    return;
  }
  const record =
    at < 0 ? null : rows.find((row) => row.workId === target.dataset.workId);
  if (!record) return;
  const command = commandText(record);
  if (plain && event.key === "Enter") {
    event.preventDefault();
    if (hasOutput(record)) toggle(record.workId);
  } else if (command && matchesExactChatShortcut(event, DIFF_COPY_SHORTCUT)) {
    event.preventDefault();
    navigator.clipboard.writeText(command).catch((error: unknown) => {
      console.error("Failed to copy background command", error);
    });
  }
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
  // Tasks showing their full output (progress and error).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const toggleOutput = (workId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(workId)) next.add(workId);
      return next;
    });

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
      tabIndex={-1}
      {...{ [CHAT_AREA_ATTRIBUTE]: "background" }}
      onKeyDown={(event) => onListKeyDown(event, rows, toggleOutput)}
      onFocus={(event) => enterFirstRow(event, ROW_SELECTOR)}
      className="flex min-h-0 flex-1 flex-col text-xs text-[var(--color-fg-soft)]"
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
              expanded={expanded.has(row.workId)}
              onToggle={() => toggleOutput(row.workId)}
            />
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <footer
          className="side-section-hints"
          aria-label="Background tasks keys"
        >
          {BACKGROUND_LIST_HINTS.map(({ keys, label }) => (
            <span key={label}>
              <kbd>{keys.join("")}</kbd> {label}
            </span>
          ))}
        </footer>
      )}
    </section>
  );
}

function BackgroundActivityRow({
  row,
  elapsed,
  expanded,
  onToggle,
}: {
  row: BackgroundWorkRecord;
  elapsed: string | null;
  expanded: boolean;
  onToggle(): void;
}) {
  const output = hasOutput(row);
  const command = commandText(row) !== null;
  const keys = [
    output && {
      aria: "Enter",
      hint: `${expanded ? "Hide" : "Show"} output (↵)`,
    },
    command && { aria: "Meta+C", hint: "copy command (⌘C)" },
  ].filter((key) => !!key);
  return (
    <li>
      <button
        type="button"
        data-testid="background-activity-row"
        data-work-id={row.workId}
        data-fresh={row.fresh}
        aria-expanded={output ? expanded : undefined}
        aria-keyshortcuts={keys.map((key) => key.aria).join(" ") || undefined}
        title={keys.map((key) => key.hint).join(" · ") || undefined}
        onClick={output ? onToggle : undefined}
        className="background-activity-row flex w-full items-start gap-2 px-3 py-1.5 text-left"
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
                className={`block break-words${expanded ? " whitespace-pre-wrap" : " line-clamp-2"}`}
              >
                {row.progress}
              </span>
            )
          ) : (
            <span className="block">
              Not confirmed running · connection to the provider was lost
            </span>
          )}
          {expanded && row.error && (
            <span className="block whitespace-pre-wrap break-words text-[var(--color-err)]">
              {row.error}
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
      </button>
    </li>
  );
}
