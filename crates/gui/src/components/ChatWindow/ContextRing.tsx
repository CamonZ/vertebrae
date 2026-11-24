import { useEffect, useId, useRef, useState } from "react";
import { Tooltip } from "../atoms/Tooltip";
import { formatTokenCount } from "../../utils/modelContextWindow";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface ContextRingProps {
  /** Share of the context window the current request uses, 0–100. */
  pct: number;
  /** Severity colour token for the arc (ok · warn · err). */
  color: string;
  usage: { used: number; max: number };
  model?: string | null;
  threadTotalTokens?: number;
}

/**
 * Context utilization as a small ring beside Send: a hover summary, and a
 * popover with the full numbers (context, model, tokens, thread).
 */
export function ContextRing({
  pct,
  color,
  usage,
  model,
  threadTotalTokens,
}: ContextRingProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const modelLabel = model ? model.replace(/^claude-/i, "") : null;
  // Near-empty usage is a static track with a centre dot: a sliver arc at the
  // top of a ring reads as a loading spinner.
  const empty = pct < 1;
  const summary = `Context ${pct}% · ${formatTokenCount(usage.used)} of ${formatTokenCount(usage.max)} tokens`;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="hc-ctx-ring" ref={rootRef}>
      {/* The tooltip stays mounted (toggling `disabled` remounts the trigger
          and drops focus) and sits to the left, clear of the popover above. */}
      <Tooltip label={summary} placement="left">
        <button
          ref={triggerRef}
          type="button"
          className="hc-ctx-ring-trigger"
          aria-label={summary}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          data-testid="chat-context-ring"
          onClick={() => setOpen((value) => !value)}
        >
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            data-empty={empty ? "" : undefined}
          >
            <circle className="hc-ctx-ring-track" cx="8" cy="8" r={RADIUS} />
            {empty ? (
              <circle
                className="hc-ctx-ring-dot"
                data-testid="chat-context-dot"
                cx="8"
                cy="8"
                r="1.5"
              />
            ) : (
              <circle
                className="hc-ctx-ring-fill"
                data-testid="chat-context-fill"
                cx="8"
                cy="8"
                r={RADIUS}
                style={{
                  stroke: color,
                  strokeDasharray: CIRCUMFERENCE,
                  strokeDashoffset: CIRCUMFERENCE * (1 - pct / 100),
                }}
              />
            )}
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div
          id={popoverId}
          className="hc-ctx-pop"
          role="dialog"
          aria-label="Context usage"
          data-testid="chat-context-popover"
        >
          <dl>
            <dt>Context</dt>
            <dd>{pct}%</dd>
            {modelLabel && (
              <>
                <dt>Model</dt>
                <dd>{modelLabel}</dd>
              </>
            )}
            <dt>Request</dt>
            <dd>
              {usage.used.toLocaleString()} / {usage.max.toLocaleString()}
            </dd>
            {threadTotalTokens !== undefined && (
              <>
                <dt>Thread</dt>
                <dd>{threadTotalTokens.toLocaleString()}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}
