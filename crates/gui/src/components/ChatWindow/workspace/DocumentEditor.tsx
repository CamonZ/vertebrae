import {
  FULL_FILE_SELECTION_LABEL,
  useFullFileDiscussion,
} from "./useFullFileDiscussion";
import type { FullFileSource } from "../selectionDiscussions";
import type { ReviewAnnotation } from "../../thread/toolChange/DiffCommentThread";
import type { DiffPreferences } from "../../../utils/codeAppearance";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DIFFS_TAG_NAME,
  parseDiffFromFile,
  type FileContents,
} from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import {
  EditProvider,
  File,
  FileDiff,
  WorkerPoolContext,
  type EditorFactory,
} from "@pierre/diffs/react";
import {
  usePierreDiffOptions,
  usePierreThemeOptions,
} from "../../../hooks/useCodeAppearance";
import { DIFF_CURSOR_HOST_ATTRIBUTE } from "../../thread/toolChange/diffCursor";
import { diffWorkerPool } from "../../thread/toolChange/diffWorkerPool";

const acceptEdit = () => "accept" as const;

const createEditor: EditorFactory<ReviewAnnotation, undefined> = (
  type,
  options,
  editStateKey
) => new Editor(type, options, editStateKey);

export interface DocumentEditorProps {
  path: string;
  view: "file" | "diff";
  /** Working contents at mount; `null` for a deleted file's diff. */
  contents: string | null;
  /** Baseline contents for the diff; `null` when the file is new. */
  baseline: string | null;
  onChange(text: string): void;
  readOnly?: boolean;
  discussionSource?: FullFileSource;
  focusCursor?(cursor: HTMLElement): void;
  displayedText?: string | null;
  dirty?: boolean;
  diffStyle?: DiffPreferences["diffStyle"];
  /**
   * File view only: lines to select, and to scroll to once rendered unless
   * already `scrolled`.
   */
  reveal?: {
    line: number;
    endLine: number;
    nonce: number;
    scrolled: boolean;
  } | null;
  /** Called once the revealed lines were scrolled into view. */
  onRevealed?(): void;
}

/** Scroll the document viewport without shifting the file under its gutter. */
function scrollDocumentLine(
  host: HTMLElement | null,
  lineNumber: number,
  align: "center" | "nearest"
): boolean {
  const viewport =
    host?.querySelector<HTMLElement>(".document-file-scroll") ??
    host?.closest<HTMLElement>(".document-body");
  const file = host?.querySelector(DIFFS_TAG_NAME);
  const selector = `[data-line="${lineNumber}"]`;
  const row =
    file?.shadowRoot?.querySelector(selector) ?? file?.querySelector(selector);
  if (!row || !viewport) return false;
  if (align === "center" && viewport.scrollHeight <= viewport.clientHeight) {
    row.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }

  const line = row.getBoundingClientRect();
  const top = viewport.getBoundingClientRect().top + viewport.clientTop;
  const bottom = top + viewport.clientHeight;
  if (align === "center")
    viewport.scrollTop += (line.top + line.bottom - top - bottom) / 2;
  else if (line.top < top) viewport.scrollTop += line.top - top;
  else if (line.bottom > bottom) viewport.scrollTop += line.bottom - bottom;
  return true;
}

/** How long to wait for a large file's lines to render before giving up. */
const REVEAL_TIMEOUT_MS = 15_000;

/**
 * Edit one document as a full file or as a diff against its complete
 * baseline. The parent remounts this component to apply new contents, so
 * the editor's own document is never fed back while it is being edited.
 * Loaded lazily so Pierre stays out of the main chunk.
 */
