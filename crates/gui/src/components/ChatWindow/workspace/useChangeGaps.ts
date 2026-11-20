import {
  hydratePartialDiff,
  type CodeViewRenderedItem,
  type FileDiffLoadedChangedFiles,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import type { GapCursor } from "../../thread/toolChange/diffCursor";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";
import {
  GAP_BATCH,
  gapEnds,
  growGap,
  mergeRevealsByPath,
  type FileContext,
  type GapEnd,
  type GapReveal,
  type Reveals,
} from "../../thread/toolChange/diffGaps";
import type { FilePatch } from "../../thread/toolChange/diffLineMapper";
import { contentsMatchPatch } from "./changeContents";

/** Marks the separator the keyboard cursor rests on; the value is the end ↵ reveals. */
export const GAP_CURSOR_ATTRIBUTE = "data-cursor-gap";

type Contents = FileDiffLoadedChangedFiles | null;

interface Hydration {
  contents: Contents;
  /** Null when the contents do not match the patch. */
  diff: FileDiffMetadata | null;
}

const NO_REVEALS: ReadonlyMap<number, GapReveal> = new Map();

type RenderedItem = CodeViewRenderedItem<ReviewAnnotation, undefined>;

export interface ChangeGapsInput {
  /** Each path's parsed patch, which the cursor walks. */
  patches: ReadonlyMap<string, FilePatch>;
  /** Both sides of a file once loaded for its current patch, else null. */
  contentsFor(path: string): Contents;
  /** Gaps are rows only with Pierre's line-count separators. */
  enabled: boolean;
  /**
   * Lines revealed without being asked for (semantic mode's declaration
   * lines), per path and gap; each gap end shows the larger of these and
   * what was revealed by hand.
   */
  autoReveals?: Reveals;
  viewRef: RefObject<CodeViewHandle<ReviewAnnotation, undefined> | null>;
}

export interface ChangeGaps {
  /** The diff to render for `path`: hydrated with full files once loaded. */
  fileDiffFor(path: string, fileDiff: FileDiffMetadata): FileDiffMetadata;
  /** Collapsed-gap state for the cursor; undefined where gaps are not rows. */
  context(path: string): FileContext | undefined;
  /** Show these lines of a gap. */
  reveal(path: string, gap: number, reveal: GapReveal): void;
  /** Pierre `onPostRender`: apply reveals and mark the cursor gap. */
  onPostRender(node: HTMLElement, instance: unknown): void;
  /** Routes Pierre's expand buttons through {@link ChangeGaps.reveal}. */
  onClickCapture(event: MouseEvent<HTMLElement>): void;
  /** The keyboard cursor's gap (or null), drawn on its separator. */
  markCursor(cursor: GapCursor | null): void;
}

/**
 * Revealing collapsed unchanged lines in the Changes view. This hook owns
 * which lines are revealed (per path and gap); Pierre renders them. Each
 * diff becomes expandable once both sides of its file are loaded (see
 * `useChangeFiles`); every expansion, keyboard or mouse, goes through
 * `reveal`, and each Pierre instance is brought up to date when it renders.
 * State resets with the view (keyed by comparison).
 */
const NO_AUTO_REVEALS: Reveals = new Map();

/** Revealed lines: asked for by hand, automatic, and the two merged. */
interface RevealState {
  user: Reveals;
  auto: Reveals;
  merged: Reveals;
}

export function useChangeGaps({
  patches,
  contentsFor,
  enabled,
  viewRef,
  autoReveals = NO_AUTO_REVEALS,
}: ChangeGapsInput): ChangeGaps {
  // The authoritative reveals, for event handlers and Pierre callbacks,
  // written only by `updateReveals`; the state copy of the merged reveals
  // re-renders the cursor context.
  const revealState = useRef<RevealState>({
    user: NO_AUTO_REVEALS,
    auto: autoReveals,
    merged: autoReveals,
  });
  const [reveals, setReveals] = useState<Reveals>(autoReveals);
  const pushed = useRef(new WeakMap<object, Map<number, GapReveal>>());
  // Hydration is memoized per patch diff, and the latest per path is what
  // the cursor walks (both written only by `fileDiffFor`).
  const hydrated = useRef(new WeakMap<FileDiffMetadata, Hydration>());
  const hydratedByPath = useRef(new Map<string, Hydration>());
  const cursorRef = useRef<GapCursor | null>(null);
  const inputs = useRef({ patches });
  inputs.current = { patches };

  const fileDiffFor = useCallback(
    (path: string, fileDiff: FileDiffMetadata): FileDiffMetadata => {
      const contents = contentsFor(path);
      const patch = patches.get(path);
      if (
        !enabled ||
        !contents ||
        !patch ||
        !fileDiff.isPartial ||
        (fileDiff.type !== "change" && fileDiff.type !== "rename-changed")
      )
        return fileDiff;
      const cached = hydrated.current.get(fileDiff);
      if (cached?.contents === contents) {
        hydratedByPath.current.set(path, cached);
        return cached.diff ?? fileDiff;
      }
      let diff: FileDiffMetadata | null = null;
      try {
        diff = hydratePartialDiff("clone", fileDiff, contents);
        if (!contentsMatchPatch(patch, diff.deletionLines, diff.additionLines))
          diff = null;
      } catch (error: unknown) {
        console.error("Could not expand unchanged lines for", path, error);
      }
      const entry = { contents, diff };
      hydrated.current.set(fileDiff, entry);
      hydratedByPath.current.set(path, entry);
      return diff ?? fileDiff;
    },
    [contentsFor, patches, enabled]
  );

  const context = useCallback(
    (path: string): FileContext | undefined => {
      if (!enabled) return undefined;
      const contents = contentsFor(path);
      const entry = hydratedByPath.current.get(path);
      const diff = contents && entry?.contents === contents ? entry.diff : null;
      return {
        revealed: reveals.get(path) ?? NO_REVEALS,
        lines: diff ? diff.additionLines : null,
      };
    },
    [enabled, contentsFor, reveals]
  );

  const renderedItems = useCallback(
    (): RenderedItem[] =>
      viewRef.current?.getInstance()?.getRenderedItems() ?? [],
    [viewRef]
  );

  /** Bring one rendered (hydrated) diff's expansions up to `reveals`. */
  const sync = useCallback((item: RenderedItem) => {
    if (item.type !== "diff" || item.item.fileDiff.isPartial) return;
    const target = revealState.current.merged.get(item.id);
    if (!target) return;
    const done = pushed.current.get(item.instance) ?? new Map<number, GapReveal>();
    pushed.current.set(item.instance, done);
    for (const [gap, want] of target) {
      const have = done.get(gap) ?? { top: 0, bottom: 0 };
      try {
        // Pierre's "up" grows a gap's top (`fromStart`), "down" its bottom.
        if (want.top > have.top) item.instance.expandHunk(gap, "up", want.top - have.top);
        if (want.bottom > have.bottom)
          item.instance.expandHunk(gap, "down", want.bottom - have.bottom);
        done.set(gap, want);
      } catch (error: unknown) {
        // Not yet rendering the loaded files; retried on the next render.
        console.debug("Deferred expanding unchanged lines", error);
        return;
      }
    }
  }, []);

  const mark = useCallback((item: RenderedItem) => {
    const root = item.element.shadowRoot ?? item.element;
    for (const element of root.querySelectorAll(`[${GAP_CURSOR_ATTRIBUTE}]`))
      element.removeAttribute(GAP_CURSOR_ATTRIBUTE);
    const cursor = cursorRef.current;
    const patch = inputs.current.patches.get(item.id);
    if (!cursor || cursor.path !== item.id || !patch) return;
    const { primary } = gapEnds(patch, cursor.gap, cursor.arrival);
    for (const element of root.querySelectorAll(
      `[data-separator][data-expand-index="${cursor.gap}"]`
    ))
      element.setAttribute(GAP_CURSOR_ATTRIBUTE, primary === "top" ? "up" : "down");
  }, []);

  /** Replace either source of reveals and bring the rendered diffs up to date. */
  const updateReveals = useCallback(
    (sources: Partial<Omit<RevealState, "merged">>) => {
      const { user, auto } = { ...revealState.current, ...sources };
      const merged = mergeRevealsByPath(user, auto);
      revealState.current = { user, auto, merged };
      setReveals(merged);
      for (const item of renderedItems()) sync(item);
    },
    [renderedItems, sync]
  );

  const reveal = useCallback(
    (path: string, gap: number, next: GapReveal) => {
      const { user } = revealState.current;
      updateReveals({
        user: new Map(user).set(
          path,
          new Map(user.get(path) ?? NO_REVEALS).set(gap, next)
        ),
      });
    },
    [updateReveals]
  );

  // Automatic reveals arrive after the diffs render (and change with them).
  useEffect(
    () => updateReveals({ auto: autoReveals }),
    [autoReveals, updateReveals]
  );

  const onPostRender = useCallback(
    (_node: HTMLElement, instance: unknown) => {
      const item = renderedItems().find(
        (candidate) => candidate.instance === instance
      );
      if (!item || !inputs.current.patches.has(item.id)) return;
      sync(item);
      mark(item);
    },
    [renderedItems, sync, mark]
  );

  const onClickCapture = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const trail = event.nativeEvent.composedPath();
      const elements = trail.filter((node): node is Element => node instanceof Element);
      const button = elements.find(
        (element) =>
          element.hasAttribute("data-expand-button") ||
          element.hasAttribute("data-unmodified-lines")
      );
      const separator = elements.find((element) =>
        element.hasAttribute("data-expand-index")
      );
      if (!button || !separator) return;
      const item = renderedItems().find((candidate) => trail.includes(candidate.element));
      const patch = item && inputs.current.patches.get(item.id);
      const fileContext = item && context(item.id);
      if (!item || !patch || !fileContext) return;
      event.preventDefault();
      event.stopPropagation();
      const gap = Number(separator.getAttribute("data-expand-index"));
      // Every control reveals one section, never the whole gap.
      const ends: GapEnd[] = button.hasAttribute("data-expand-up")
        ? ["top"]
        : button.hasAttribute("data-expand-down")
          ? ["bottom"]
          : ["top", "bottom"];
      const next = growGap(patch, fileContext, gap, ends, GAP_BATCH);
      if (next) reveal(item.id, gap, next);
    },
    [renderedItems, context, reveal]
  );

  const markCursor = useCallback(
    (cursor: GapCursor | null) => {
      cursorRef.current = cursor;
      for (const item of renderedItems()) mark(item);
    },
    [renderedItems, mark]
  );

  return useMemo(
    () => ({
      fileDiffFor,
      context,
      reveal,
      onPostRender,
      onClickCapture,
      markCursor,
    }),
    [fileDiffFor, context, reveal, onPostRender, onClickCapture, markCursor]
  );
}
