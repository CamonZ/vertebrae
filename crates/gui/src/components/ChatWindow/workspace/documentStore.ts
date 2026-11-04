import { create } from "zustand";
import { commands, type FileBody } from "../../../bindings";

export type DocumentView = "file" | "diff";

/** A file side as last read; `error` is a failed command, not a file state. */
export type Body =
  | { kind: "loading" }
  | FileBody
  | { kind: "error"; message: string };

export interface Baseline {
  /** Baseline selection, source path and changes generation it was read for. */
  key: string;
  identity: string;
  body: Body;
}

export interface WorktreeDocument {
  path: string;
  disk: Body;
  /** Unsaved contents; `null` when the editor matches the disk. */
  draft: string | null;
  /** Remounts the editor with the current contents when bumped. */
  seed: number;
  view: DocumentView;
  baseline: Baseline | null;
  /**
   * A save found the disk past the revision this draft was read from.
   * `revision` is the current one, absent when the file is gone or no longer
   * text. Documents are not watched; this is only learned when saving.
   */
  conflict: { revision: string | null } | null;
  saving: boolean;
  saveError: string | null;
  /**
   * Identifies the newest disk read; older results are dropped. Drawn from
   * one sequence so a reopened document never reuses a closed one's token.
   */
  loadToken: number;
}

interface Workspace {
  order: string[];
  active: string | null;
  documents: Record<string, WorktreeDocument>;
}

interface DocumentStore {
  /** Documents are isolated by worktree path, then by file path. */
  workspaces: Record<string, Workspace>;
}

export const useDocumentStore = create<DocumentStore>(() => ({
  workspaces: {},
}));

const EMPTY: Workspace = { order: [], active: null, documents: {} };

let tokenSequence = 0;
const nextToken = () => ++tokenSequence;

export function workspaceOf(worktree: string): Workspace {
  return useDocumentStore.getState().workspaces[worktree] ?? EMPTY;
}

export function documentOf(
  worktree: string,
  path: string
): WorktreeDocument | undefined {
  return workspaceOf(worktree).documents[path];
}

function updateWorkspace(
  worktree: string,
  update: (workspace: Workspace) => Workspace
) {
  useDocumentStore.setState((state) => ({
    workspaces: {
      ...state.workspaces,
      [worktree]: update(state.workspaces[worktree] ?? EMPTY),
    },
  }));
}

/** Update an open document; does nothing once it has been closed. */
function updateDocument(
  worktree: string,
  path: string,
  update: (document: WorktreeDocument) => Partial<WorktreeDocument>
) {
  updateWorkspace(worktree, (workspace) => {
    const document = workspace.documents[path];
    if (!document) return workspace;
    return {
      ...workspace,
      documents: {
        ...workspace.documents,
        [path]: { ...document, ...update(document) },
      },
    };
  });
}

export function isDirty(document: WorktreeDocument | undefined): boolean {
  return document?.draft != null;
}

export function dirtyPaths(worktree: string): string[] {
  const { order, documents } = workspaceOf(worktree);
  return order.filter((path) => isDirty(documents[path]));
}

