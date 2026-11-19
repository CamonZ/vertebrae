import type { FileDiffLoadedChangedFiles } from "@pierre/diffs";
import {
  commands,
  type CommandError,
  type ComparisonSnapshot,
  type FileBody,
  type Result,
  type WorktreeChange,
} from "../../../bindings";
import type { FilePatch } from "../../thread/toolChange/diffLineMapper";

function body(result: Result<FileBody, CommandError>): FileBody {
  if (result.status === "error") throw new Error(result.error.message);
  return result.data;
}

/**
 * Both sides of a changed file for the comparison the Changes view shows, so
 * its collapsed unchanged lines can be revealed. Null when a side is not
 * text (binary, too large, missing) or the file was added or deleted, which
 * leaves no unchanged lines to reveal. Rejects when a read fails.
 */
export async function loadChangeContents(
  checkout: string,
  comparison: ComparisonSnapshot,
  change: WorktreeChange
): Promise<FileDiffLoadedChangedFiles | null> {
  if (change.status !== "modified" && change.status !== "renamed") return null;
  const oldPath = change.old_path ?? change.path;
  const [before, after] = await Promise.all([
    commands
      .readWorktreeBaselineFile(checkout, oldPath, comparison.base_commit)
      .then(body),
    (comparison.working_tree
      ? commands.readWorktreeFile(checkout, change.path)
      : commands.readWorktreeBaselineFile(
          checkout,
          change.path,
          comparison.target_commit
        )
    ).then(body),
  ]);
  if (before.kind !== "text" || after.kind !== "text") return null;
  return {
    oldFile: { name: oldPath, contents: before.contents },
    newFile: { name: change.path, contents: after.contents },
  };
}

const lineAt = (lines: readonly string[], line: number) =>
  lines[line - 1]?.replace(/\r?\n$/, "");

/**
 * Whether loaded contents are the files the patch was made from: every
 * patch row reads the same on its side. A working tree edited after the
 * patch was computed fails this until the patch refreshes.
 */
export function contentsMatchPatch(
  file: FilePatch,
  oldLines: readonly string[],
  newLines: readonly string[]
): boolean {
  return file.hunks.every((hunk) =>
    hunk.rows.every(
      (row) =>
        (row.oldLine === null || lineAt(oldLines, row.oldLine) === row.text) &&
        (row.newLine === null || lineAt(newLines, row.newLine) === row.text)
    )
  );
}
