import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../atoms/Icon";
import { IconButton } from "../panels/IconButton";
import { ChatSessionContext } from "../thread/toolChange/ChatSessionContext";
import {
  clamp,
  DiagramBoxContext,
  diagramSizeKey,
  frameGeometry,
  LARGE_RESIZE_STEP,
  MAX_DIAGRAM_HEIGHT,
  MIN_DIAGRAM_HEIGHT,
  NO_ROOM,
  RESIZE_STEP,
  useDiagramSize,
  type DiagramBox,
  type DiagramRoom as Room,
  type DiagramSize,
} from "./diagramBox";
import "./DiagramFrame.css";

function measureRoom(slot: HTMLElement): Room {
  const own = slot.getBoundingClientRect();
  const pane = slot.closest<HTMLElement>("[data-transcript-viewport]");
  if (!pane) return { inline: own.width, max: own.width, offset: 0 };
  const style = getComputedStyle(pane);
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const left = pane.getBoundingClientRect().left + pane.clientLeft + padLeft;
  const width = pane.clientWidth - padLeft - padRight;
  return {
    inline: own.width,
    max: Math.max(own.width, width),
    offset: own.left - left,
  };
}

const sameRoom = (a: Room, b: Room) =>
  Math.round(a.inline) === Math.round(b.inline) &&
  Math.round(a.max) === Math.round(b.max) &&
  Math.round(a.offset) === Math.round(b.offset);

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden], [inert]")
  );
}

const isTextEntry = (target: EventTarget) =>
  target instanceof Element &&
  target.closest("input, textarea, select, [contenteditable='true']") !== null;

/** The single open cinema window; opening another closes it. */
let closeOpenCinema: (() => void) | null = null;

