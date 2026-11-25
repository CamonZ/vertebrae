import { CHANGES_COMMANDS } from "../chatShortcuts";
import type { SourceLocation } from "../../shared/EvidenceNavigationContext";
import type { DiffPreferences } from "../../../utils/codeAppearance";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CodeView,
  WorkerPoolContext,
  type CodeViewAnnotationArgs,
  type CodeViewDiffItem,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import type { CodeViewRenderedItem, SelectedLineRange } from "@pierre/diffs";
import type { WorktreeChange } from "../../../bindings";
import { usePierreDiffOptions } from "../../../hooks/useCodeAppearance";
import { useDiffComments } from "../../../hooks/useDiffComments";
import {
  useChangesCursor,
  type ChangesKey,
} from "../../../stores/chatSideColumnStore";
import { DIFF_CURSOR_ENTRY_ATTRIBUTE } from "../../thread/toolChange/diffCursor";
import { GAP_BATCH } from "../../thread/toolChange/diffGaps";
import {
  canonicalPath,
  type FilePatch,
} from "../../thread/toolChange/diffLineMapper";
import { GAP_CURSOR_ATTRIBUTE, useChangeGaps } from "./useChangeGaps";
import {
  hasReviewContent,
  type ReviewAnnotation,
} from "../../thread/toolChange/DiffCommentThread";
import { DiffReviewContext } from "../../thread/toolChange/DiffReviewContext";
import type { BackgroundOutputs } from "../../../background/types";
import { MARKER_TEXT } from "../../thread/toolChange/worktreeDelta";
import {
  CHANGES_CURSOR_CSS,
  changesCursorScrollBehavior,
  useChangesCursorOverlay,
} from "./useChangesCursorOverlay";
import {
  COMMENTED_LINES_CSS,
  useCommentedLines,
} from "../../thread/toolChange/commentedLines";
import { diffWorkerPool } from "../../thread/toolChange/diffWorkerPool";
import {
  clickedCodeLine,
  pageChanges,
  type DiffLine,
} from "./changesCursorPointer";
import {
  DeclarationCounts,
  FormattingBadge,
  SemanticLabelRow,
} from "./SemanticLabel";
import {
  useChangeFiles,
  type LoadSides,
  type SemanticFile,
} from "./useChangeFiles";
import { useSemanticMode } from "./useSemanticMode";
import {
  linksAt,
  linksForFile,
  useRelatedSymbols,
  type SymbolGraphRequest,
} from "./relatedSymbols";

import { labelChips, type SemanticLabel } from "./semanticHunks";
import { SEMANTIC_GUTTER_CSS, syncSemanticGutter } from "./semanticGutter";
import { GITHUB_MARKERS_CSS, syncGithubMarkers } from "./githubMarkers";
import { markerKey } from "./githubReview";
import {
  GithubThreadGroup,
  OUTDATED_TOGGLE_ATTRIBUTE,
  OutdatedToggle,
} from "./GithubThreads";
import type { GithubDiffThreads } from "./useGithubReview";

type ExpandedLabel = { id: string; label: SemanticLabel };

export interface JumpTarget extends SourceLocation {
  /** Distinguishes repeated jumps to the same file. */
  nonce: number;
  focusHeader?: boolean;
}

export interface AllChangesViewProps {
  files: readonly WorktreeChange[];
  parsedPatches: BackgroundOutputs["patch"];
  /** Scroll the shared viewport to this changed file. */
  jumpTarget: JumpTarget | null;
  onOpen(path: string): void;
  renderExternalEditor?(path: string): ReactNode;
  diffStyle?: DiffPreferences["diffStyle"];
  /** The keyboard line cursor moved into this file. */
  onCursorFile?(path: string): void;
  /** Leave the diff for the main chat input. */
  onExit?(): void;
  /** Files marked viewed: shown folded and skipped by the line cursor. */
  viewedPaths?: ReadonlySet<string>;
  onViewedChange?(path: string, viewed: boolean): void;
  /**
   * Both sides of a changed file (so its collapsed unchanged lines can be
   * revealed), and in semantic mode its semantic diff.
   */
  loadSides?: LoadSides;
  symbolGraphRequest?: SymbolGraphRequest;
  onRelatedJump?(location: SourceLocation): void;
  /**
   * The chat's Changes this view shows: its line cursor lives in the store,
   * read here so a cursor move re-renders only this view.
   */
  chatChanges?: ChangesKey;
  /** The linked PR's review threads, placed on this comparison. */
  github?: GithubDiffThreads | null;
}

