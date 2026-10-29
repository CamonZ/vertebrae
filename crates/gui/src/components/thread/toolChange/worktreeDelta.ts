/**
 * Validation and summarisation of the opaque `worktree_delta` annotation
 * payload recorded by the backend (see `local_chat/worktree_delta`).
 */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export type MarkerReason =
  | "binary"
  | "too_large"
  | "baseline_unavailable"
  | "patch_limit"
  | "unreadable";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  marker?: MarkerReason;
  /** Hunk-derived counts; absent when the patch does not cover this file. */
  additions?: number;
  deletions?: number;
}

export interface WorktreeDelta {
  patch: string;
  files: ChangedFile[];
  aggregate: boolean;
  overlapping: boolean;
}

const STATUSES: readonly string[] = ["added", "modified", "deleted", "renamed"];
const MARKERS: readonly string[] = [
  "binary",
  "too_large",
  "baseline_unavailable",
  "patch_limit",
  "unreadable",
];

export const MARKER_TEXT: Record<MarkerReason, string> = {
  binary: "Binary file — diff not shown",
  too_large: "File too large — diff not shown",
  baseline_unavailable: "Baseline unavailable — diff not shown",
  patch_limit: "Patch size limit reached — diff not shown",
  unreadable: "File unreadable — diff not shown",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Per-file +/- counts keyed by new path; headers and hunk markers excluded. */
export function countPatchLines(
  patch: string
): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>();
  let current: { additions: number; deletions: number } | null = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { additions: 0, deletions: 0 };
      inHunk = false;
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m) counts.set(m[2], current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith("+")) current.additions += 1;
      else if (line.startsWith("-")) current.deletions += 1;
    }
  }
  return counts;
}

/**
 * Validate an annotation payload. Returns null when it is not a usable
 * worktree delta, and null when nothing changed (no files, no patch).
 */
export function parseWorktreeDelta(payload: unknown): WorktreeDelta | null {
  if (!isRecord(payload) || !Array.isArray(payload.files)) return null;
  const patch = typeof payload.patch === "string" ? payload.patch : "";
  const counts = countPatchLines(patch);
  const files: ChangedFile[] = [];
  for (const raw of payload.files) {
    if (!isRecord(raw)) return null;
    if (typeof raw.path !== "string" || raw.path.length === 0) return null;
    if (typeof raw.status !== "string" || !STATUSES.includes(raw.status)) {
      return null;
    }
    const file: ChangedFile = {
      path: raw.path,
      status: raw.status as ChangeStatus,
    };
    if (typeof raw.old_path === "string" && raw.old_path.length > 0) {
      file.oldPath = raw.old_path;
    }
    if (raw.marker !== undefined && raw.marker !== null) {
      if (!isRecord(raw.marker)) return null;
      const reason = raw.marker.reason;
      if (typeof reason !== "string" || !MARKERS.includes(reason)) return null;
      file.marker = reason as MarkerReason;
    }
    const c = counts.get(file.path);
    if (c && !file.marker) {
      file.additions = c.additions;
      file.deletions = c.deletions;
    }
    files.push(file);
  }
  if (files.length === 0 && patch.trim().length === 0) return null;
  return {
    patch,
    files,
    aggregate: payload.aggregate === true,
    overlapping: payload.overlapping === true,
  };
}
