import {
  commands,
  type CommandError,
  type FileBody,
  type FileStatus,
  type Result,
} from "../../../bindings";

export type SourceRevision =
  | { kind: "commit"; commit: string }
  | { kind: "range"; base: string; head?: string };

/** What source evidence shows once read from the checkout. */
export type ResolvedSource =
  | { kind: "file"; path: string; contents: string; note?: string }
  | {
      kind: "diff";
      path: string;
      status: FileStatus;
      /** `null` when the file does not exist on that side. */
      before: string | null;
      after: string | null;
      /** The compared revisions, for display. */
      label: string;
    }
  | { kind: "unavailable"; message: string; retryable?: boolean };

const WORKING_TREE = "the working tree";

/** Abbreviates object ids; branch and tag names stay readable. */
export const shortRevision = (revision: string) =>
  /^[0-9a-f]{12,40}$/i.test(revision) ? revision.slice(0, 8) : revision;

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
  before: FileBody,
  after: FileBody,
  from: string,
  to: string
): ResolvedSource {
  const reason =
    problem(before, path, from) ?? problem(after, path, to) ?? null;
  if (reason) return { kind: "unavailable", message: reason };
  const old = text(before);
  const next = text(after);
  if (old == null && next == null)
    return {
      kind: "unavailable",
      message: `${path} does not exist at ${from} or ${to}.`,
    };
  if (old != null && old === next)
    return {
      kind: "file",
      path,
      contents: old,
      note: `${path} is unchanged between ${from} and ${to}.`,
    };
  return {
    kind: "diff",
    path,
    status: old == null ? "added" : next == null ? "deleted" : "modified",
    before: old,
    after: next,
    label: `${from} → ${to}`,
  };
}

/** Read an exact path at an explicit commit or compare its two revisions. */
export async function resolveSource(
  checkout: string,
  path: string,
  revision: SourceRevision
): Promise<ResolvedSource> {
  if (revision.kind === "commit") {
    const file = await readAt(checkout, path, revision.commit);
    if (file.kind === "text")
      return { kind: "file", path, contents: file.contents };
    const commit = shortRevision(revision.commit);
    return {
      kind: "unavailable",
      message:
        problem(file, path, commit) ?? `${path} does not exist at ${commit}.`,
    };
  }

  const { base, head } = revision;
  const [before, after] = await Promise.all([
    readAt(checkout, path, base),
    head !== undefined
      ? readAt(checkout, path, head)
      : readWorking(checkout, path),
  ]);
  return compare(
    path,
    before,
    after,
    shortRevision(base),
    head !== undefined ? shortRevision(head) : WORKING_TREE
  );
}
