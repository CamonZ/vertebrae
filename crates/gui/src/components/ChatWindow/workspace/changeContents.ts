import {
  commands,
  type ChangeSides,
  type ComparisonSnapshot,
  type WorktreeChange,
} from "../../../bindings";
import type { FilePatch } from "../../thread/toolChange/diffLineMapper";

/**
 * Both sides of a changed file for the comparison the Changes view shows,
 * and in semantic mode their semantic diff (computed in Rust from the same
 * two texts). Rejects when a read fails.
 */
export async function loadChangeSides(
  checkout: string,
  comparison: ComparisonSnapshot,
  change: WorktreeChange,
  semantic: boolean
): Promise<ChangeSides> {
  const result = await commands.loadChangeSides(
    checkout,
    comparison,
    change.path,
    change.old_path,
    semantic
  );
  if (result.status === "error") throw new Error(result.error.message);
  return result.data;
}

export async function loadChangedSymbols(
  checkout: string,
  comparison: ComparisonSnapshot,
  files: readonly WorktreeChange[]
) {
  const result = await commands.compareChangedSymbols(
    checkout,
    comparison,
    files.map(({ path, old_path }) => ({ path, old_path }))
  );
  if (result.status === "error") throw new Error(result.error.kind);
  return result.data;
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
