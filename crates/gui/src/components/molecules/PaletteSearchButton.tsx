import type { PaletteScope } from "../CommandPalette/paletteModel";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";

interface PaletteSearchButtonProps {
  /** Visible label, e.g. "Search tasks". */
  label: string;
  /** Scope the ⌘K palette opens with. */
  scope?: PaletteScope;
  /** Icon-only trigger for tight toolbars; the label becomes the tooltip. */
  compact?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * Stand-in for a page search box: opens the ⌘K palette pre-scoped, so there
 * is one search surface for tasks, chats, pages and actions.
 */
export function PaletteSearchButton({
  label,
  scope = "tasks",
  compact = false,
  className,
  "data-testid": testId,
}: PaletteSearchButtonProps) {
  const openPalette = useCommandPaletteStore((state) => state.openPalette);
  return (
    <button
      type="button"
      className={["palette-search-btn", compact ? "compact" : "", className]
        .filter(Boolean)
        .join(" ")}
      onClick={() => openPalette(scope)}
      aria-label={label}
      aria-keyshortcuts="Meta+K /"
      title={compact ? `${label} (⌘K)` : undefined}
      data-testid={testId}
    >
      <svg
        aria-hidden
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-3-3" strokeLinecap="round" />
      </svg>
      {!compact && (
        <>
          <span className="palette-search-label">{label}</span>
          <kbd aria-hidden className="palette-search-kbd">
            ⌘K
          </kbd>
        </>
      )}
    </button>
  );
}
