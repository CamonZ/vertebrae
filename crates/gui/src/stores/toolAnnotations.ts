/**
 * Pure helpers for Vertebrae-owned tool-call annotations.
 *
 * The backend keeps one metadata transcript per persistent chat session; the
 * chat store joins its entries to replayed and live messages by provider
 * tool-call id. `kind` and `payload` stay opaque here: unknown kinds are kept
 * and simply not consumed by any renderer.
 */

import type { LocalChatAnnotation } from "../bindings";

/** Annotations of one session keyed by provider tool-call id, then kind. */
export type ToolAnnotations = Record<
  string,
  Record<string, LocalChatAnnotation>
>;

let nextAnnotationLoadToken = 0;

/** Unique token for one annotation load; stale results are ignored. */
export function toolAnnotationLoadToken(): number {
  nextAnnotationLoadToken += 1;
  return nextAnnotationLoadToken;
}

/**
 * Add `entries` in order onto `base`, so a repeated `(tool_id, kind)` resolves
 * to the last entry. Entries recorded for another session are ignored.
 */
export function mergeToolAnnotations(
  sessionId: string,
  base: ToolAnnotations | undefined,
  entries: readonly LocalChatAnnotation[]
): ToolAnnotations {
  const merged: ToolAnnotations = { ...base };
  for (const entry of entries) {
    if (entry.session_id !== sessionId) continue;
    merged[entry.tool_id] = { ...merged[entry.tool_id], [entry.kind]: entry };
  }
  return merged;
}

/** Every entry of a session's annotation map, one per `(tool_id, kind)`. */
export function toolAnnotationEntries(
  annotations: ToolAnnotations | undefined
): LocalChatAnnotation[] {
  return Object.values(annotations ?? {}).flatMap((byKind) =>
    Object.values(byKind)
  );
}
