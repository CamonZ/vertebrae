import type { CodeViewHandle } from "@pierre/diffs/react";
import type { RefObject } from "react";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";

/** The first diff line in view, to come back to after a remount. */
export interface ViewportAnchor {
  path: string;
  line: number;
  side: "old" | "new";
}

/**
 * The topmost line of the diff that is in view in `container`: Pierre's
 * rendered rows are read where they are drawn (rows carry `data-line`; a
 * split diff's old side is `[data-deletions]`, a unified row says its type).
 */
export function viewportAnchor(
  view: CodeViewHandle<ReviewAnnotation, undefined> | null,
  container: HTMLElement | null,
  pathOf: (itemId: string) => string
): ViewportAnchor | null {
  const items = view?.getInstance()?.getRenderedItems() ?? [];
  if (!container || items.length === 0) return null;
  const top = container.getBoundingClientRect().top;
  let best: { at: number; anchor: ViewportAnchor } | null = null;
  for (const item of items) {
    const root = item.element.shadowRoot;
    if (!root) continue;
    for (const row of root.querySelectorAll<HTMLElement>(
      "[data-code] [data-content] [data-line]"
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= top || rect.height === 0) continue;
      if (best && rect.top >= best.at) break;
      const line = Number.parseInt(row.getAttribute("data-line") ?? "", 10);
      if (!Number.isFinite(line)) continue;
      const old =
        !!row.closest("[data-deletions]") ||
        (row.getAttribute("data-line-type") ?? "").includes("deletion");
      best = {
        at: rect.top,
        anchor: { path: pathOf(item.id), line, side: old ? "old" : "new" },
      };
      break;
    }
  }
  return best?.anchor ?? null;
}

/** Lets the diff's owner read the anchor (`viewportRef`), from this render on. */
export function exposeViewportAnchor(
  viewportRef: RefObject<(() => ViewportAnchor | null) | null> | undefined,
  view: RefObject<CodeViewHandle<ReviewAnnotation, undefined> | null>,
  container: RefObject<HTMLElement | null>,
  itemPaths: ReadonlyMap<string, string>
) {
  if (viewportRef)
    viewportRef.current = () =>
      viewportAnchor(
        view.current,
        container.current,
        (id) => itemPaths.get(id) ?? id
      );
}
