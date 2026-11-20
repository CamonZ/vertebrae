/** Space kept between a floating comment surface and the window edge. */
export const VIEWPORT_GUTTER_PX = 8;
/** Space between the selected text and the card. */
export const SELECTION_GAP_PX = 6;

export interface Box {
  top: number;
  bottom: number;
  left: number;
}

export interface CommentCardPlacementInput {
  viewport: { width: number; height: number };
  /** Bounding box of the whole selection. */
  selection: Pick<Box, "top" | "bottom">;
  /** The line box where the selection ended; the card aligns to its left. */
  edge: Pick<Box, "left">;
  /** The card's measured, uncapped size. */
  card: { width: number; height: number };
}

export type CommentCardSide = "below" | "above" | "overlap";

export interface CommentCardPlacement {
  top: number;
  left: number;
  /** Set when the card is taller than the inset window and must scroll. */
  maxHeight: number | null;
  side: CommentCardSide;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

/**
 * Where the transcript comment card goes: below the selection when it fits,
 * otherwise above it, and over it only when neither side has room. The card
 * always stays inside the window inset by VIEWPORT_GUTTER_PX; a card taller
 * than that is capped and scrolls.
 */
export function placeCommentCard({
  viewport,
  selection,
  edge,
  card,
}: CommentCardPlacementInput): CommentCardPlacement {
  const minTop = VIEWPORT_GUTTER_PX;
  const maxBottom = viewport.height - VIEWPORT_GUTTER_PX;
  const available = Math.max(0, maxBottom - minTop);
  const height = Math.min(card.height, available);
  const width = Math.min(card.width, Math.max(0, viewport.width - 2 * minTop));
  const maxHeight = card.height > available ? available : null;

  const belowTop = selection.bottom + SELECTION_GAP_PX;
  const aboveBottom = selection.top - SELECTION_GAP_PX;
  let side: CommentCardSide;
  let top: number;
  if (maxBottom - belowTop >= height) {
    side = "below";
    top = Math.max(belowTop, minTop);
  } else if (aboveBottom - minTop >= height) {
    side = "above";
    top = Math.min(aboveBottom, maxBottom) - height;
  } else {
    side = "overlap";
    top = clamp(belowTop, minTop, maxBottom - height);
  }

  return {
    top,
    left: clamp(edge.left, minTop, viewport.width - minTop - width),
    maxHeight,
    side,
  };
}
