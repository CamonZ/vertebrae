import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface PanelProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Initial width in px; user can drag to resize within [minWidth, maxWidth]. */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Optional pop-out detach action — rendered next to the close button. */
  onDetach?: () => void;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Persistent right-edge slide-in panel. Resizable from the left edge.
 * Slides over (not pushes) the main content per the Hearth spec.
 */
export function Panel({
  open,
  onClose,
  title,
  width = 360,
  minWidth = 280,
  maxWidth = 560,
  onDetach,
  footer,
  children,
  className,
}: PanelProps) {
  const [size, setSize] = useState(width);
  const dragStart = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragStart.current) return;
      const delta = dragStart.current.x - e.clientX;
      const next = Math.min(
        maxWidth,
        Math.max(minWidth, dragStart.current.w + delta),
      );
      setSize(next);
    },
    [minWidth, maxWidth],
  );

  const onMouseUp = useCallback(() => {
    dragStart.current = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }, [onMouseMove]);

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    dragStart.current = { x: e.clientX, w: size };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  if (!open) return null;

  return (
    <aside
      role="complementary"
      aria-label={typeof title === "string" ? title : "Detail panel"}
      style={{ width: size }}
      className={[
        "fixed right-0 top-0 z-40 flex h-full flex-col",
        "bg-[var(--color-bg-1)] border-l border-[var(--color-line)] shadow-[var(--shadow-2)]",
        "transition-transform duration-[var(--t-base)] ease-[var(--ease-default)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onMouseDown={handleResizeStart}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-[var(--color-accent)]"
      />
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-4 py-3">
        <div className="min-w-0 flex-1 truncate font-serif text-lg text-[var(--color-fg)]">
          {title}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onDetach && (
            <button
              type="button"
              onClick={onDetach}
              aria-label="Detach to window"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
            >
              ⧉
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-fg-mute)] hover:bg-[var(--color-bg-3)] hover:text-[var(--color-fg)]"
          >
            ×
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto">{children}</div>
      {footer && (
        <footer className="border-t border-[var(--color-line)] px-4 py-3">
          {footer}
        </footer>
      )}
    </aside>
  );
}