const NO_PATHS: ReadonlySet<string> = new Set();
const NO_CHANGES: ChangesKey = { sessionId: "", worktreePath: "" };

/** Why a file is folded: marked viewed, or folded by hand. */
type FoldReason = "viewed" | "hand";

/** Context kept visible around the keyboard cursor, in pixels (~4 lines). */
const CURSOR_SCROLL_MARGIN = 80;

const FALLBACK_ATTRIBUTE = "data-changes-fallback";

const CODE_VIEW_LAYOUT = { paddingTop: 0, paddingBottom: 8, gap: 8 };

/** Separator styles that count unchanged lines and can expand them. */
const LINE_INFO_SEPARATORS = new Set(["line-info", "line-info-basic"]);

/**
 * Collapsed gaps in Changes: every separator carries its expand key; the one
 * under the keyboard cursor wears the cursor bar and lists its bindings.
 */
const GAP_CSS = `
/* Gaps open one section at a time; there is no whole-gap control. */
[data-expand-all-button] {
  display: none;
}
[data-separator] [data-unmodified-lines]::after {
  content: "↵";
  margin-inline-start: 8px;
  padding: 0 4px;
  border: 1px solid color-mix(in lab, var(--diffs-fg) 22%, transparent);
  border-radius: 4px;
  font-size: 0.85em;
  line-height: 1.4;
  opacity: 0.75;
}
[data-separator][${GAP_CURSOR_ATTRIBUTE}] [data-unmodified-lines]::after {
  opacity: 1;
}
[data-separator][${GAP_CURSOR_ATTRIBUTE}="up"] [data-unmodified-lines]::after {
  content: "↵ expand down · ⌥↵ up";
}
[data-separator][${GAP_CURSOR_ATTRIBUTE}="down"] [data-unmodified-lines]::after {
  content: "↵ expand up · ⌥↵ down";
}
[data-separator-first][${GAP_CURSOR_ATTRIBUTE}] [data-unmodified-lines]::after {
  content: "↵ expand up";
}
[data-separator-last][${GAP_CURSOR_ATTRIBUTE}] [data-unmodified-lines]::after {
  content: "↵ expand down";
}
`;

/**
 * Every changed file in one virtualized Pierre viewport. Files without text
 * hunks (binary, oversized, unreadable, metadata-only) are listed above the
 * diffs so they stay inspectable. Loaded lazily so Pierre stays out of the
 * main chunk.
 */
