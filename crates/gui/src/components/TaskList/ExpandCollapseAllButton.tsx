interface ExpandCollapseAllButtonProps {
  allExpanded: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function ExpandCollapseAllButton({
  allExpanded,
  onToggle,
  disabled,
}: ExpandCollapseAllButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg-2/50 px-2 text-xs text-fg-mute transition-all hover:text-fg focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-40"
      aria-label={allExpanded ? "Collapse all" : "Expand all"}
      title={allExpanded ? "Collapse all" : "Expand all"}
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        {allExpanded ? (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M5 15l7-7 7 7"
          />
        ) : (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M19 9l-7 7-7-7"
          />
        )}
      </svg>
      {allExpanded ? "Collapse all" : "Expand all"}
    </button>
  );
}
