import type { FileDiffLoadedChangedFiles } from "@pierre/diffs";
import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ChangeSides,
  FallbackReason,
  FileBody,
  WorktreeChange,
} from "../../../bindings";
import type { FilePatch } from "../../thread/toolChange/diffLineMapper";
import { contentsMatchPatch } from "./changeContents";
import { semanticHunks, type SemanticHunks } from "./semanticHunks";

/**
 * Why a file keeps the line diff in semantic mode: the engine's reason, the
 * request failed, or the sides read no longer match the patch (the working
 * tree changed since; a refreshed patch reloads).
 */
export type LineDiffReason = FallbackReason | "request_failed" | "stale";

export type SemanticFile =
  | { status: "semantic"; view: SemanticHunks; oldRevision: string | null; newRevision: string | null }
  | { status: "fallback"; reason: LineDiffReason; message?: string };

export interface ChangeFile {
  /** Both sides, for revealing unchanged lines; null when they cannot be. */
  contents: FileDiffLoadedChangedFiles | null;
  /** The semantic view or why there is none; null in line mode. */
  semantic: SemanticFile | null;
}

/** Reads both sides of a change, plus their semantic diff when asked. */
export type LoadSides = (
  change: WorktreeChange,
  semantic: boolean
) => Promise<ChangeSides>;

interface Entry {
  /** What the file was loaded for; a refreshed patch or mode reloads. */
  patch: string;
  semantic: boolean;
  revealContext: boolean;
  file: ChangeFile;
}

export interface ChangeFiles {
  /** Load a file once per patch and mode (no-op without a loader). */
  request(path: string): void;
  /** The file loaded for its current patch and mode; null until then. */
  fileFor(path: string): ChangeFile | null;
}

const text = (body: FileBody): string | null =>
  body.kind === "text" ? body.contents : body.kind === "missing" ? "" : null;

/**
 * One file's loaded state, checked against its patch: contents and the
 * semantic diff were computed from the same two texts, so if those match
 * the patch, so does the diff built on it.
 */
export function changeFile(
  change: WorktreeChange,
  patch: FilePatch | undefined,
  sides: ChangeSides,
  semantic: boolean,
  revealContext: boolean
): ChangeFile {
  const [before, after] = [text(sides.old), text(sides.new)];
  const fresh =
    patch !== undefined &&
    (before === null ||
      after === null ||
      contentsMatchPatch(patch, before.split("\n"), after.split("\n")));
  const both = sides.old.kind === "text" && sides.new.kind === "text";
  const contents =
    fresh &&
    both &&
    (change.status === "modified" || change.status === "renamed")
      ? {
          oldFile: { name: change.old_path ?? change.path, contents: before! },
          newFile: { name: change.path, contents: after! },
        }
      : null;
  const outcome = sides.semantic;
  if (!semantic) return { contents, semantic: null };
  if (!fresh || !patch || !outcome)
    return { contents, semantic: { status: "fallback", reason: "stale" } };
  return {
    contents,
    semantic:
      outcome.status === "semantic"
        ? {
            status: "semantic",
            oldRevision: sides.old.kind === "text" ? sides.old.revision : null,
            newRevision: sides.new.kind === "text" ? sides.new.revision : null,
            view: semanticHunks(patch, outcome.declarations, revealContext && contents !== null),
          }
        : { status: "fallback", reason: outcome.reason },
  };
}

/**
 * Per-file sides (and semantic views) for the Changes view, requested as
 * files render so large comparisons only read what is looked at. State
 * resets with the view (keyed by comparison and mode); results for a
 * superseded patch are dropped.
 */
export function useChangeFiles(
  changes: ReadonlyMap<string, WorktreeChange>,
  patches: ReadonlyMap<string, FilePatch>,
  load: LoadSides | undefined,
  semantic: boolean,
  revealContext: boolean
): ChangeFiles {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Entry>>(new Map());
  const requested = useRef(new Map<string, Omit<Entry, "file">>());
  const inputs = useRef({ changes, patches, load, semantic, revealContext });
  inputs.current = { changes, patches, load, semantic, revealContext };

  const request = useCallback((path: string) => {
    const { changes, patches, load, semantic, revealContext } = inputs.current;
    const change = changes.get(path);
    if (!load || !change) return;
    const key = { patch: change.patch, semantic, revealContext };
    const latest = () => requested.current.get(path);
    if (latest()?.patch === key.patch && latest()?.semantic === semantic && latest()?.revealContext === revealContext)
      return;
    requested.current.set(path, key);
    const store = (file: ChangeFile) => {
      // A newer patch or mode for this path supersedes this read.
      if (latest() !== key) return;
      setLoaded((current) => new Map(current).set(path, { ...key, file }));
    };
    load(change, semantic).then(
      (sides) => store(changeFile(change, patches.get(path), sides, semantic, revealContext)),
      (error: unknown) => {
        console.error("Could not load", path, error);
        const message = String(error);
        store({
          contents: null,
          semantic: semantic
            ? { status: "fallback", reason: "request_failed", message }
            : null,
        });
      }
    );
  }, []);

  const fileFor = useCallback(
    (path: string): ChangeFile | null => {
      const entry = loaded.get(path);
      return entry &&
        entry.patch === changes.get(path)?.patch &&
        entry.semantic === semantic &&
        entry.revealContext === revealContext
        ? entry.file
        : null;
    },
    [loaded, changes, semantic, revealContext]
  );

  return useMemo(() => ({ request, fileFor }), [request, fileFor]);
}
