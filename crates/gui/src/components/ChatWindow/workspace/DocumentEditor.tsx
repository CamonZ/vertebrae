import type { DiffPreferences } from "../../../utils/codeAppearance";
import { useMemo, useState, type ReactNode } from "react";
import { parseDiffFromFile, type FileContents } from "@pierre/diffs";
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
}

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
          <File
            file={file}
            options={fileOptions}
            edit={!readOnly}
            onEditChange={(event) => onChange(event.file.contents)}
            onEditComplete={() => "accept"}
          />
        ) : null}
      </EditProvider>
    </WorkerPoolContext.Provider>
  );
}
