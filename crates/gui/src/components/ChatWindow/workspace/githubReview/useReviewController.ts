import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GITHUB_MARKER_ATTRIBUTE } from "./markers";
import {
  markerKey,
  type GithubReviewModel,
  type PlacedThread,
  type ThreadMarker,
} from "./model";

/** Marks rail entries, so focus can return to one. */
export const REVIEW_ENTRY_ATTRIBUTE = "data-review-entry";
/** Marks a file's Outdated toggle, for the same reason. */
export const OUTDATED_TOGGLE_ATTRIBUTE = "data-gh-outdated-toggle";
/** Marks the control in the pane that opens the Review rail. */
export const REVIEW_TOGGLE_ATTRIBUTE = "data-review-toggle";

/**
 * Where focus goes back to when a thread card or the rail closes. Logical,
 * not an element: Pierre recycles rows and a comparison switch remounts the
 * diff, so the element is looked up (inside the pane) when it is needed.
 */
type FocusTarget =
  | { kind: "marker"; key: string }
  | { kind: "outdated"; path: string }
  | { kind: "rail"; threadId: string }
  | { kind: "railOpener" };

function markerElement(root: HTMLElement, key: string): HTMLElement | null {
  for (const host of root.querySelectorAll<HTMLElement>("[data-gh-markers]")) {
    const found = host.shadowRoot?.querySelector<HTMLElement>(
      `[${GITHUB_MARKER_ATTRIBUTE}][data-marker-key="${CSS.escape(key)}"]`
    );
    if (found) return found;
  }
  return null;
}

/** The target's element inside `root`, if it is drawn. */
function resolveFocusTarget(
  root: HTMLElement,
  target: FocusTarget
): HTMLElement | null {
  switch (target.kind) {
    case "marker":
      return markerElement(root, target.key);
    case "outdated":
      return root.querySelector<HTMLElement>(
        `[${OUTDATED_TOGGLE_ATTRIBUTE}="${CSS.escape(target.path)}"]`
      );
    case "rail":
      return root.querySelector<HTMLElement>(
        `[${REVIEW_ENTRY_ATTRIBUTE}="${CSS.escape(target.threadId)}"]`
      );
    case "railOpener":
      return root.querySelector<HTMLElement>(`[${REVIEW_TOGGLE_ATTRIBUTE}]`);
  }
}

/** What Changes needs to draw and drive the GitHub threads on its diff. */
export interface GithubDiffThreads {
  model: GithubReviewModel;
  /** Threads expanded in the diff (under their line, or a file's outdated group). */
  openThreads: ReadonlySet<string>;
  /** The thread whose card takes focus when it renders. */
  focusThreadId: string | null;
  /** That card took focus. */
  focused(): void;
  /** A marker to focus once Pierre draws it (focus coming back to it). */
  focusMarker: string | null;
  /** That marker took focus. */
  markerFocused(): void;
  /** Expand (focus in its first card) or collapse a marker's threads. */
  toggleMarker(marker: ThreadMarker): void;
  /** Expand or collapse a file's outdated threads. */
  toggleOutdated(path: string): void;
  /** Close one card; focus goes back to what opened it. */
  closeThread(threadId: string): void;
}

/** What the Review rail needs to expand and close its own cards. */
export interface RailThreads {
  /** Threads expanded in the rail (the diff cannot show them). */
  inline: ReadonlySet<string>;
  /** Choose an entry: shown in the diff when it can be, else in the rail. */
  select(placed: PlacedThread): void;
  /** Close a card expanded in the rail; focus goes back to its entry. */
  closeInline(threadId: string): void;
}

const without = (set: ReadonlySet<string>, ids: readonly string[]) => {
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
};

/**
 * One controller for the GitHub threads Changes shows: which are expanded
 * in the diff and in the Review rail, which card takes focus, and where
 * focus returns to. Kept by Changes itself so a comparison switch (which
 * remounts the diff) keeps threads open. Focus targets are resolved inside
 * `pane`, never the whole document, so two panes do not steal focus.
 */
