import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commands,
  type DirectoryEntry,
  type FileStatus,
} from "../../../bindings";
import { STATUS_LETTER } from "./status";

type Listing =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: DirectoryEntry[]; truncated: boolean };

export interface FilesTreeProps {
  worktreePath: string;
  /** Git status of changed paths against the selected baseline. */
  statuses: ReadonlyMap<string, FileStatus>;
  activePath: string | null;
  /** Bumped when the worktree changed on disk; reloads loaded folders. */
  refreshToken: number;
  onOpen(path: string): void;
}

/** Directories that contain a changed path. */
function changedDirectories(paths: Iterable<string>): Set<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const directory = path.slice(0, slash);
      if (directories.has(directory)) break;
      directories.add(directory);
      slash = directory.lastIndexOf("/");
    }
  }
  return directories;
}

/** A worktree directory tree whose folders load when first expanded. */
export function FilesTree({
  worktreePath,
  statuses,
  activePath,
  refreshToken,
  onOpen,
}: FilesTreeProps) {
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(
    () => new Map()
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // Newest request per folder; older responses and unmounts are dropped.
  const requests = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    (directory: string, background: boolean) => {
      const request = (requests.current.get(directory) ?? 0) + 1;
      requests.current.set(directory, request);
      if (!background) {
        setListings((current) =>
          new Map(current).set(directory, { status: "loading" })
        );
      }
      const apply = (listing: Listing) => {
        if (!mounted.current || requests.current.get(directory) !== request) {
          return;
        }
        setListings((current) => new Map(current).set(directory, listing));
      };
      void commands.listWorktreeDirectory(worktreePath, directory).then(
        (result) =>
          apply(
            result.status === "ok"
              ? {
                  status: "ready",
                  entries: result.data.entries,
                  truncated: result.data.truncated,
                }
              : { status: "error", message: result.error.message }
          ),
        (error: unknown) => apply({ status: "error", message: String(error) })
      );
    },
    [worktreePath]
  );

  useEffect(() => load("", false), [load]);

  // Refresh what is already loaded without collapsing the tree.
  useEffect(() => {
    if (refreshToken === 0) return;
    for (const directory of requests.current.keys()) load(directory, true);
  }, [refreshToken, load]);

  const decorated = useMemo(
    () => changedDirectories(statuses.keys()),
    [statuses]
  );

  const toggle = (path: string) => {
    const open = !expanded.has(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
    if (open && !listings.has(path)) load(path, false);
  };

  const renderListing = (directory: string, depth: number) => {
    const listing = listings.get(directory);
    if (!listing || listing.status === "loading") {
      return (
        <li className="files-tree-note" style={{ paddingLeft: depth * 12 + 8 }}>
          Loading…
        </li>
      );
    }
    if (listing.status === "error") {
      return (
        <li
          role="alert"
          className="files-tree-note"
          style={{ paddingLeft: depth * 12 + 8 }}
        >
          {listing.message}
        </li>
      );
    }
    return (
      <>
        {listing.entries.length === 0 && (
          <li
            className="files-tree-note"
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            Empty folder
          </li>
        )}
        {listing.entries.map((entry) => {
          const isDirectory = entry.kind === "directory";
          const isOpen = expanded.has(entry.path);
          const status = statuses.get(entry.path);
          return (
            <li key={entry.path}>
              <button
                type="button"
                className="files-tree-row"
                style={{ paddingLeft: depth * 12 + 8 }}
                disabled={entry.kind === "other"}
                aria-expanded={isDirectory ? isOpen : undefined}
                aria-current={
                  activePath === entry.path ? "location" : undefined
                }
                title={entry.path}
                onClick={() =>
                  isDirectory ? toggle(entry.path) : onOpen(entry.path)
                }
              >
                <span className="files-tree-twisty" aria-hidden="true">
                  {isDirectory ? (isOpen ? "▾" : "▸") : ""}
                </span>
                <span
                  className={`files-tree-name${
                    status ? ` is-${status}` : ""
                  }${decorated.has(entry.path) ? " has-changes" : ""}`}
                >
                  {entry.name}
                  {entry.symlink && (
                    <span className="files-tree-link">
                      <span aria-hidden="true">{" ↗"}</span>
                      <span className="sr-only"> (symlink)</span>
                    </span>
                  )}
                </span>
                {status && (
                  <span
                    className={`changes-file-status is-${status}`}
                    title={status}
                  >
                    {STATUS_LETTER[status]}
                  </span>
                )}
                {isDirectory && decorated.has(entry.path) && (
                  <span className="files-tree-dot" title="Contains changes">
                    <span className="sr-only">(contains changes)</span>
                  </span>
                )}
              </button>
              {isDirectory && isOpen && (
                <ul>{renderListing(entry.path, depth + 1)}</ul>
              )}
            </li>
          );
        })}
        {listing.truncated && (
          <li
            className="files-tree-note"
            style={{ paddingLeft: depth * 12 + 8 }}
          >
            Only the first {listing.entries.length.toLocaleString()} entries are
            shown.
          </li>
        )}
      </>
    );
  };

  return (
    <nav aria-label="Worktree files" className="changes-files-list">
      <ul>{renderListing("", 0)}</ul>
    </nav>
  );
}
