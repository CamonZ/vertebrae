import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

/**
 * The box a chat diagram block gives its diagram. Present only inside a
 * DiagramFrame, which then owns sizing: diagrams drop their own resize grips
 * and refit when the box changes size.
 */
export interface DiagramBox {
  /** The box has a definite height (resized or cinema): fill it. */
  readonly fill: boolean;
  /** Largest zoom a refit may choose (cinema lets small diagrams grow). */
  readonly maxFitZoom: number;
  /** The user widened the box past the prose measure. */
  readonly widened: boolean;
}

export const DiagramBoxContext = createContext<DiagramBox | null>(null);

export function useDiagramBox(): DiagramBox | null {
  return useContext(DiagramBoxContext);
}

/** Class for each element between a filled box and its diagram. */
export const DIAGRAM_FILL_CLASS = "diagram-fill";

export function diagramFillClass(box: DiagramBox | null): string {
  return box?.fill ? DIAGRAM_FILL_CLASS : "";
}

/**
 * A block's chosen size. `width` is the requested frame width in px, or
 * "full" for the whole chat pane; null keeps the inline (prose) width.
 * `height` is the body height in px; null keeps the diagram's own height.
 */
export interface DiagramSize {
  readonly width: number | "full" | null;
  readonly height: number | null;
}

export const DEFAULT_DIAGRAM_SIZE: DiagramSize = { width: null, height: null };

// Sizes outlive a block's mount (streaming replaces the reply's markdown, a
// history reload re-renders it) for as long as the app runs.
const sizes = new Map<string, DiagramSize>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setDiagramSize(key: string, size: DiagramSize) {
  if (size.width === null && size.height === null) sizes.delete(key);
  else sizes.set(key, size);
  for (const listener of listeners) listener();
}

export function useDiagramSize(
  key: string
): [DiagramSize, (size: DiagramSize) => void] {
  const size = useSyncExternalStore(
    subscribe,
    () => sizes.get(key) ?? DEFAULT_DIAGRAM_SIZE
  );
  const set = useCallback(
    (next: DiagramSize) => setDiagramSize(key, next),
    [key]
  );
  return [size, set];
}

/** Test isolation: forget every block's size. */
export function resetDiagramSizes() {
  sizes.clear();
  for (const listener of listeners) listener();
}

/** Stable key for a diagram source within a chat session. */
export function diagramSizeKey(
  scope: string | null,
  language: string,
  source: string
): string {
  let hash = 0;
  for (let i = 0; i < source.length; i++)
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  return `${scope ?? "-"}:${language}:${source.length}:${hash.toString(36)}`;
}

export const MIN_DIAGRAM_HEIGHT = 160;
export const MAX_DIAGRAM_HEIGHT = 1600;
/** Keyboard resize steps (Shift for the large one). */
export const RESIZE_STEP = 24;
export const LARGE_RESIZE_STEP = 96;

/** Where a block may grow: its inline width and the chat pane's width. */
export interface DiagramRoom {
  /** The prose measure (the block's slot). */
  readonly inline: number;
  /** The transcript's content width; at least `inline`. */
  readonly max: number;
  /** The slot's left edge, from the transcript content's left edge. */
  readonly offset: number;
}

export const NO_ROOM: DiagramRoom = { inline: 0, max: 0, offset: 0 };

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * The frame's width and shift for a requested width. The block grows evenly
 * on both sides of the prose measure; at a pane edge it keeps growing toward
 * the other side, never past the pane. Null keeps the inline width.
 */
export function frameGeometry(
  width: DiagramSize["width"],
  room: DiagramRoom
): { width: number; marginLeft: number } | null {
  if (width === null || room.max <= room.inline) return null;
  const w = Math.round(
    clamp(width === "full" ? room.max : width, room.inline, room.max)
  );
  if (w <= Math.round(room.inline)) return null;
  const centred = room.offset - (w - room.inline) / 2;
  const left = clamp(centred, 0, room.max - w);
  return { width: w, marginLeft: Math.round(left - room.offset) };
}
