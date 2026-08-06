import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type AnimationEventHandler,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useGlassPanel } from "../../hooks/useGlassPanel";
import {
  SIDE_PANEL_GAP_PX,
  SIDE_PANEL_INSET_PX,
  usePanelLayoutStore,
} from "../../stores/panelLayoutStore";

interface FloatingDetailPanelProps {
  /** Stable id for the shared glass-panel focus stack (single Escape closes the focused panel). */
  panelId: string;
  /** localStorage key the panel width is persisted under. */
  widthStorageKey: string;
  /** Resize clamp + initial width. */
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  /** Plays the exit animation; the parent unmounts the node on animation end. */
  closing?: boolean;
  onExitAnimationEnd?: AnimationEventHandler<HTMLDivElement>;
  /** Invoked when Escape lands on the focused panel. */
  onClose?: () => void;
  /**
   * Return `false` to decline an Escape (e.g. while an inline edit or a
   * confirmation is open, so its own handler wins). Defaults to always handling.
   */
  shouldHandleEscape?: () => boolean;
  /**
   * Whether the panel is logically open (drives focus registration). Defaults to
   * mounted-and-not-closing.
   */
  isOpen?: boolean;
  /** Extra classes on the root — e.g. "tasks-v2" to scope inner content. */
  className?: string;
  /** Test id for the float root. */
  testId?: string;
  position?: "right" | "left-of-task";
  /** Override the computed right-stack offset for coordinated overlays. */
  rightOffset?: number;
  /** Pin the panel to a left inset for an intentional overlay placement. */
  leftOffset?: number;
  /** Placement mode exposed for shared panel CSS and test assertions. */
  placementMode?: string;
  children: ReactNode;
}

const DEFAULT_MIN_WIDTH = 360;
const DEFAULT_MAX_WIDTH = 760;
const DEFAULT_WIDTH = 480;
const RESIZE_STEP = 16;

/**
 * The Hearth floating-glass detail surface, shared by the task / step / workflow
 * detail panels. Owns the right-anchored fixed overlay, horizontal drag/keyboard
 * resize with localStorage persistence, and the shared focus model
 * (Escape-to-close). Callers supply the panel's content; the visual chrome
 * (header, body) lives in that content, not here.
 */
export function FloatingDetailPanel({
  panelId,
  widthStorageKey,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  defaultWidth = DEFAULT_WIDTH,
  closing = false,
  onExitAnimationEnd,
  onClose,
  shouldHandleEscape,
  isOpen,
  className = "",
  testId,
  position = "right",
  rightOffset,
  leftOffset,
  placementMode,
  children,
}: FloatingDetailPanelProps) {
  // Right-anchored: a drag on the left edge widens the panel as the cursor moves
  // left. We measure the panel's fixed right edge from the DOM rather than
  // assuming the inset value.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") return defaultWidth;
    const stored = parseInt(localStorage.getItem(widthStorageKey) ?? "", 10);
    return Number.isNaN(stored)
      ? defaultWidth
      : Math.min(maxWidth, Math.max(minWidth, stored));
  });
  const [isResizing, setIsResizing] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth
  );
  const chatLayout = usePanelLayoutStore((s) => s.chat);
  const taskDetailLayout = usePanelLayoutStore((s) => s.taskDetail);
  const setPanelLayout = usePanelLayoutStore((s) => s.setPanelLayout);
  const clearPanelLayout = usePanelLayoutStore((s) => s.clearPanelLayout);
  const availableAdjacentWidth =
    viewportWidth -
    chatLayout.renderedWidth -
    SIDE_PANEL_GAP_PX -
    SIDE_PANEL_INSET_PX * 2;
  const isChatAdjacent =
    chatLayout.isPresent &&
    !chatLayout.isMaximized &&
    availableAdjacentWidth >= minWidth;
  const chatOffset = isChatAdjacent
    ? `calc(${chatLayout.renderedWidth}px + var(--s-3))`
    : "0px";
  const taskOffset =
    position === "left-of-task" && taskDetailLayout.isPresent
      ? `calc(${chatLayout.renderedWidth}px + var(--s-3) + ${taskDetailLayout.renderedWidth}px + var(--s-3))`
      : chatOffset;
  const chatOffsetPx = isChatAdjacent
    ? chatLayout.renderedWidth + SIDE_PANEL_GAP_PX
    : 0;
  const taskOffsetPx =
    position === "left-of-task" && taskDetailLayout.isPresent
      ? chatOffsetPx + taskDetailLayout.renderedWidth + SIDE_PANEL_GAP_PX
      : chatOffsetPx;
  const panelIsOpen = isOpen ?? !closing;

  useLayoutEffect(() => {
    if (!panelIsOpen) {
      clearPanelLayout(panelId);
      return;
    }

    setPanelLayout(panelId, {
      isPresent: true,
      renderedWidth: panelWidth,
      rightOffset: rightOffset ?? taskOffsetPx,
      isMaximized: false,
    });
    return () => clearPanelLayout(panelId);
  }, [
    clearPanelLayout,
    panelId,
    panelIsOpen,
    panelWidth,
    rightOffset,
    setPanelLayout,
    taskOffsetPx,
  ]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(widthStorageKey, String(panelWidth));
    }
  }, [panelWidth, widthStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    updateViewportWidth();
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: MouseEvent) => {
      const rightEdge =
        panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      setPanelWidth(
        Math.min(maxWidth, Math.max(minWidth, rightEdge - event.clientX))
      );
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing, minWidth, maxWidth]);

  // Join the shared glass-panel focus model. Escape closes the focused panel
  // unless the caller declines.
  const { isFocused, focusProps } = useGlassPanel({
    id: panelId,
    isOpen: isOpen ?? !closing,
    onClose: onClose ?? (() => {}),
    shouldHandleEscape,
  });

  return (
    <div
      ref={panelRef}
      className={`${className} detail detail-float${closing ? " is-closing" : ""}`.trim()}
      style={
        {
          width: `${panelWidth}px`,
          "--detail-panel-chat-offset": taskOffset,
          "--detail-panel-right-offset": `${rightOffset ?? taskOffsetPx}px`,
          "--detail-panel-left-offset":
            leftOffset == null ? undefined : `${leftOffset}px`,
        } as CSSProperties
      }
      data-testid={testId}
      data-placement={placementMode}
      data-focused={isFocused || undefined}
      data-closing={closing || undefined}
      data-chat-adjacent={isChatAdjacent || undefined}
      onAnimationEnd={onExitAnimationEnd}
      {...focusProps}
    >
      <div
        className="detail-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={panelWidth}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        data-resizing={isResizing || undefined}
        onMouseDown={(event) => {
          event.preventDefault();
          setIsResizing(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            setPanelWidth((w) => Math.min(maxWidth, w + RESIZE_STEP));
          } else if (event.key === "ArrowRight") {
            setPanelWidth((w) => Math.max(minWidth, w - RESIZE_STEP));
          }
        }}
      />
      {children}
    </div>
  );
}