export default function DocumentEditor({
  path,
  view,
  contents,
  baseline,
  onChange,
  readOnly = false,
  discussionSource,
  focusCursor,
  displayedText,
  dirty = false,
  diffStyle,
  reveal,
  onRevealed,
}: DocumentEditorProps): ReactNode {
  const fileOptions = usePierreThemeOptions();
  const preferences = usePierreDiffOptions();
  const diffOptions = useMemo(
    () => ({ ...preferences, ...(diffStyle ? { diffStyle } : {}) }),
    [preferences, diffStyle]
  );

  // Captured at mount: later prop changes arrive through a remount.
  const [[file, fileDiff]] = useState(() => {
    const working: FileContents | null =
      contents == null ? null : { name: path, contents };
    if (view === "file") return [working, null] as const;
    const old: FileContents | null =
      baseline == null ? null : { name: path, contents: baseline };
    return [working, parseDiffFromFile(old, working)] as const;
  });

  const editChange = useRef(onChange);
  editChange.current = onChange;
  const onEditChange = useCallback((event: { file: FileContents }) => {
    editChange.current(event.file.contents);
  }, []);
  const hostRef = useRef<HTMLDivElement>(null);
  const revealLine = reveal?.line;
  const revealEnd = reveal?.endLine;
  const revealNonce = reveal?.nonce;
  const revealPending = reveal != null && !reveal.scrolled;
  const onRevealedRef = useRef(onRevealed);
  onRevealedRef.current = onRevealed;
  const selectedLines = useMemo(
    () =>
      revealLine === undefined || revealEnd === undefined
        ? null
        : { start: revealLine, end: revealEnd },
    [revealLine, revealEnd]
  );

  const cursorScrollFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(cursorScrollFrame.current), []);

  const discussion = useFullFileDiscussion(
    discussionSource,
    path,
    displayedText ?? contents,
    selectedLines,
    dirty,
    (line) => {
      cancelAnimationFrame(cursorScrollFrame.current);
      // Follow the keyboard selection after Pierre applies the new range.
      cursorScrollFrame.current = requestAnimationFrame(() => {
        scrollDocumentLine(hostRef.current, line, "nearest");
      });
    }
  );
  useLayoutEffect(() => {
    if (discussion.enabled && hostRef.current) focusCursor?.(hostRef.current);
  }, [discussion.enabled, focusCursor]);

  const discussionFocus = discussion.focus;
  const setHost = useCallback(
    (node: HTMLDivElement | null) => {
      hostRef.current = node;
      discussionFocus.current = node;
    },
    [discussionFocus]
  );
  const fullFileOptions = discussion.enabled
    ? {
        ...fileOptions,
        ...discussion.options,
        unsafeCSS: `${fileOptions.unsafeCSS ?? ""}\n${discussion.annotationCSS}`,
      }
    : fileOptions;

  // Pierre renders lines asynchronously into its shadow root; scroll once the
  // first revealed line exists. A remount after the scroll (a save, a view
  // change) keeps the selection without scrolling back.
  useEffect(() => {
    if (!revealPending || revealLine === undefined || view !== "file") return;
    let frame = 0;
    const deadline = performance.now() + REVEAL_TIMEOUT_MS;
    const scroll = () => {
      if (scrollDocumentLine(hostRef.current, revealLine, "center")) {
        onRevealedRef.current?.();
      } else if (performance.now() < deadline)
        frame = requestAnimationFrame(scroll);
    };
    scroll();
    return () => cancelAnimationFrame(frame);
  }, [view, revealPending, revealLine, revealNonce]);

  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <EditProvider createEditor={createEditor}>
        {fileDiff ? (
          <FileDiff
            fileDiff={fileDiff}
            options={diffOptions}
            edit={!readOnly && file != null}
            onEditChange={onEditChange}
            onEditComplete={acceptEdit}
          />
        ) : file ? (
          <div
            ref={setHost}
            className={
              discussion.enabled
                ? "diff-line-cursor-host diff-line-cursor-host--changes flex min-h-0 flex-1 flex-col"
                : "contents"
            }
            data-focus-halo={discussion.enabled ? "overlay" : undefined}
            tabIndex={discussion.enabled ? 0 : undefined}
            role={discussion.enabled ? "group" : undefined}
            {...{
              [DIFF_CURSOR_HOST_ATTRIBUTE]: discussion.enabled
                ? "file"
                : undefined,
            }}
            aria-label={
              discussion.enabled ? FULL_FILE_SELECTION_LABEL : undefined
            }
            onKeyDown={discussion.onKeyDown}
          >
            {discussion.reason && <p role="alert">{discussion.reason}</p>}
            <div
              className={
                discussion.enabled ? "document-file-scroll" : "contents"
              }
            >
              <File
                file={file}
                options={fullFileOptions}
                selectedLines={discussion.range}
                lineAnnotations={
                  discussion.enabled ? discussion.annotations : undefined
                }
                renderAnnotation={
                  discussion.enabled ? discussion.renderAnnotation : undefined
                }
                edit={!readOnly}
                onEditChange={onEditChange}
                onEditComplete={acceptEdit}
              />
            </div>
          </div>
        ) : null}
      </EditProvider>
    </WorkerPoolContext.Provider>
  );
}
