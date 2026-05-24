import { useState, type ReactNode } from "react";
import { Spinner } from "../Spinner";

export type ToolCallState = "pending" | "success" | "error";

interface ToolCallBlockProps {
  toolName: string;
  /** Short summary line shown when collapsed (e.g., "src/main.rs"). */
  summary?: ReactNode;
  state?: ToolCallState;
  /** Pre-formatted input arguments shown when expanded. */
  input?: ReactNode;
  /** Pre-formatted result body shown when expanded. */
  result?: ReactNode;
  defaultOpen?: boolean;
}

const stateBorder: Record<ToolCallState, string> = {
  pending: "border-l-[var(--color-info)]",
  success: "border-l-[var(--color-ok)]",
  error: "border-l-[var(--color-err)]",
};

/**
 * Expandable block inside an assistant message showing a tool call + result.
 * Collapsed by default; output scrolls within a fixed body height.
 */
export function ToolCallBlock({
  toolName,
  summary,
  state = "success",
  input,
  result,
  defaultOpen = false,
}: ToolCallBlockProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className={[
        "my-2 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-line)] border-l-2",
        stateBorder[state],
        "bg-[var(--color-bg-1)]",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-2)]"
      >
        <span
          className={[
            "inline-block transition-transform duration-[var(--t-fast)]",
            open ? "rotate-90" : "",
          ].join(" ")}
          aria-hidden
        >
          ▸
        </span>
        {state === "pending" && <Spinner className="h-3 w-3" />}
        <span className="font-medium text-[var(--color-fg)]">{toolName}</span>
        {summary && (
          <span className="truncate text-[var(--color-fg-mute)]">{summary}</span>
        )}
      </button>
      {open && (
        <div className="grid gap-2 border-t border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2">
          {input !== undefined && (
            <pre className="max-h-40 overflow-auto rounded-[var(--radius-xs)] bg-[var(--color-bg-2)] p-2 font-mono text-[11px] text-[var(--color-fg-soft)]">
              {input}
            </pre>
          )}
          {result !== undefined && (
            <pre className="max-h-[200px] overflow-auto rounded-[var(--radius-xs)] bg-[var(--color-bg-2)] p-2 font-mono text-[11px] text-[var(--color-fg)]">
              {result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
