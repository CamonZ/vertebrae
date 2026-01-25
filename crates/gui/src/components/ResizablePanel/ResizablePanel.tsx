import { useState, useCallback, useEffect, useRef } from "react";

interface ResizablePanelProps {
  children: React.ReactNode;
  /** Minimum width in pixels */
  minWidth?: number;
  /** Maximum width in pixels */
  maxWidth?: number;
  /** Default width in pixels */
  defaultWidth?: number;
  /** Storage key for persisting width (uses localStorage if provided) */
  storageKey?: string;
  /** CSS class for the glow edge color (e.g., "from-primary/0 via-primary/30 to-primary/0") */
  glowColor?: string;
  /** Additional className for the panel container */
  className?: string;
}

const DEFAULT_MIN_WIDTH = 280;
const DEFAULT_WIDTH = 384; // lg:w-96 = 24rem = 384px

/**
 * ResizablePanel provides a resizable container for side panels.
 * Includes a drag handle on the left edge and optional localStorage persistence.
 */
export function ResizablePanel({
  children,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth,
  defaultWidth = DEFAULT_WIDTH,
  storageKey,
  glowColor = "from-primary/0 via-primary/30 to-primary/0",
  className = "",
}: ResizablePanelProps) {
  // Initialize width from localStorage or default
  const [width, setWidth] = useState<number>(() => {
    if (storageKey && typeof window !== "undefined") {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (!isNaN(parsed) && parsed >= minWidth && (maxWidth === undefined || parsed <= maxWidth)) {
          return parsed;
        }
      }
    }
    return defaultWidth;
  });

  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Persist width to localStorage
  useEffect(() => {
    if (storageKey && typeof window !== "undefined") {
      localStorage.setItem(storageKey, String(width));
    }
  }, [width, storageKey]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing || !panelRef.current) return;

      // Calculate new width based on mouse position relative to right edge of viewport
      const viewportWidth = window.innerWidth;
      const newWidth = viewportWidth - e.clientX;

      // Clamp to min (and max if specified)
      let clampedWidth = Math.max(newWidth, minWidth);
      if (maxWidth !== undefined) {
        clampedWidth = Math.min(clampedWidth, maxWidth);
      }
      setWidth(clampedWidth);
    },
    [isResizing, minWidth, maxWidth]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Add/remove global mouse event listeners
  useEffect(() => {
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      // Prevent text selection while resizing
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  return (
    <div
      ref={panelRef}
      className={`relative flex h-full flex-col border-l border-border bg-bg-secondary ${className}`}
      style={{ width: `${width}px` }}
    >
      {/* Resize handle */}
      <div
        className={`absolute -left-1 top-0 bottom-0 w-2 cursor-ew-resize z-10 group ${
          isResizing ? "bg-primary/20" : ""
        }`}
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        onKeyDown={(e) => {
          // Allow keyboard resizing with arrow keys
          if (e.key === "ArrowLeft") {
            setWidth((w) => maxWidth !== undefined ? Math.min(w + 10, maxWidth) : w + 10);
          } else if (e.key === "ArrowRight") {
            setWidth((w) => Math.max(w - 10, minWidth));
          }
        }}
      >
        {/* Visual indicator on hover */}
        <div
          className={`absolute left-1 top-0 bottom-0 w-0.5 transition-colors ${
            isResizing
              ? "bg-primary"
              : "bg-transparent group-hover:bg-primary/50"
          }`}
        />
      </div>

      {/* Subtle glow edge */}
      <div
        className={`pointer-events-none absolute -left-px bottom-0 top-0 w-px bg-gradient-to-b ${glowColor}`}
      />

      {children}
    </div>
  );
}
