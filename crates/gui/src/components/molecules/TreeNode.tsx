import type { ReactNode } from "react";

interface TreeNodeProps {
  /** Indent depth (0 = root). 16px per level. */
  depth?: number;
  /** True if the node has children. Controls the chevron. */
  hasChildren?: boolean;
  expanded?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  onSelect?: () => void;
  /** Optional icon rendered between chevron and label. */
  icon?: ReactNode;
  /** Render subtle vertical guides through the row's indentation slots. */
  showGuides?: boolean;
  /** Right-aligned slot for status / metadata. */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Makes the row focusable; the tree controller / consumer owns keyboard. */
  tabIndex?: number;
  /** Keyboard handler for the row (e.g. Enter/Space to select). */
  onKeyDown?: (event: React.KeyboardEvent) => void;
  /** Optional test id forwarded to the row element. */
  testId?: string;
  /**
   * Two-line rows: let the row grow to fit a title + metadata line instead of
   * the dense single-line `h-8`. The chevron and icon align to the top so they
   * track the title line.
   */
  multiline?: boolean;
}

/**
 * One row of a hierarchical tree. Chevron toggles without selecting; row body
 * selects without toggling. Keyboard: handled by the parent tree controller.
 */
export function TreeNode({
  depth = 0,
  hasChildren,
  expanded,
  selected,
  onToggle,
  onSelect,
  icon,
  showGuides,
  right,
  children,
  className,
  tabIndex,
  onKeyDown,
  testId,
  multiline,
}: TreeNodeProps) {
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected || undefined}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      data-testid={testId}
      data-selected={selected || undefined}
      className={[
        "group relative flex cursor-pointer gap-1.5 pr-2 text-sm",
        multiline ? "min-h-[3.25rem] items-start py-2" : "h-8 items-center",
        "transition-[background-color] duration-[var(--t-fast)]",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]",
        // Selected rows: a solid accent bar pinned to the left edge plus the
        // shared neutral selection surface. The bar is an inset pseudo-
        // replacement so it never shifts content the way a left border would.
        selected
          ? "bg-[var(--color-selection)] before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-[var(--color-accent)] before:content-['']"
          : "hover:bg-[var(--color-bg-1)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      {showGuides && depth > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0"
          data-testid="tree-indent-guides"
        >
          {Array.from({ length: depth }, (_, guideIndex) => (
            <span
              key={guideIndex}
              className="absolute inset-y-0 w-px bg-[var(--color-line)] opacity-70"
              style={{ left: `${20 + guideIndex * 16}px` }}
            />
          ))}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
        aria-label={expanded ? "Collapse" : "Expand"}
        className={[
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-xs)]",
          multiline ? "mt-px" : "",
          hasChildren
            ? "text-[var(--color-fg-soft)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
            : "invisible",
        ].join(" ")}
      >
        <span
          className={[
            "inline-block text-2xl leading-none transition-transform duration-[var(--t-fast)]",
            expanded ? "rotate-90" : "",
          ].join(" ")}
          aria-hidden
        >
          ▸
        </span>
      </button>
      {icon && (
        <span
          className={[
            "shrink-0 text-[var(--color-fg-mute)]",
            // Match the chevron's top offset so the leading glyph and the
            // chevron sit on the same line as the title in multiline rows.
            multiline ? "mt-px" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">
        {children}
      </span>
      {right && (
        <span
          className={[
            "shrink-0 font-mono text-eyebrow text-[var(--color-fg-mute)]",
            multiline ? "mt-0.5" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {right}
        </span>
      )}
    </div>
  );
}