/** The text the editor shows: the draft, else the disk contents. */
export function currentText(document: WorktreeDocument): string | null {
  if (document.draft != null) return document.draft;
  return document.disk.kind === "text" ? document.disk.contents : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the working copy and reseed the editor. Reads happen on open and on an
 * explicit reload, which first discards the draft.
 */
export async function loadDocument(
  worktree: string,
  path: string
): Promise<void> {
  if (!documentOf(worktree, path)) return;
  const token = nextToken();
  updateDocument(worktree, path, () => ({ loadToken: token }));
  let body: Body;
  try {
    const result = await commands.readWorktreeFile(worktree, path);
    body =
      result.status === "ok"
        ? result.data
        : { kind: "error", message: result.error.message };
  } catch (error) {
    body = { kind: "error", message: message(error) };
  }
  updateDocument(worktree, path, (document) =>
    document.loadToken !== token
      ? {}
      : { disk: body, draft: null, conflict: null, seed: document.seed + 1 }
  );
}

/** Open (or focus) a document; it stays open until explicitly closed. */
export function openDocument(
  worktree: string,
  path: string,
  view: DocumentView
): void {
  const existing = documentOf(worktree, path);
  updateWorkspace(worktree, (workspace) => ({
    order: existing ? workspace.order : [...workspace.order, path],
    active: path,
    documents: existing
      ? workspace.documents
      : {
          ...workspace.documents,
          [path]: {
            path,
            disk: { kind: "loading" },
            draft: null,
            seed: 0,
            view,
            baseline: null,
            conflict: null,
            saving: false,
            saveError: null,
            loadToken: nextToken(),
          },
        },
  }));
  if (!existing) void loadDocument(worktree, path);
  else if (existing.view !== view) setView(worktree, path, view);
}

export function activate(worktree: string, path: string | null): void {
  updateWorkspace(worktree, (workspace) => ({ ...workspace, active: path }));
}

export function closeDocument(worktree: string, path: string): void {
  updateWorkspace(worktree, (workspace) => {
    const order = workspace.order.filter((item) => item !== path);
    const documents = { ...workspace.documents };
    delete documents[path];
    const index = workspace.order.indexOf(path);
    const active =
      workspace.active === path
        ? (order[Math.min(index, order.length - 1)] ?? null)
        : workspace.active;
    return { order, active, documents };
  });
}

/** Drop clean documents, keeping drafts for when the workspace reopens. */
export function releaseCleanDocuments(worktree: string): void {
  for (const path of workspaceOf(worktree).order) {
    if (!isDirty(documentOf(worktree, path))) closeDocument(worktree, path);
  }
}

/** Record editor contents without remounting the editor. */
export function setDraft(worktree: string, path: string, text: string): void {
  updateDocument(worktree, path, (document) => ({
    draft:
      document.disk.kind === "text" && document.disk.contents === text
        ? null
        : text,
    saveError: null,
  }));
}

export function setView(
  worktree: string,
  path: string,
  view: DocumentView
): void {
  updateDocument(worktree, path, (document) =>
    document.view === view ? {} : { view, seed: document.seed + 1 }
  );
}

/** Read the baseline side of a diff once per baseline key. */
export async function loadBaseline(
  worktree: string,
  path: string,
  sourcePath: string,
  commit: string,
  key: string
): Promise<void> {
  const document = documentOf(worktree, path);
  if (!document || document.baseline?.key === key) return;
  const identity = JSON.stringify([commit, sourcePath]);
  const previous =
    document.baseline?.identity === identity
      ? document.baseline.body
      : undefined;
  // Hide the previous side until the requested commit has been read.
  updateDocument(worktree, path, () => ({
    baseline: { key, identity, body: previous ?? { kind: "loading" } },
  }));
  let body: Body;
  try {
    const result = await commands.readWorktreeBaselineFile(
      worktree,
      sourcePath,
      commit
    );
    body =
      result.status === "ok"
        ? result.data
        : { kind: "error", message: result.error.message };
  } catch (error) {
    body = { kind: "error", message: message(error) };
  }
  updateDocument(worktree, path, (current) => {
    if (current.baseline?.key !== key) return {};
    const unchanged =
      previous?.kind === body.kind &&
      (body.kind !== "text" ||
        (previous.kind === "text" && previous.revision === body.revision));
    // Remount the diff editor only when the baseline it shows changed.
    return unchanged
      ? { baseline: { key, identity, body } }
      : { baseline: { key, identity, body }, seed: current.seed + 1 };
  });
}

async function write(
  worktree: string,
  path: string,
  expectedRevision: string
): Promise<boolean> {
  const document = documentOf(worktree, path);
  if (!document || document.saving || document.draft == null) return false;
  const contents = document.draft;
  updateDocument(worktree, path, () => ({ saving: true, saveError: null }));
  try {
    const result = await commands.saveWorktreeFile(
      worktree,
      path,
      contents,
      expectedRevision
    );
    if (result.status === "error") {
      updateDocument(worktree, path, () => ({
        saving: false,
        saveError: result.error.message,
      }));
      return false;
    }
    const outcome = result.data;
    if (outcome.kind === "conflict") {
      updateDocument(worktree, path, () => ({
        saving: false,
        conflict: { revision: outcome.current },
      }));
      return false;
    }
    updateDocument(worktree, path, (current) => ({
      saving: false,
      conflict: null,
      disk: { kind: "text", contents, revision: outcome.revision },
      // A read that started before the save must not restore older contents.
      loadToken: nextToken(),
      // Typing during the save keeps the newer text as the draft.
      draft: current.draft === contents ? null : current.draft,
    }));
    return true;
  } catch (error) {
    updateDocument(worktree, path, () => ({
      saving: false,
      saveError: message(error),
    }));
    return false;
  }
}

/** Save the draft against the revision it was read from. */
export async function saveDocument(
  worktree: string,
  path: string
): Promise<boolean> {
  const document = documentOf(worktree, path);
  if (!document || document.draft == null) return true;
  if (document.conflict) return false;
  if (document.disk.kind !== "text") return false;
  return write(worktree, path, document.disk.revision);
}

/** Explicitly replace a file that changed on disk with the draft. */
export async function overwriteDocument(
  worktree: string,
  path: string
): Promise<boolean> {
  const revision = documentOf(worktree, path)?.conflict?.revision;
  return revision ? write(worktree, path, revision) : false;
}

/** Discard the draft and read the disk again. */
export function reloadDocument(worktree: string, path: string): Promise<void> {
  updateDocument(worktree, path, () => ({
    draft: null,
    conflict: null,
    saveError: null,
  }));
  return loadDocument(worktree, path);
}

export function discardDraft(worktree: string, path: string): void {
  updateDocument(worktree, path, (document) => ({
    draft: null,
    conflict: null,
    saveError: null,
    seed: document.seed + 1,
  }));
}

/** Save several drafts, returning the paths that were not written. */
export async function saveDocuments(
  worktree: string,
  paths: readonly string[]
): Promise<string[]> {
  const saved = await Promise.all(
    paths.map((path) => saveDocument(worktree, path))
  );
  return paths.filter((_, index) => !saved[index]);
}
