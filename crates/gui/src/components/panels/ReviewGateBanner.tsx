import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "../atoms/Button";

interface ReviewGateBannerProps {
  /** Short headline (e.g., "Run 3 needs your review."). */
  title?: ReactNode;
  /** Supporting copy / link area (e.g., "View trace ›"). */
  description?: ReactNode;
  onAccept?: () => void;
  /** Called with the optional feedback string. */
  onReject?: (feedback: string) => void;
  acceptLabel?: string;
  rejectLabel?: string;
  /** Disable both actions while the gate is mid-submit. */
  busy?: boolean;
  className?: string;
}

/**
 * Persistent banner shown at the top of a panel or trace view when a run
 * is awaiting human review. The reject button opens a feedback textarea
 * before confirming so the agent receives a clear reason for the rejection.
 */
export function ReviewGateBanner({
  title = "Awaiting your review",
  description,
  onAccept,
  onReject,
  acceptLabel = "Accept",
  rejectLabel = "Reject",
  busy,
  className,
}: ReviewGateBannerProps) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  function handleReject() {
    if (!feedbackOpen) {
      setFeedbackOpen(true);
      return;
    }
    onReject?.(feedback);
  }

  return (
    <div
      role="region"
      aria-label="Review gate"
      className={[
        "flex flex-col gap-3 border-y px-4 py-3",
        "border-[color-mix(in_oklch,var(--color-warn)_30%,transparent)]",
        "bg-[var(--color-warn-wash)] text-[var(--color-fg)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="text-[var(--color-warn)] text-base"
            >
              👁
            </span>
            <span className="font-serif text-base text-[var(--color-fg)]">
              {title}
            </span>
          </div>
          {description && (
            <div className="mt-1 text-sm text-[var(--color-fg-soft)]">
              {description}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleReject}
            disabled={busy}
          >
            {rejectLabel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onAccept}
            disabled={busy}
          >
            {acceptLabel}
          </Button>
        </div>
      </div>
      {feedbackOpen && (
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Optional feedback for the agent…"
          rows={2}
          className={[
            "w-full resize-none rounded-[var(--radius-md)] border px-2 py-1.5",
            "border-[var(--color-line-strong)] bg-[var(--color-bg-1)]",
            "font-sans text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)]",
            "focus:outline-none focus:border-[var(--color-accent)]",
          ].join(" ")}
        />
      )}
    </div>
  );
}
