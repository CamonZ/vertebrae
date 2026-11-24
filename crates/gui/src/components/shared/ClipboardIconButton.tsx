import { useEffect, useState, type ReactNode } from "react";
import { Tooltip, type TooltipPlacement } from "../atoms/Tooltip";
import { CopyIcon } from "./EntityId";

const copyFeedback = {
  idle: "",
  copied: "Copied",
  failed: "Could not copy",
};

export function ClipboardIconButton({
  text,
  label,
  className,
  wrapperClassName = "",
  iconSize = "h-4 w-4",
  tooltipPlacement = "left",
}: {
  text: string;
  label: string;
  className: string;
  wrapperClassName?: string;
  iconSize?: string;
  tooltipPlacement?: TooltipPlacement;
}): ReactNode {
  const [status, setStatus] = useState<keyof typeof copyFeedback>("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timeout = window.setTimeout(() => setStatus("idle"), 2000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  const copy = async () => {
    setStatus("idle");
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <span
      data-transcript-skip
      className={`relative inline-flex shrink-0 ${wrapperClassName}`}
    >
      <span className="sr-only" role="status">
        {copyFeedback[status]}
      </span>
      <Tooltip
        label={status === "failed" ? "Could not copy. Try again." : label}
        placement={tooltipPlacement}
      >
        <button
          type="button"
          data-focus-halo
          data-copy-status={status}
          aria-label={label}
          className={className}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
            }
          }}
          onClick={(event) => {
            event.stopPropagation();
            void copy();
          }}
        >
          {status === "idle" ? (
            <CopyIcon className={iconSize} />
          ) : (
            <svg
              className={`${iconSize} ${status === "copied" ? "text-[var(--ok)]" : "text-[var(--err)]"}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {status === "copied" ? (
                <path d="m5 12 4 4L19 6" />
              ) : (
                <>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v4m0 4h.01" />
                </>
              )}
            </svg>
          )}
        </button>
      </Tooltip>
    </span>
  );
}