export function useReviewController(
  model: GithubReviewModel | null,
  pane: React.RefObject<HTMLElement | null>,
  /** Show a thread's line or file in the diff; false when it has no diff. */
  showInDiff: (placed: PlacedThread) => boolean,
  /** The rail overlays the diff, so it closes when it shows a thread there. */
  railCovers: () => boolean = () => false
) {
  const [openThreads, setOpenThreads] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [inline, setInline] = useState<ReadonlySet<string>>(() => new Set());
  const [focusThreadId, setFocusThreadId] = useState<string | null>(null);
  const [focusMarker, setFocusMarker] = useState<string | null>(null);
  const returns = useRef(new Map<string, FocusTarget>());

  const focusTarget = useCallback(
    (target: FocusTarget) => {
      const root = pane.current;
      const element = root ? resolveFocusTarget(root, target) : null;
      if (element) element.focus({ preventScroll: true });
      // Closing a card redraws the marker's row (or it is not drawn yet):
      // the marker takes focus again once Pierre has drawn it.
      if (target.kind === "marker") setFocusMarker(target.key);
      else if (!element) root?.focus({ preventScroll: true });
    },
    [pane]
  );

  const open = useCallback(
    (ids: readonly string[], back: FocusTarget, focus: string | null) => {
      for (const id of ids) returns.current.set(id, back);
      setOpenThreads((current) => new Set([...current, ...ids]));
      setFocusThreadId(focus);
    },
    []
  );
  const close = useCallback((ids: readonly string[]) => {
    setOpenThreads((current) => without(current, ids));
    setFocusThreadId(null);
  }, []);

  /** Where a card goes back to when nothing else opened it. */
  const homeOf = useCallback(
    (threadId: string): FocusTarget | null => {
      const placed = model?.byThread.get(threadId);
      if (placed?.kind === "line")
        return {
          kind: "marker",
          key: markerKey(placed.thread.anchor.path, placed.side, placed.line),
        };
      if (placed?.kind === "outdated")
        return { kind: "outdated", path: placed.thread.anchor.path };
      return null;
    },
    [model]
  );

  const diff = useMemo<GithubDiffThreads | null>(() => {
    if (!model) return null;
    return {
      model,
      openThreads,
      focusThreadId,
      focused: () => setFocusThreadId(null),
      focusMarker,
      markerFocused: () => setFocusMarker(null),
      toggleMarker: (marker) => {
        const ids = marker.threads.map(({ thread }) => thread.id);
        if (ids.some((id) => openThreads.has(id))) close(ids);
        else open(ids, { kind: "marker", key: marker.key }, ids[0] ?? null);
      },
      toggleOutdated: (path) => {
        const ids = (model.outdatedByPath.get(path) ?? []).map(
          ({ thread }) => thread.id
        );
        if (ids.some((id) => openThreads.has(id))) close(ids);
        else open(ids, { kind: "outdated", path }, ids[0] ?? null);
      },
      closeThread: (threadId) => {
        const back = returns.current.get(threadId) ?? homeOf(threadId);
        returns.current.delete(threadId);
        close([threadId]);
        if (back) focusTarget(back);
      },
    };
  }, [
    model,
    openThreads,
    focusThreadId,
    focusMarker,
    open,
    close,
    homeOf,
    focusTarget,
  ]);

  /** A thread opens in the diff with its file's other outdated threads. */
  const shownWith = useCallback(
    (placed: PlacedThread): string[] =>
      placed.kind === "outdated" && model
        ? (model.outdatedByPath.get(placed.thread.anchor.path) ?? []).map(
            ({ thread }) => thread.id
          )
        : [placed.thread.id],
    [model]
  );

  /**
   * Bring a thread into view wherever it can be read: expanded in the diff,
   * else expanded in the Review rail (which the caller opens).
   */
  const reveal = useCallback(
    (placed: PlacedThread): "diff" | "rail" => {
      const id = placed.thread.id;
      if (showInDiff(placed)) {
        open(shownWith(placed), homeOf(id) ?? { kind: "railOpener" }, id);
        return "diff";
      }
      setInline((current) => new Set([...current, id]));
      return "rail";
    },
    [showInDiff, open, shownWith, homeOf]
  );

  /**
   * `[`/`]`: the card stepped from closes (with what opened with it), the
   * next thread is revealed with focus in its card.
   */
  const step = useCallback(
    (fromId: string | null, next: PlacedThread): "diff" | "rail" => {
      const from = fromId ? model?.byThread.get(fromId) : undefined;
      if (from) {
        const ids = shownWith(from);
        for (const id of ids) returns.current.delete(id);
        close(ids);
        setInline((current) => without(current, [from.thread.id]));
      }
      return reveal(next);
    },
    [model, shownWith, close, reveal]
  );

  const rail = useMemo<RailThreads>(
    () => ({
      inline,
      select: (placed) => {
        const id = placed.thread.id;
        // A covering rail closes: focus goes back to the thread's marker
        // or Outdated pill instead of the gone entry.
        const back: FocusTarget = railCovers()
          ? (homeOf(id) ?? { kind: "railOpener" })
          : { kind: "rail", threadId: id };
        if (!inline.has(id) && showInDiff(placed)) {
          open(shownWith(placed), back, id);
          return;
        }
        setInline((current) =>
          current.has(id) ? without(current, [id]) : new Set([...current, id])
        );
      },
      closeInline: (threadId) => {
        setInline((current) => without(current, [threadId]));
        focusTarget({ kind: "rail", threadId });
      },
    }),
    [inline, open, shownWith, showInDiff, railCovers, homeOf, focusTarget]
  );

  return { diff, rail, focusTarget, reveal, step };
}

/**
 * The Review rail's open state: opening it moves focus into it (a rail
 * restored on mount does not, nor one whose card already took focus, as
 * stepping to a thread does), closing it gives focus back to the control
 * that opened it in the pane.
 */
export function useRailFocus(
  showRail: boolean,
  railRef: React.RefObject<HTMLElement | null>,
  focusTarget: (target: FocusTarget) => void
) {
  const wasOpen = useRef(showRail);
  useEffect(() => {
    const rail = railRef.current;
    if (showRail && !wasOpen.current && !rail?.contains(document.activeElement))
      rail?.focus({ preventScroll: true });
    else if (!showRail && wasOpen.current) {
      // Focus was in the rail (now gone) rather than on what closed it.
      const active = document.activeElement;
      if (!active || active === document.body)
        focusTarget({ kind: "railOpener" });
    }
    wasOpen.current = showRail;
  }, [showRail, railRef, focusTarget]);
}
