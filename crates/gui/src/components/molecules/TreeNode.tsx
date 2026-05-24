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
  /** Right-aligned slot for status / metadata. */
  right?: ReactNode;
  children: ReactNode;
  className?: string;
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
  right,
  children,
  className,
}: TreeNodeProps) {
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected || undefined}
      onClick={onSelect}
      className={[
        "group flex h-8 cursor-pointer items-center gap-1.5 pr-2 text-sm",
        "transition-[background-color] duration-[var(--t-fast)]",
        selected
          ? "bg-[var(--color-accent-wash)] border-l-2 border-[var(--color-accent)]"
          : "border-l-2 border-transparent hover:bg-[var(--color-bg-1)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ paddingLeft: `${8 + depth * 16}px` }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
        aria-label={expanded ? "Collapse" : "Expand"}
        className={[
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-xs)]",
          hasChildren
            ? "text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-fg)]"
            : "invisible",
        ].join(" ")}
      >
        <span
          className={[
            "inline-block text-[10px] transition-transform duration-[var(--t-fast)]",
            expanded ? "rotate-90" : "",
          ].join(" ")}
          aria-hidden
        >
          ▸
        </span>
      </button>
      {icon && <span className="shrink-0 text-[var(--color-fg-mute)]">{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">
        {children}
      </span>
      {right && (
        <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-mute)]">
          {right}
        </span>
      )}
    </div>
  );
}