type Axes = "x" | "y" | "xy";
interface Drag {
  readonly pointerId: number;
  readonly axes: Axes;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DiagramFrameProps {
  /** Diagram kind, e.g. "Flow"; names the block and its controls. */
  label: string;
  /** Fence language and source identify the block's remembered size. */
  language: string;
  source: string;
  /** The diagram draws its own title; the label only names the block. */
  hideLabel?: boolean;
  testId?: string;
  children: ReactNode;
}

/**
 * A chat diagram block that can grow past the prose measure (up to the chat
 * pane's width), be made taller or shorter, and open in a cinema window over
 * the whole app. The diagram stays mounted throughout: it renders into one
 * host element that moves between the transcript and the cinema window, so
 * playback, drill-down and pan/zoom survive the switch. Sizes are kept per
 * chat and source while the app runs.
 */
export function DiagramFrame({
  label,
  language,
  source,
  hideLabel = false,
  testId,
  children,
}: DiagramFrameProps) {
  const sessionId = useContext(ChatSessionContext);
  const [size, setSize] = useDiagramSize(
    diagramSizeKey(sessionId, language, source)
  );
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const slotRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.className = "diagram-block-host";
    return el;
  });

  const [room, setRoom] = useState<Room>(NO_ROOM);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cinema, setCinema] = useState(false);
  const [inset, setInset] = useState(false);
  const [placeholderHeight, setPlaceholderHeight] = useState<number | null>(
    null
  );

  // Room follows the pane and the prose measure; the frame overflows its
  // slot, so its own width never feeds back into the measurement.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const body = bodyRef.current;
    if (!slot || !body) return;
    const measure = () => {
      const next = measureRoom(slot);
      setRoom((prev) => (sameRoom(prev, next) ? prev : next));
      const h = Math.round(body.getBoundingClientRect().height);
      setBodyHeight((prev) => (prev === h ? prev : h));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    observer.observe(body);
    const pane = slot.closest("[data-transcript-viewport]");
    if (pane) observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  const geometry = frameGeometry(size.width, room);
  const widened = geometry !== null;
  const canWiden = room.max > room.inline + 1;
  const width = geometry?.width ?? Math.round(room.inline);
  const resized = size.width !== null || size.height !== null;

  const box = useMemo<DiagramBox>(
    () => ({
      fill: cinema || size.height !== null,
      maxFitZoom: cinema ? 2 : 1,
      widened,
    }),
    [cinema, size.height, widened]
  );

  const update = useCallback(
    (patch: Partial<DiagramSize>) => setSize({ ...sizeRef.current, ...patch }),
    [setSize]
  );

  const widthFor = (w: number): DiagramSize["width"] =>
    w <= room.inline ? null : Math.min(Math.round(w), Math.round(room.max));
  const heightFor = (h: number) =>
    Math.round(clamp(h, MIN_DIAGRAM_HEIGHT, MAX_DIAGRAM_HEIGHT));
  const currentHeight = size.height ?? bodyHeight;

  // ── Pointer resizing ────────────────────────────────────────────────────
  const startDrag = (axes: Axes) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    if (axes !== "xy") event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      axes,
      x: event.clientX,
      y: event.clientY,
      width,
      height: currentHeight,
    });
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    update({
      ...(drag.axes !== "y" && {
        // The block grows on both sides, so the edge under the pointer
        // moves half as far as the width changes.
        width: widthFor(drag.width + 2 * (event.clientX - drag.x)),
      }),
      ...(drag.axes !== "x" && {
        height: heightFor(drag.height + event.clientY - drag.y),
      }),
    });
  };
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const dragHandlers = (axes: Axes) => ({
    onPointerDown: startDrag(axes),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
  });

  // ── Keyboard resizing ───────────────────────────────────────────────────
  function widthKeys(event: KeyboardEvent<HTMLElement>) {
    const step = event.shiftKey ? LARGE_RESIZE_STEP : RESIZE_STEP;
    let next: DiagramSize["width"] | undefined;
    if (event.key === "ArrowRight") next = widthFor(width + step);
    else if (event.key === "ArrowLeft") next = widthFor(width - step);
    else if (event.key === "End") next = "full";
    else if (event.key === "Home" || event.key === "Enter") next = null;
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    update({ width: next });
  }
  function heightKeys(event: KeyboardEvent<HTMLElement>) {
    const step = event.shiftKey ? LARGE_RESIZE_STEP : RESIZE_STEP;
    let next: number | null | undefined;
    if (event.key === "ArrowDown") next = heightFor(currentHeight + step);
    else if (event.key === "ArrowUp") next = heightFor(currentHeight - step);
    else if (event.key === "Home") next = MIN_DIAGRAM_HEIGHT;
    else if (event.key === "End") next = MAX_DIAGRAM_HEIGHT;
    else if (event.key === "Enter") next = null;
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    update({ height: next });
  }

  // ── Cinema ──────────────────────────────────────────────────────────────
  const restoreFocus = useRef(false);
  const close = useCallback(() => {
    restoreFocus.current = true;
    setCinema(false);
  }, []);

  function openCinema() {
    if (cinema) return;
    closeOpenCinema?.();
    setPlaceholderHeight(
      Math.round(bodyRef.current?.getBoundingClientRect().height ?? 0) || null
    );
    setCinema(true);
  }

  useEffect(() => {
    if (!cinema) return;
    closeOpenCinema = close;
    return () => {
      if (closeOpenCinema === close) closeOpenCinema = null;
    };
  }, [cinema, close]);

  const [cinemaRoot, setCinemaRoot] = useState<HTMLDivElement | null>(null);
  const [cinemaMount, setCinemaMount] = useState<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The diagram's host lives in the transcript or the cinema window.
  useLayoutEffect(() => {
    const target = cinema ? cinemaMount : mountRef.current;
    if (!target || host.parentNode === target) return;
    target.appendChild(host);
    if (cinema) {
      const first = focusables(host)[0] ?? closeRef.current;
      first?.focus({ preventScroll: true });
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [cinema, cinemaMount, host]);

  useLayoutEffect(() => () => host.remove(), [host]);

  // Background content is inert while the cinema window is open.
  useEffect(() => {
    if (!cinemaRoot) return;
    const made: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child === cinemaRoot || child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      made.push(child);
    }
    return () => made.forEach((child) => child.removeAttribute("inert"));
  }, [cinemaRoot]);

  /**
   * Keys inside the cinema window, from its chrome or from the diagram
   * (which React parents to the transcript block): Esc closes unless the
   * diagram used it, Tab cycles within the window, and nothing reaches the
   * transcript behind it.
   */
  function cinemaKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      close();
    } else if (event.key === "Tab" && dialogRef.current) {
      const items = focusables(dialogRef.current);
      event.preventDefault();
      if (items.length > 0) {
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? at <= 0
            ? items.length - 1
            : at - 1
          : at === -1 || at === items.length - 1
            ? 0
            : at + 1;
        items[next].focus();
      }
    }
    event.stopPropagation();
  }
  const isolate = (event: SyntheticEvent) => event.stopPropagation();
  const cinemaIsolation = cinema
    ? {
        onKeyDown: cinemaKeys,
        onWheel: isolate,
        onFocus: isolate,
        onBlur: isolate,
      }
    : {};

  function frameKeys(event: KeyboardEvent<HTMLElement>) {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      (event.key !== "f" && event.key !== "F") ||
      isTextEntry(event.target)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    openCinema();
  }

  const name = `${label} diagram`;
  const fullWidth = canWiden && geometry !== null && geometry.width >= room.max;

  return (
    <div className="diagram-block-slot" ref={slotRef}>
      <section
        className="diagram-block"
        aria-label={name}
        data-testid={testId ?? "diagram-block"}
        data-widened={geometry ? "" : undefined}
        data-resized={resized ? "" : undefined}
        data-resizing={drag ? drag.axes : undefined}
        data-cinema={cinema ? "" : undefined}
        data-widenable={canWiden ? "" : undefined}
        style={
          geometry
            ? { width: geometry.width, marginLeft: geometry.marginLeft }
            : undefined
        }
        onKeyDown={frameKeys}
      >
        <div className="diagram-block-head">
          {/* The section is named for the diagram; a titled diagram shows
              its own caption, so the visible label would repeat it. */}
          <span
            className="mr-auto font-mono text-meta text-fg-mute"
            aria-hidden="true"
            data-testid="diagram-block-label"
          >
            {hideLabel ? null : label}
          </span>
          <span className="diagram-block-actions">
            {resized && (
              <IconButton
                ariaLabel={`Reset ${name} size`}
                title="Reset size"
                onClick={() => setSize({ width: null, height: null })}
              >
                <Icon size="sm">
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                </Icon>
              </IconButton>
            )}
            <IconButton
              ariaLabel={`${name}: full pane width`}
              title={
                canWiden
                  ? fullWidth
                    ? "Back to reading width"
                    : "Full pane width"
                  : "Already at the chat pane's width"
              }
              pressed={fullWidth}
              disabled={!canWiden}
              onClick={() => update({ width: fullWidth ? null : "full" })}
            >
              <Icon size="sm">
                <path d="M3 12h18" />
                <path d="m7 8-4 4 4 4" />
                <path d="m17 8 4 4-4 4" />
              </Icon>
            </IconButton>
            <IconButton
              ref={triggerRef}
              ariaLabel={`Open ${name} in cinema mode`}
              title="Open in cinema mode (F)"
              keyShortcuts="F"
              onClick={openCinema}
            >
              <Icon size="sm">
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="m21 3-7 7" />
                <path d="m3 21 7-7" />
              </Icon>
            </IconButton>
          </span>
        </div>
          <div
            className="diagram-block-body"
            ref={bodyRef}
            data-fill={size.height !== null ? "" : undefined}
            style={
              cinema
                ? { height: placeholderHeight ?? size.height ?? undefined }
                : size.height !== null
                  ? { height: size.height }
                  : undefined
            }
          >
            <div className="diagram-block-mount" ref={mountRef} />
            {cinema && (
              <p className="diagram-block-placeholder">
                {label} is open in cinema mode.
              </p>
            )}
          </div>
          {canWiden && (
            <span
              role="separator"
              aria-orientation="vertical"
              aria-label={`${name} width`}
              aria-valuenow={width}
              aria-valuemin={Math.round(room.inline)}
              aria-valuemax={Math.round(room.max)}
              tabIndex={0}
              title="Drag, or use ← and → (Shift for larger steps), End for full width, Enter to reset."
              className="diagram-block-edge"
              data-testid="diagram-block-width-handle"
              onKeyDown={widthKeys}
              {...dragHandlers("x")}
            />
          )}
          <span
            role="separator"
            aria-orientation="horizontal"
            aria-label={`${name} height`}
            aria-valuenow={Math.round(currentHeight)}
            aria-valuemin={MIN_DIAGRAM_HEIGHT}
            aria-valuemax={MAX_DIAGRAM_HEIGHT}
            tabIndex={0}
            title="Drag, or use ↑ and ↓ (Shift for larger steps), Enter to reset."
            className="diagram-block-bottom"
            data-testid="diagram-block-height-handle"
            onKeyDown={heightKeys}
            {...dragHandlers("y")}
          />
          {canWiden && (
            <span
              aria-hidden="true"
              className="diagram-block-corner"
              data-testid="diagram-block-corner-handle"
              {...dragHandlers("xy")}
            />
          )}
        
        {createPortal(
          <DiagramBoxContext.Provider value={box}>
            <div className="diagram-block-content" {...cinemaIsolation}>
              {children}
            </div>
          </DiagramBoxContext.Provider>,
          host
        )}
        {cinema &&
          createPortal(
            <div
              ref={setCinemaRoot}
              className="diagram-cinema"
              data-inset={inset ? "" : undefined}
              data-testid="diagram-cinema"
              {...cinemaIsolation}
            >
              <div
                className="diagram-cinema-scrim"
                aria-hidden="true"
                data-testid="diagram-cinema-scrim"
                onClick={close}
              />
              <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={`${name}, cinema mode`}
                className="diagram-cinema-window"
              >
                <div className="diagram-cinema-head">
                  <span className="mr-auto font-mono text-meta text-fg-mute">
                    {label}
                  </span>
                  <span className="diagram-block-actions">
                    <IconButton
                      ariaLabel="Inset cinema window"
                      title={inset ? "Fill the window" : "Inset the window"}
                      pressed={inset}
                      onClick={() => setInset((v) => !v)}
                    >
                      <Icon size="sm">
                        {inset ? (
                          <>
                            <path d="M15 3h6v6" />
                            <path d="M9 21H3v-6" />
                          </>
                        ) : (
                          <>
                            <path d="M4 14h6v6" />
                            <path d="M20 10h-6V4" />
                          </>
                        )}
                      </Icon>
                    </IconButton>
                    <IconButton
                      ref={closeRef}
                      ariaLabel="Close cinema mode"
                      title="Close (Esc)"
                      keyShortcuts="Escape"
                      onClick={close}
                    >
                      <Icon size="sm">
                        <path d="M6 6l12 12" />
                        <path d="M18 6 6 18" />
                      </Icon>
                    </IconButton>
                  </span>
                </div>
                <div className="diagram-cinema-body" ref={setCinemaMount} />
              </div>
            </div>,
            document.body
          )}
      </section>
    </div>
  );
}
