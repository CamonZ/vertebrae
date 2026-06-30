interface SessionDeleteButtonProps {
  /** Disable while a delete request is in flight for this session. */
  disabled?: boolean;
  /** Fires with the session label for the title/aria-label. */
  label: string;
  onClick: () => void;
  /** Mark the button as a delete control for keyboard-nav guards. */
  dataMiniDelete?: boolean;
}

/**
 * Shared trash-icon delete button for local chat sessions. Both the mini
 * history panel and the history drawer render the same control; this keeps
 * the icon, classes, and a11y labels in one place.
 */
export function SessionDeleteButton({
  disabled,
  label,
  onClick,
  dataMiniDelete,
}: SessionDeleteButtonProps) {
  return (
    <button
      type="button"
      className="hc-ctrl danger shrink-0"
      data-mini-delete={dataMiniDelete || undefined}
      disabled={disabled}
      onClick={onClick}
      title={`Delete local chat ${label}`}
      aria-label={`Delete local chat ${label}`}
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
        />
      </svg>
    </button>
  );
}
