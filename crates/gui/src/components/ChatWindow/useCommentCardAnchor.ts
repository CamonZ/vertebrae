import { useLayoutEffect, type RefObject } from "react";
import type { PendingComment } from "./assistantTextComments";
import { findQuoteRange } from "./commentHighlight";

const GAP = 8;

function diffQuoteLine(comment: HTMLElement): HTMLElement | null {
  // Pierre slots annotations into the shadow row following the quoted line.
  const annotation = comment.closest<HTMLElement>('[slot^="annotation-"]');
  const row = annotation?.assignedSlot?.closest("[data-line-annotation]");
  const line = row?.previousElementSibling;
  return line instanceof HTMLElement && line.hasAttribute("data-line")
    ? line
    : null;
}

export function useCommentCardAnchor(
  cardRef: RefObject<HTMLDivElement | null>,
  comment: PendingComment | undefined
) {
  useLayoutEffect(() => {
    const card = cardRef.current;
    const workspace = card?.closest(".chat-with-changes");
    if (!card || !workspace || !comment) return;

    let surface: HTMLElement | null = null;
    let pane: Element | null = null;
    let quote: Range | null = null;
    let reveal = true;
    let frame = 0;

    const reset = () => {
      card.classList.remove("chat-comment-card-fixed");
      for (const property of ["top", "left", "max-width", "max-height"]) {
        card.style.removeProperty(property);
      }
    };
    const position = () => {
      if (!surface || !pane) return reset();
      const diffLine = comment.kind === "diff" ? diffQuoteLine(surface) : null;
      const quoteRects = quote?.getClientRects?.();
      const line = diffLine?.getBoundingClientRect() ?? quoteRects?.[0];
      if (!line?.height) return reset();

      const bounds = pane.getBoundingClientRect();
      const left = Math.max(0, bounds.left) + GAP;
      const right = Math.min(window.innerWidth, bounds.right) - GAP;
      const top = Math.max(0, bounds.top) + GAP;
      const bottom = Math.min(window.innerHeight, bounds.bottom) - GAP;
      if (right <= left || bottom <= top) return reset();

      if (reveal) {
        reveal = false;
        if (line.top < bounds.top || line.bottom > bounds.bottom) {
          if (comment.kind === "text") {
            // Center the first line itself, even inside a very long paragraph.
            surface.scrollTop += line.top - (top + bottom - line.height) / 2;
          } else {
            diffLine?.scrollIntoView?.({ block: "center" });
          }
          schedule();
          return;
        }
      }
      if (line.bottom <= bounds.top || line.top >= bounds.bottom)
        return reset();

      card.classList.add("chat-comment-card-fixed");
      card.style.maxWidth = `${right - left}px`;
      card.style.maxHeight = `${bottom - top}px`;
      const { width, height } = card.getBoundingClientRect();
      const above = line.top - GAP - height;
      const lastLine = quoteRects?.[quoteRects.length - 1] ?? line;
      const below = lastLine.bottom + GAP;
      const y = above >= top ? above : below;
      card.style.left = `${Math.max(left, Math.min(line.left, right - width))}px`;
      card.style.top = `${Math.max(top, Math.min(y, bottom - height))}px`;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    const resolve = () => {
      const next =
        comment.kind === "text"
          ? workspace.querySelector<HTMLElement>("[data-transcript-viewport]")
          : (Array.from(
              workspace.querySelectorAll<HTMLElement>("[data-diff-comment-id]")
            ).find((element) => element.dataset.diffCommentId === comment.id) ??
            null);
      const nextPane =
        comment.kind === "text"
          ? next
          : (next?.closest(
              ".changes-code-view, .evdiff-scroll, .changes-side-panel, [data-transcript-viewport]"
            ) ?? null);
      if (nextPane !== pane) {
        if (pane) resize?.unobserve(pane);
        pane = nextPane;
        if (pane) resize?.observe(pane);
      }
      surface = next;
      quote =
        surface && comment.kind === "text"
          ? findQuoteRange(surface, comment)
          : null;
      schedule();
    };
    const mutations = new MutationObserver((records) => {
      if (records.some(({ target }) => !card.contains(target))) resolve();
    });
    mutations.observe(workspace, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    resize?.observe(workspace);
    resize?.observe(card);
    resolve();
    cancelAnimationFrame(frame);
    position();
    window.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      reset();
    };
  }, [cardRef, comment]);
}
