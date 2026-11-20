import type { SelectedLineRange, SelectionSide } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";

type View = CodeViewHandle<ReviewAnnotation, undefined> | null;
type Selection = { id: string; range: SelectedLineRange } | null;

const FALLBACK_LINE_HEIGHT = 20;
/** Frames a page waits for Pierre to mount the rows it scrolled to. */
const PAGE_LAND_FRAMES = 6;
const INTERACTIVE =
  "button, a, input, textarea, select, summary, label, [contenteditable], [role='button']";

export interface DiffLine {
  id: string;
  line: number;
  side: SelectionSide;
}

function renderedItems(view: View) {
  return view?.getInstance()?.getRenderedItems() ?? [];
}

function lineHeight(view: View): number {
  for (const item of renderedItems(view)) {
    const line = item.element.shadowRoot?.querySelector("[data-line]");
    const height = line?.getBoundingClientRect().height;
    if (height) return height;
  }
  return FALLBACK_LINE_HEIGHT;
}

/** The diff line a `[data-line]` code element shows, on its side. */
function describeLine(id: string, line: HTMLElement): DiffLine | null {
  const number = Number(line.getAttribute("data-line"));
  if (!Number.isInteger(number) || number < 1) return null;
  const column = line.closest("[data-code]");
  const side: SelectionSide = column?.hasAttribute("data-deletions")
    ? "deletions"
    : column?.hasAttribute("data-additions")
      ? "additions"
      : line.getAttribute("data-line-type") === "change-deletion"
        ? "deletions"
        : "additions";
  return { id, line: number, side };
}

/**
 * The diff code line a plain click landed on, or null when the click hit a
 * control, an annotation, a separator or ended a text selection.
 */
export function clickedCodeLine(event: MouseEvent, view: View): DiffLine | null {
  if (
    event.button !== 0 ||
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return null;
  if (window.getSelection()?.isCollapsed === false) return null;

  const path = event.composedPath();
  let line: HTMLElement | null = null;
  for (const target of path) {
    if (!(target instanceof HTMLElement)) continue;
    if (target.matches(INTERACTIVE)) return null;
    if (target.hasAttribute("data-line")) {
      line = target;
      break;
    }
  }
  const item = renderedItems(view).find(({ element }) => path.includes(element));
  return line && item ? describeLine(item.id, line) : null;
}

/** The code column of `side` (or the unified one) in a mounted item. */
function sideColumn(root: ShadowRoot, side: SelectionSide) {
  return (
    root.querySelector<HTMLElement>(`[data-code][data-${side}]`) ??
    root.querySelector<HTMLElement>("[data-code][data-unified]")
  );
}

/** The mounted row of the selection's cursor (end) line, if any. */
function cursorRow(view: View, selected: Selection): DOMRect | null {
  const range = selected?.range;
  if (!selected || !range) return null;
  const side = range.endSide ?? range.side ?? "additions";
  const item = renderedItems(view).find(({ id }) => id === selected.id);
  const root = item?.element.shadowRoot;
  if (!item || item.type !== "diff" || !root) return null;
  const index = item.instance.getLineIndex(range.end, side)?.join(",");
  const line =
    index === undefined
      ? null
      : sideColumn(root, side)?.querySelector(
          `[data-line][data-line-index="${index}"]`
        );
  return line?.getBoundingClientRect() ?? null;
}

/**
 * The mounted code line on `side` whose row is nearest height `y` within
 * `top`..`bottom` (the visible scroller).
 */
function nearestLine(
  view: View,
  side: SelectionSide,
  y: number,
  top: number,
  bottom: number
): DiffLine | null {
  let best: { id: string; line: HTMLElement; distance: number } | null = null;
  for (const item of renderedItems(view)) {
    const root = item.element.shadowRoot;
    const column = root && sideColumn(root, side);
    if (!column) continue;
    for (const line of column.querySelectorAll<HTMLElement>("[data-line]")) {
      const rect = line.getBoundingClientRect();
      if (rect.height === 0 || rect.bottom <= top || rect.top >= bottom) continue;
      const distance = Math.abs(rect.top + rect.height / 2 - y);
      if (!best || distance < best.distance) best = { id: item.id, line, distance };
    }
  }
  return best && describeLine(best.id, best.line);
}

/**
 * PgUp/PgDn: scroll the Changes scroller one page (two lines of overlap),
 * then hand back the line that now sits where the cursor was on screen, so
 * the cursor keeps its place in the viewport the way an editor's does.
 */
export function pageChanges(
  view: View,
  container: HTMLElement | null,
  direction: -1 | 1,
  land: (line: DiffLine) => void
) {
  if (!container) return;
  const selected: Selection = view?.getInstance()?.getSelectedLines() ?? null;
  const height = lineHeight(view);
  const bounds = container.getBoundingClientRect();
  const side =
    selected?.range.endSide ?? selected?.range.side ?? ("additions" as const);
  const row = cursorRow(view, selected);
  const distance = Math.max(height, container.clientHeight - 2 * height);
  const atEdge =
    direction > 0
      ? container.scrollTop + container.clientHeight >= container.scrollHeight - 1
      : container.scrollTop <= 0;
  container.scrollBy({ top: direction * distance, behavior: "instant" });

  // The cursor keeps its height on screen. With nothing left to scroll it
  // travels the page on screen instead, staying inside the viewport.
  const startY = row ? row.top + row.height / 2 : bounds.top + height * 2;
  const targetY = Math.min(
    bounds.bottom - height / 2,
    Math.max(bounds.top + height / 2, startY + (atEdge ? direction * distance : 0))
  );

  // Pierre mounts the newly exposed rows over its next frames.
  let attempts = PAGE_LAND_FRAMES;
  const settle = () => {
    const line = nearestLine(view, side, targetY, bounds.top, bounds.bottom);
    if (line) land(line);
    else if (--attempts > 0) requestAnimationFrame(settle);
  };
  requestAnimationFrame(() => requestAnimationFrame(settle));
}