export default function AllChangesView({
  files,
  parsedPatches,
  jumpTarget,
  onOpen,
  renderExternalEditor,
  diffStyle,
  onCursorFile,
  onExit,
  viewedPaths = NO_PATHS,
  onViewedChange,
  loadSides,
  symbolGraphRequest,
  onRelatedJump,
  chatChanges,
  github = null,
}: AllChangesViewProps): ReactNode {
  const onToggleViewed = onViewedChange
    ? (path: string) => onViewedChange(path, !viewedPaths.has(path))
    : undefined;
  const options = usePierreDiffOptions();
  // Folded or opened by hand.
  const [handFolds, setHandFolds] = useState<
    ReadonlyMap<string, "folded" | "open">
  >(new Map());
  const changes = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files]
  );
  const patchesByPath = useMemo(() => {
    const byPath = new Map<string, FilePatch>();
    for (const result of parsedPatches)
      for (const file of result.reviewFiles)
        byPath.set(canonicalPath(file), file);
    return byPath;
  }, [parsedPatches]);
  // The line diff, with semantic labels wherever the sides can be read.
  const semanticOn = !!loadSides;
  const gapsEnabled =
    !!loadSides && LINE_INFO_SEPARATORS.has(options.hunkSeparators);
  const changeFiles = useChangeFiles(
    changes,
    patchesByPath,
    loadSides,
    semanticOn
  );
  const [expanded, setExpanded] = useState<ExpandedLabel | null>(null);
  const returnFocus = useRef<ExpandedLabel | null>(null);
  const { request: requestFile, fileFor } = changeFiles;
  const semantic = useSemanticMode(changeFiles, semanticOn);
  const related = useRelatedSymbols(
    semanticOn ? symbolGraphRequest : undefined,
    patchesByPath
  );
  const foldReason = useCallback(
    (path: string): FoldReason | null => {
      if (viewedPaths.has(path)) return "viewed";
      const hand = handFolds.get(path);
      return hand === "folded" ? "hand" : null;
    },
    [viewedPaths, handFolds]
  );
  const collapsedPaths = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        files.map((file) => file.path).filter((path) => foldReason(path))
      ),
    [files, foldReason]
  );
  /** Unfold a file however it was folded. */
  const expandPath = useCallback(
    (path: string) => {
      if (viewedPaths.has(path)) onViewedChange?.(path, false);
      setHandFolds((current) =>
        current.get(path) === "open"
          ? current
          : new Map(current).set(path, "open")
      );
    },
    [viewedPaths, onViewedChange]
  );
  const viewRef = useRef<CodeViewHandle<ReviewAnnotation, undefined>>(null);
  const jumpHeader = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { items, fallbacks, itemPaths } = useMemo(() => {
    const items: CodeViewDiffItem<ReviewAnnotation>[] = [];
    const fallbacks: { file: WorktreeChange; text: string }[] = [];
    const itemPaths = new Map<string, string>();

    for (const [fileIndex, file] of files.entries()) {
      if (file.marker) {
        fallbacks.push({ file, text: MARKER_TEXT[file.marker] });
        continue;
      }

      const diffs = parsedPatches[fileIndex]?.files;
      if (!diffs) {
        fallbacks.push({ file, text: "Diff could not be displayed" });
        continue;
      }

      if (diffs.length === 0) {
        fallbacks.push({
          file,
          text: "No text hunks (mode or metadata change).",
        });
        continue;
      }

      diffs.forEach((fileDiff, index) => {
        const id = index === 0 ? file.path : `${file.path}#${index}`;
        itemPaths.set(id, file.path);
        items.push({ id, type: "diff", fileDiff });
      });
    }

    return { items, fallbacks, itemPaths };
  }, [files, parsedPatches]);

  // Retained paths keep their folding through patch/annotation refreshes. Removed
  // files must start expanded if they appear again later.
  useEffect(() => {
    const paths = new Set(files.map((file) => file.path));
    setHandFolds((current) => {
      const retained = new Map(
        [...current].filter(([path]) => paths.has(path))
      );
      return retained.size === current.size ? current : retained;
    });
    for (const id of itemVersions.current.keys()) {
      if (!itemPaths.has(id)) itemVersions.current.delete(id);
    }
  }, [files, itemPaths]);

  // Review comments: parsed patch files for resolving gutter selections, and
  // Pierre annotations per file from the shared pending comments.
  const patchFiles = useMemo(
    () =>
      parsedPatches.flatMap((result, index) =>
        collapsedPaths.has(files[index]?.path) ? [] : result.reviewFiles
      ),
    [parsedPatches, files, collapsedPaths]
  );
  const layout = diffStyle ?? options.diffStyle;
  const contentsFor = useCallback(
    (path: string) => fileFor(path)?.contents ?? null,
    [fileFor]
  );
  const gaps = useChangeGaps({
    patches: patchesByPath,
    contentsFor,
    enabled: gapsEnabled,
    viewRef,
  });
  const { fileDiffFor, onPostRender: onGapsPostRender } = gaps;
  const lastCursorMove = useRef(-Infinity);
  // Read unconditionally (hooks); unused without a chat's Changes.
  const heldCursor = useChangesCursor(chatChanges ?? NO_CHANGES);
  const review = useDiffComments({ kind: "worktree" }, patchFiles, undefined, {
    layout,
    onExit,
    onToggleViewed,
    page: (direction, extend) =>
      pageChanges(viewRef.current, containerRef.current, direction, (line) =>
        placeCursor(line, extend)
      ),
    context: gaps.context,
    onRevealGap: gaps.reveal,
    selectionState: chatChanges ? heldCursor : undefined,
    marks: github
      ? (path) =>
          (github.model.markersByPath.get(path) ?? []).map((marker) => ({
            side: marker.side,
            line: marker.line,
          }))
      : undefined,
    onOpenAt: github
      ? (path, side, line) => {
          const marker = github.model.markerByKey.get(
            markerKey(path, side, line)
          );
          if (!marker) return false;
          github.toggleMarker(marker);
          return true;
        }
      : undefined,
    onCursorMove: (path, lineNumber, side) => {
      const now = performance.now();
      const behavior = changesCursorScrollBehavior(
        now - lastCursorMove.current
      );
      lastCursorMove.current = now;
      onCursorFile?.(path);
      requestFile(path);
      viewRef.current?.scrollTo({
        type: "line",
        id: path,
        lineNumber,
        side,
        align: "nearest",
        offset: CURSOR_SCROLL_MARGIN,
        behavior,
      });
    },
  });
  const { annotationsFor, openComposer, onSelectionChange, selectedLinesFor } =
    review;
  // A closed GitHub card hands focus back to its marker once it is drawn.
  const returnMarker = useRef<string | null>(null);
  const gutterState = useRef({
    semantic,
    related,
    itemPaths,
    expanded,
    onRelatedJump,
    github,
  });
  gutterState.current = {
    semantic,
    related,
    itemPaths,
    expanded,
    onRelatedJump,
    github,
  };
  const paintGutter = useCallback(
    (
      item: CodeViewRenderedItem<ReviewAnnotation, undefined>,
      /** Pierre has just drawn this item, so its rows are final. */
      rendered = false
    ) => {
      const root = item.element.shadowRoot;
      if (item.type !== "diff" || !root) return;
      const state = gutterState.current;
      const path = state.itemPaths.get(item.id) ?? item.id;
      const { github } = state;
      // Markers go on the file's primary patch item, like semantic labels.
      const markers =
        github && path === item.id
          ? (github.model.markersByPath.get(path) ?? [])
          : [];
      const focusMarker =
        returnMarker.current !== null &&
        github?.model.markerByKey.get(returnMarker.current)?.path === path
          ? returnMarker.current
          : undefined;
      const markerFocused = syncGithubMarkers(
        root,
        item.element,
        item.instance,
        markers,
        (key) =>
          !!github?.model.markerByKey
            .get(key)
            ?.threads.some(({ thread }) => github.openThreads.has(thread.id)),
        (marker) => github?.toggleMarker(marker),
        focusMarker
      );
      // Pierre redraws the item once the card is gone; focus again then.
      if (markerFocused && rendered) returnMarker.current = null;
      // Only the primary patch item receives a file's semantic coordinates.
      const file = path === item.id ? state.semantic.fileFor(path) : null;
      const links = linksForFile(state.related.links, path, file);
      const labels =
        file?.status === "semantic"
          ? file.view.labels.filter(
              (label) =>
                label.scope.length > 0 ||
                label.test ||
                label.facts.length > 0 ||
                labelChips(label).length > 0 ||
                (!!state.onRelatedJump &&
                  linksAt(links, label.declarationIndices ?? []).length > 0)
            )
          : [];
      const active =
        state.expanded?.id === item.id ? state.expanded.label : undefined;
      const focus =
        returnFocus.current?.id === item.id
          ? returnFocus.current.label
          : undefined;
      if (
        syncSemanticGutter(
          root,
          item.instance,
          labels,
          active,
          (label) => {
            setExpanded((current) =>
              current?.id === item.id && current.label === label
                ? null
                : { id: item.id, label }
            );
          },
          focus
        )
      )
        returnFocus.current = null;
    },
    []
  );
  useEffect(() => {
    for (const item of viewRef.current?.getInstance()?.getRenderedItems() ??
      []) {
      paintGutter(item);
    }
  }, [semantic, related, expanded, itemPaths, paintGutter, github]);

  const itemVersions = useRef(
    new Map<
      string,
      {
        fileDiff: unknown;
        signature: string;
        /** Labels come from the file's semantic result, built once on arrival. */
        semantic: SemanticFile | null;
        links: ReturnType<typeof linksForFile>;
        expanded: SemanticLabel | undefined;
        collapsed: boolean;
        version: number;
      }
    >()
  );
  // Expanded GitHub threads join the line's annotation (one slot per line),
  // and a file's open outdated threads sit under its first diff row.
  const withGithub = useCallback(
    (
      path: string,
      annotations: ReturnType<typeof annotationsFor>,
      firstRow: { side: "additions" | "deletions"; lineNumber: number } | null
    ) => {
      if (!github) return annotations;
      const isOpen = (threadId: string) => github.openThreads.has(threadId);
      const extra: {
        side: "additions" | "deletions";
        lineNumber: number;
        metadata: Partial<ReviewAnnotation>;
      }[] = [];
      for (const marker of github.model.markersByPath.get(path) ?? [])
        if (marker.threads.some(({ thread }) => isOpen(thread.id)))
          extra.push({
            side: marker.side,
            lineNumber: marker.line,
            metadata: { githubMarker: marker.key },
          });
      const outdated = github.model.outdatedByPath.get(path) ?? [];
      if (firstRow && outdated.some(({ thread }) => isOpen(thread.id)))
        extra.push({ ...firstRow, metadata: { githubOutdated: true } });
      if (extra.length === 0) return annotations;
      const merged = new Map(
        annotations.map((annotation) => [
          `${annotation.side}:${annotation.lineNumber}`,
          annotation,
        ])
      );
      for (const { side, lineNumber, metadata } of extra) {
        const key = `${side}:${lineNumber}`;
        const existing = merged.get(key);
        merged.set(key, {
          side,
          lineNumber,
          metadata: {
            ...(existing?.metadata ?? { commentIds: [], draft: false }),
            ...metadata,
          },
        });
      }
      return [...merged.values()];
    },
    [github]
  );
  // CodeView keeps an item until its `version` changes. Publish annotation,
  // diff, label and folding changes through that same reconciliation contract.
  const reviewItems = useMemo(
    () =>
      items.map((patchItem): CodeViewDiffItem<ReviewAnnotation> => {
        const own = patchItem.id === itemPaths.get(patchItem.id);
        // Expandable once the file's contents are loaded.
        const item = own
          ? {
              ...patchItem,
              fileDiff: fileDiffFor(patchItem.id, patchItem.fileDiff),
            }
          : patchItem;
        const firstHunk = item.fileDiff.hunks[0];
        const review = own
          ? withGithub(
              item.id,
              annotationsFor(item.id),
              firstHunk
                ? firstHunk.additionCount > 0
                  ? { side: "additions", lineNumber: firstHunk.additionStart }
                  : { side: "deletions", lineNumber: firstHunk.deletionStart }
                : null
            )
          : undefined;
        const active = expanded?.id === item.id ? expanded.label : undefined;
        const annotations =
          review && semantic.annotate(item.id, review, active);
        const signature = JSON.stringify(annotations ?? []);
        const path = itemPaths.get(item.id) ?? item.id;
        const file = semantic.fileFor(path);
        const links = linksForFile(related.links, path, file);
        const collapsed = collapsedPaths.has(path);
        const previous = itemVersions.current.get(item.id);
        const changed =
          previous !== undefined &&
          (previous.fileDiff !== item.fileDiff ||
            previous.signature !== signature ||
            previous.semantic !== file ||
            previous.links !== links ||
            previous.expanded !== active ||
            previous.collapsed !== collapsed);
        const version = (previous?.version ?? 0) + (changed ? 1 : 0);
        itemVersions.current.set(item.id, {
          fileDiff: item.fileDiff,
          signature,
          semantic: file,
          links,
          expanded: active,
          collapsed,
          version,
        });
        return { ...item, annotations, collapsed, version };
      }),
    [
      items,
      itemPaths,
      annotationsFor,
      collapsedPaths,
      fileDiffFor,
      semantic,
      related.links,
      expanded,
      withGithub,
    ]
  );
  const { gapCursor } = review;
  const { markCursor } = gaps;
  // The cursor's gap lives in Pierre's DOM; redraw it when the cursor moves.
  useEffect(() => markCursor(gapCursor), [markCursor, gapCursor]);
  // Controlled selection (null when none) so a composer can clear it.
  const selectedPath = reviewItems.find(
    (item) => !item.collapsed && selectedLinesFor(item.id)
  )?.id;
  const selectedLines = review.enabled
    ? selectedPath
      ? { id: selectedPath, range: selectedLinesFor(selectedPath)! }
      : null
    : undefined;
  const [dismissedEvidence, setDismissedEvidence] = useState<number | null>(
    null
  );
  /** Click and PgUp/PgDn land the line cursor on a line (⇧ extends). */
  const placeCursor = (to: DiffLine, extend: boolean) => {
    const path = itemPaths.get(to.id) ?? to.id;
    const current = viewRef.current?.getInstance()?.getSelectedLines();
    const range: SelectedLineRange =
      extend && current?.id === to.id
        ? {
            start: current.range.start,
            side: current.range.side,
            end: to.line,
            endSide: to.side,
          }
        : { start: to.line, end: to.line, side: to.side };
    setDismissedEvidence(jumpTarget?.nonce ?? null);
    onSelectionChange(path, range);
    onCursorFile?.(path);
    requestFile(path);
  };
  const evidenceSelection =
    jumpTarget?.line !== undefined &&
    dismissedEvidence !== jumpTarget.nonce &&
    itemPaths.has(jumpTarget.path)
      ? {
          id: jumpTarget.path,
          range: {
            start: jumpTarget.line,
            end: jumpTarget.endLine ?? jumpTarget.line,
            side:
              jumpTarget.side === "old"
                ? ("deletions" as const)
                : ("additions" as const),
          },
        }
      : null;
  const { commentedRangesFor } = review;
  const scheduleCommentPaint = useCommentedLines(
    viewRef,
    useCallback(
      (id: string) => commentedRangesFor(itemPaths.get(id) ?? id),
      [commentedRangesFor, itemPaths]
    )
  );
  const { overlayRef, schedule: scheduleCursorPaint } = useChangesCursorOverlay(
    viewRef,
    containerRef,
    selectedLines,
    gapCursor,
    semanticOn
  );

  /**
   * Close one GitHub card. Focus returns to what opened it, else to the
   * line's marker; the line stays in view (the viewport does not jump to
   * where the card's height used to be).
   */
  const closeGithubThread = (threadId: string) => {
    if (!github) return;
    const placed = github.model.byThread.get(threadId);
    const handedBack = github.closeThread(threadId);
    if (placed?.kind === "line") {
      if (!handedBack)
        returnMarker.current = markerKey(
          placed.thread.path,
          placed.side,
          placed.line
        );
      viewRef.current?.scrollTo({
        type: "line",
        id: placed.thread.path,
        lineNumber: placed.line,
        side: placed.side,
        align: "nearest",
      });
    } else if (!handedBack) {
      // The Outdated pill that opened the group was redrawn meanwhile.
      const toggle = placed
        ? document.querySelector<HTMLElement>(
            `[${OUTDATED_TOGGLE_ATTRIBUTE}="${CSS.escape(placed.thread.path)}"]`
          )
        : null;
      (toggle ?? review.keyboardProps.ref.current)?.focus({
        preventScroll: true,
      });
    }
  };

  const codeViewOptions = useMemo(
    () => ({
      ...options,
      ...(diffStyle ? { diffStyle } : {}),
      stickyHeaders: true,
      // No top padding: the focus halo sits flush on the first file.
      layout: CODE_VIEW_LAYOUT,
      expansionLineCount: GAP_BATCH,
      unsafeCSS: `${options.unsafeCSS}\n${GAP_CSS}\n${CHANGES_CURSOR_CSS}\n${COMMENTED_LINES_CSS}\n${GITHUB_MARKERS_CSS}\n${semanticOn ? SEMANTIC_GUTTER_CSS : ""}`,
      onPostRender: (...args: Parameters<typeof onGapsPostRender>) => {
        onGapsPostRender(...args);
        // Pierre renders an item before adding it to its rendered range, so
        // a file's first render is only listed once this pass finishes.
        const instance = args[1];
        queueMicrotask(() => {
          const rendered = viewRef.current
            ?.getInstance()
            ?.getRenderedItems()
            .find((item) => item.instance === instance);
          if (rendered) {
            requestFile(itemPaths.get(rendered.id) ?? rendered.id);
            paintGutter(rendered, true);
          }
        });
        scheduleCursorPaint();
        scheduleCommentPaint();
      },
      ...(review.enabled
        ? {
            enableGutterUtility: true,
            // Click, drag or shift-click line numbers to select a range,
            // then choose an explicit action for that selection.
            enableLineSelection: true,
            onGutterUtilityClick: (
              range: Parameters<typeof openComposer>[1],
              context: { item: { id: string } }
            ) =>
              openComposer(
                itemPaths.get(context.item.id) ?? context.item.id,
                range
              ),
          }
        : {}),
    }),
    [
      options,
      diffStyle,
      review.enabled,
      openComposer,
      itemPaths,
      onGapsPostRender,
      scheduleCursorPaint,
      scheduleCommentPaint,
      requestFile,
      semanticOn,
      paintGutter,
    ]
  );

  // Bring a requested comment into view once per request.
  const diffReview = useContext(DiffReviewContext);
  const focus = diffReview?.focus ?? null;
  const placements = diffReview?.placements;
  const handledFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || !placements || handledFocus.current === focus.nonce) return;
    const matches = placements.filter(
      (placement) =>
        placement.commentId === focus.commentId &&
        placement.surface.kind === "worktree"
    );
    const target = matches.find((placement) => placement.home) ?? matches[0];
    if (!target || !itemPaths.has(target.path)) return;
    if (collapsedPaths.has(target.path)) {
      expandPath(target.path);
      return; // Scroll after CodeView has received the expanded item version.
    }
    handledFocus.current = focus.nonce;
    viewRef.current?.scrollTo(
      target.endLine > 0
        ? {
            type: "line",
            id: target.path,
            lineNumber: target.endLine,
            side: target.side === "old" ? "deletions" : "additions",
            align: "center",
          }
        : { type: "item", id: target.path, align: "start" }
    );
  }, [focus, placements, itemPaths, collapsedPaths, expandPath]);

  // Jump once per request; background refreshes must not move the viewport.
  const handledJump = useRef<number | null>(null);
  useEffect(() => {
    if (!jumpTarget || handledJump.current === jumpTarget.nonce) return;
    const { path } = jumpTarget;
    if (!jumpTarget.focusHeader && collapsedPaths.has(path)) {
      expandPath(path);
      return;
    }
    if (itemPaths.has(path)) {
      const target = jumpTarget;
      // A request made while Changes mounts arrives before Pierre's first
      // layout; scroll once that frame has been laid out. A re-run before
      // then cancels this frame and schedules the jump again.
      let focusFrame: number | undefined;
      const frame = requestAnimationFrame(() => {
        handledJump.current = target.nonce;
        viewRef.current?.scrollTo(
          target.line !== undefined
            ? {
                type: "line",
                id: path,
                lineNumber: target.line,
                side: target.side === "old" ? "deletions" : "additions",
                align: "center",
              }
            : { type: "item", id: path, align: "start" }
        );
        if (target.focusHeader) {
          focusFrame = requestAnimationFrame(() =>
            jumpHeader.current?.focus({ preventScroll: true })
          );
        }
      });
      return () => {
        cancelAnimationFrame(frame);
        if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      };
    }
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[${FALLBACK_ATTRIBUTE}="${CSS.escape(path)}"]`
    );
    if (container && target) {
      handledJump.current = jumpTarget.nonce;
      const top =
        target.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      container.scrollTo({ top, behavior: "auto" });
      if (jumpTarget.focusHeader) target.focus({ preventScroll: true });
    }
  }, [jumpTarget, itemPaths, collapsedPaths, expandPath]);

  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <div
        {...review.keyboardProps}
        onClickCapture={gaps.onClickCapture}
        // Pierre's scroller is click-focusable; a click anywhere in the diff
        // lands in the line cursor instead, so arrows and PgUp/PgDn drive it.
        onFocus={(event) => {
          if (review.enabled && event.target === containerRef.current)
            event.currentTarget.focus({ preventScroll: true });
        }}
        onClick={(event) => {
          if (!review.enabled) return;
          const clicked = clickedCodeLine(event.nativeEvent, viewRef.current);
          if (clicked) placeCursor(clicked, false);
        }}
        className="diff-line-cursor-host diff-line-cursor-host--changes flex min-h-0 flex-1 flex-col"
      >
        <div
          ref={overlayRef}
          className="changes-cursor-overlay"
          aria-hidden="true"
        >
          <span className="changes-cursor-bar" hidden />
          <span className="changes-cursor-caret" hidden />
        </div>
        {related.incomplete && (
          <div className="semantic-relations-status" role="status">
            Related symbols are incomplete for this comparison.
          </div>
        )}
        <CodeView
          ref={viewRef}
          containerRef={containerRef}
          className="changes-code-view"
          items={reviewItems}
          options={codeViewOptions}
          selectedLines={selectedLines ?? evidenceSelection}
          onSelectedLinesChange={
            review.enabled
              ? (next) => {
                  const path = next ? (itemPaths.get(next.id) ?? next.id) : "";
                  const range = next ? next.range : null;

                  setDismissedEvidence(jumpTarget?.nonce ?? null);
                  onSelectionChange(path, range);
                }
              : undefined
          }
          renderAnnotation={
            review.enabled || semanticOn || github
              ? (...args: CodeViewAnnotationArgs<ReviewAnnotation>) => {
                  const [annotation, , item] = args;
                  const path = itemPaths.get(item.id) ?? item.id;
                  const label =
                    "side" in annotation && expanded?.id === item.id
                      ? semantic.labelAt(
                          path,
                          annotation.side,
                          annotation.lineNumber
                        )
                      : undefined;
                  const thread =
                    review.enabled && hasReviewContent(annotation.metadata)
                      ? review.renderAnnotation(annotation)
                      : null;
                  const { githubMarker, githubOutdated } = annotation.metadata;
                  const githubThreads = !github
                    ? []
                    : githubOutdated
                      ? (github.model.outdatedByPath.get(path) ?? [])
                      : githubMarker
                        ? (github.model.markerByKey.get(githubMarker)
                            ?.threads ?? [])
                        : [];
                  const openGithub = githubThreads.filter(({ thread }) =>
                    github?.openThreads.has(thread.id)
                  );
                  return (
                    <>
                      {label && label === expanded?.label && (
                        <SemanticLabelRow
                          label={label}
                          onClose={() => {
                            returnFocus.current = { id: item.id, label };
                            setExpanded(null);
                          }}
                          related={linksAt(
                            linksForFile(
                              related.links,
                              path,
                              semantic.fileFor(path)
                            ),
                            label.declarationIndices ?? []
                          )}
                          onRelatedJump={onRelatedJump}
                          onJump={(lineNumber, side) =>
                            viewRef.current?.scrollTo({
                              type: "line",
                              id: path,
                              lineNumber,
                              side,
                              align: "center",
                            })
                          }
                        />
                      )}
                      {thread}
                      {github && openGithub.length > 0 && (
                        <GithubThreadGroup
                          label={
                            githubOutdated
                              ? `Outdated GitHub threads in ${path}`
                              : `GitHub threads on line ${annotation.lineNumber}`
                          }
                          threads={openGithub}
                          focusThreadId={github.focusThreadId}
                          onFocused={github.focused}
                          onClose={closeGithubThread}
                        />
                      )}
                    </>
                  );
                }
              : undefined
          }
          renderCustomHeader={(item) => {
            const path = itemPaths.get(item.id) ?? item.id;
            const collapsed = collapsedPaths.has(path);
            const viewed = viewedPaths.has(path);
            const fileDiff = item.type === "diff" ? item.fileDiff : undefined;
            const semanticView = semantic.viewFor(path);
            return (
              <div
                className="changes-diff-heading"
                data-changes-path={path}
                // pending until this file's semantic result (and its label
                // rows) arrive; lets tests wait for the layout to settle.
                data-semantic={semantic.status(path)}
                {...{ [DIFF_CURSOR_ENTRY_ATTRIBUTE]: path }}
              >
                <button
                  type="button"
                  ref={
                    jumpTarget?.path === path && jumpTarget.focusHeader
                      ? jumpHeader
                      : undefined
                  }
                  className="changes-fold-button"
                  aria-label={`Toggle diff for ${path}`}
                  title={path}
                  aria-expanded={!collapsed}
                  onClick={() => {
                    if (collapsed) {
                      expandPath(path);
                      return;
                    }
                    review.clearInteraction(path);
                    setHandFolds((current) =>
                      new Map(current).set(path, "folded")
                    );
                  }}
                >
                  <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
                  <span className="changes-diff-name">
                    {fileDiff?.prevName && <>{fileDiff.prevName} → </>}
                    {fileDiff?.name ?? path}
                  </span>
                </button>
                <FormattingBadge file={semantic.fileFor(path)} />
                {github &&
                  path === item.id &&
                  (github.model.outdatedByPath.get(path)?.length ?? 0) > 0 && (
                    <OutdatedToggle
                      path={path}
                      count={github.model.outdatedByPath.get(path)!.length}
                      open={github.model.outdatedByPath
                        .get(path)!
                        .some(({ thread }) =>
                          github.openThreads.has(thread.id)
                        )}
                      onToggle={(opener) => {
                        if (collapsedPaths.has(path)) expandPath(path);
                        github.toggleOutdated(path, opener);
                      }}
                    />
                  )}
                {semanticView && (
                  <DeclarationCounts summary={semanticView.summary} />
                )}
                {/* +/− totals live in the summary bar and file list row. */}
                {onViewedChange && (
                  <button
                    type="button"
                    className="changes-viewed-button"
                    aria-pressed={viewed}
                    aria-keyshortcuts="V"
                    title={`${viewed ? "Unmark" : "Mark"} viewed (v)`}
                    onClick={() => {
                      if (!viewed) review.clearInteraction(path);
                      onViewedChange(path, !viewed);
                    }}
                  >
                    {viewed ? "✓ Viewed" : "Viewed"}
                  </button>
                )}
                {renderExternalEditor?.(path)}
                <button
                  type="button"
                  className="changes-open-button"
                  aria-label={`Open ${path}`}
                  title={CHANGES_COMMANDS.diff}
                  onClick={() => onOpen(path)}
                >
                  Open
                </button>
              </div>
            );
          }}
          renderCodeViewHeader={
            fallbacks.length > 0
              ? () => (
                  <div className="changes-fallbacks">
                    {fallbacks.map(({ file, text }) => (
                      <p
                        key={file.path}
                        tabIndex={-1}
                        data-changes-path={file.path}
                        className="changes-file-fallback"
                        {...{ [FALLBACK_ATTRIBUTE]: file.path }}
                      >
                        <span className="font-mono">{file.path}</span>
                        <span>{text}</span>
                      </p>
                    ))}
                  </div>
                )
              : undefined
          }
        />
      </div>
    </WorkerPoolContext.Provider>
  );
}
