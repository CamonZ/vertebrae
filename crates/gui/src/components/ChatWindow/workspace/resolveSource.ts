import {
  commands,
  type CommandError,
  type FileBody,
  type FileStatus,
  type Result,
} from "../../../bindings";
import type { SourceLocation } from "../../shared/EvidenceNavigationContext";

/** What a flow's code evidence shows once read from the checkout. */
export type ResolvedSource =
  | { kind: "file"; path: string; contents: string; note?: string }
  | {
      kind: "diff";
      path: string;
      oldPath: string;
      status: FileStatus;
      /** `null` when the file does not exist on that side. */
      before: string | null;
      after: string | null;
      /** The compared revisions, for display. */
      label: string;
    }
  | { kind: "unavailable"; message: string };

const WORKING_TREE = "the working tree";

/** Abbreviates object ids; branch and tag names stay readable. */
export const shortRevision = (revision: string) =>
  /^[0-9a-f]{12,40}$/i.test(revision) ? revision.slice(0, 8) : revision;

const branchName = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

function body(result: Result<FileBody, CommandError>): FileBody {
  if (result.status === "error") throw new Error(result.error.message);
  return result.data;
}

const readWorking = async (checkout: string, path: string) =>
  body(await commands.readWorktreeFile(checkout, path));

const readAt = async (checkout: string, path: string, revision: string) =>
  body(await commands.readWorktreeBaselineFile(checkout, path, revision));

/** A message for contents that cannot be shown, or `null` for text/missing. */
function problem(file: FileBody, path: string, where: string): string | null {
  switch (file.kind) {
    case "binary":
      return `${path} is binary at ${where} and cannot be shown.`;
    case "too_large":
      return `${path} at ${where} is too large to show.`;
    case "unreadable":
      return file.message;
    default:
      return null;
  }
}

const text = (file: FileBody) => (file.kind === "text" ? file.contents : null);

/** Two revisions of one file as a diff, or why they cannot be compared. */
function compare(
  path: string,
  oldPath: string,
  before: FileBody,
  after: FileBody,
  from: string,
  to: string,
  status?: FileStatus
): ResolvedSource {
  const reason =
    problem(before, oldPath, from) ?? problem(after, path, to) ?? null;
  if (reason) return { kind: "unavailable", message: reason };
  const old = text(before);
  const next = text(after);
  if (old == null && next == null)
    return {
      kind: "unavailable",
      message: `${path} does not exist at ${from} or ${to}.`,
    };
  if (old != null && old === next && oldPath === path)
    return {
      kind: "file",
      path,
      contents: old,
      note: `${path} is unchanged between ${from} and ${to}.`,
    };
  return {
    kind: "diff",
    path,
    oldPath,
    status:
      status ?? (old == null ? "added" : next == null ? "deleted" : "modified"),
    before: old,
    after: next,
    label: `${from} → ${to}`,
  };
}

/**
 * Reads the evidence a location points at. A `base` compares that revision
 * with `head` (or the working copy); otherwise the working copy is shown,
 * as a diff when the file has changes against the Changes view's default
 * comparison.
 */
export async function resolveSource(
  checkout: string,
  location: SourceLocation
): Promise<ResolvedSource> {
  const { path, base, head } = location;

  if (base !== undefined) {
    const [before, after] = await Promise.all([
      readAt(checkout, path, base),
      head !== undefined
        ? readAt(checkout, path, head)
        : readWorking(checkout, path),
    ]);
    return compare(
      path,
      path,
      before,
      after,
      shortRevision(base),
      head !== undefined ? shortRevision(head) : WORKING_TREE
    );
  }

  // Without a known change the file is still worth showing.
  const changes = await commands
    .loadWorktreeChanges(checkout, {
      base: null,
      target: { kind: "working_tree" },
      merge_base: true,
    })
    .catch(() => null);
  const data = changes?.status === "ok" ? changes.data : null;
  const change = data?.files.find(
    (file) =>
      file.marker == null && (file.path === path || file.old_path === path)
  );

  if (data && change) {
    const oldPath = change.old_path ?? change.path;
    const missing: FileBody = { kind: "missing" };
    const [before, after] = await Promise.all([
      change.status === "added"
        ? missing
        : readAt(checkout, oldPath, data.comparison.base_commit),
      change.status === "deleted"
        ? missing
        : readWorking(checkout, change.path),
    ]);
    const from = data.base_branch
      ? branchName(data.base_branch)
      : shortRevision(data.comparison.base_commit);
    return compare(
      change.path,
      oldPath,
      before,
      after,
      from,
      WORKING_TREE,
      change.status
    );
  }

  const working = await readWorking(checkout, path);
  if (working.kind === "text")
    return { kind: "file", path, contents: working.contents };
  return {
    kind: "unavailable",
    message:
      problem(working, path, WORKING_TREE) ??
      `${path} does not exist in this checkout.`,
  };
}
