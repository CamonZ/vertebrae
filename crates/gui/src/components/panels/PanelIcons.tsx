/**
 * Shared detail-panel glyphs. One source of truth for the close / run / stop
 * icons so the task, step, workflow detail panels and the run console all draw
 * the exact same marks.
 */

/** Close (✕) — used in every panel header's close button. */
export function CloseIcon() {
  return (
    <svg
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

/** Filled play triangle for the Run action. */
export function PlayIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

/** Filled square for the Stop action. */
export function StopIcon() {
  return (
    <svg
      className="h-3 w-3"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  );
}
