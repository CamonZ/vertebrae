import type { DiffPreferences } from "../../../utils/codeAppearance";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { diffWorkerPool } from "../../thread/toolChange/diffWorkerPool";

const createEditor: EditorFactory<undefined, undefined> = (
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

/**
 * Centre a line in its nearest vertical scroller. Not `scrollIntoView`: on
 * a line wider than the view it also scrolls the code sideways, under the
 * sticky gutter. Without a scrolling ancestor the document scrolls.
 */
function scrollVerticallyIntoView(row: Element) {
  for (let node: Element | null = row; node; ) {
    const root = node.getRootNode();
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    if (!node) {
      row.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      const line = row.getBoundingClientRect();
      const view = node.getBoundingClientRect();
      node.scrollTop +=
        line.top - view.top - (node.clientHeight - line.height) / 2;
      return;
    }
  }
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

  // Pierre renders lines asynchronously into its shadow root; scroll once the
  // first revealed line exists. A remount after the scroll (a save, a view
  // change) keeps the selection without scrolling back.
  useEffect(() => {
    if (!revealPending || revealLine === undefined || view !== "file") return;
    let frame = 0;
    const deadline = performance.now() + REVEAL_TIMEOUT_MS;
    const scroll = () => {
      const container = hostRef.current?.querySelector(DIFFS_TAG_NAME);
      const selector = `[data-line="${revealLine}"]`;
      const row =
        container?.shadowRoot?.querySelector(selector) ??
        container?.querySelector(selector);
      if (row) {
        scrollVerticallyIntoView(row);
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
            onEditChange={(event) => onChange(event.file.contents)}
            onEditComplete={() => "accept"}
          />
        ) : file ? (
          <div ref={hostRef} style={{ display: "contents" }}>
            <File
              file={file}
              options={fileOptions}
              selectedLines={selectedLines}
              edit={!readOnly}
              onEditChange={(event) => onChange(event.file.contents)}
              onEditComplete={() => "accept"}
            />
          </div>
        ) : null}
      </EditProvider>
    </WorkerPoolContext.Provider>
  );
}
