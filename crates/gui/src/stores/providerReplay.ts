/**
 * Pure state transitions for progressive provider transcript replay.
 *
 * The chat store owns orchestration (calling the Tauri command, guarding
 * generations); this module owns the replay bookkeeping so every transition
 * is a pure function that can be unit-tested without the store.
 */

import type { LoadLocalChatSessionReplayOutput } from "../bindings";
import type { ChatMessage } from "./chatStore";

/** Runtime-only progressive provider transcript replay state. */
export interface ProviderReplayState {
  /** Unique hydration generation; stale requests from a prior reopen are ignored. */
  generation: number;
  /** Runtime-only normalized event lines loaded so far, oldest first. */
  lines: string[];
  /** Opaque provider transcript revision shared by every loaded page. */
  cacheKey: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  loading: "initial" | "older" | null;
  /** Whether at least one valid page (including an empty transcript) loaded. */
  loaded: boolean;
  error: string | null;
  /** Last replay-projected prefix, used to retain later live enrichments. */
  installedMessages: ChatMessage[];
  seenCursors: string[];
}

/** A validated replay page plus the page lines filtered to strings. */
export interface ReplayPageResult {
  cacheKey: string | null;
  events: string[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function initialProviderReplayState(
  generation: number
): ProviderReplayState {
  return {
    generation,
    lines: [],
    cacheKey: null,
    nextCursor: null,
    hasMore: false,
    loading: "initial",
    loaded: false,
    error: null,
    installedMessages: [],
    seenCursors: [],
  };
}

/** Human-readable message for an unknown replay command failure shape. */
export function providerReplayErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Provider transcript history is temporarily unavailable.";
}

/**
 * Structural validation for one replay page. The Tauri boundary is typed but
 * untrusted (older builds, mocked tests): reject malformed paging metadata
 * instead of corrupting session state.
 */
export function isValidReplayPage(
  page: unknown
): page is LoadLocalChatSessionReplayOutput {
  if (typeof page !== "object" || page === null) return false;
  const candidate = page as Partial<LoadLocalChatSessionReplayOutput>;
  return (
    Array.isArray(candidate.events) &&
    candidate.events.every((line) => typeof line === "string") &&
    typeof candidate.has_more === "boolean" &&
    (candidate.cache_key === null || typeof candidate.cache_key === "string") &&
    (candidate.next_cursor === null ||
      typeof candidate.next_cursor === "string") &&
    (candidate.events.length === 0 ||
      (typeof candidate.cache_key === "string" &&
        candidate.cache_key.length > 0)) &&
    (!candidate.has_more ||
      (typeof candidate.cache_key === "string" &&
        candidate.cache_key.length > 0 &&
        typeof candidate.next_cursor === "string" &&
        candidate.next_cursor.length > 0))
  );
}

/**
 * Apply the initial (newest) page: install the projected history and record
 * paging state. A `null` cache key means the transcript was not found; the
 * session stays unloaded but not errored.
 */
export function applyInitialPage(
  replay: ProviderReplayState,
  page: ReplayPageResult,
  merged: { messages: ChatMessage[]; installedMessageCount: number }
): ProviderReplayState {
  return {
    ...replay,
    lines: page.events,
    cacheKey: page.cacheKey,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    loading: null,
    loaded: page.cacheKey !== null,
    error: null,
    installedMessages: merged.messages.slice(0, merged.installedMessageCount),
    seenCursors: page.nextCursor ? [page.nextCursor] : [],
  };
}

/** Mark a failed load, keeping any already-loaded pages intact. */
export function failReplay(
  replay: ProviderReplayState,
  error: string
): ProviderReplayState {
  return { ...replay, loading: null, error };
}

/**
 * Result of applying an older page: either the next replay state plus the
 * merged session messages, or a terminal failure that stops further paging.
 */
export type OlderPageOutcome =
  | {
      status: "applied";
      replay: ProviderReplayState;
      messages: ChatMessage[];
      installedMessageCount: number;
    }
  | { status: "rejected"; replay: ProviderReplayState };

/**
 * Apply one older page. Re-projecting the accumulated lines is required:
 * `parseSessionLogs` is stateful across lines (delta merging, tool-pair and
 * file-edit pairing), so a page boundary is not a projection boundary.
 *
 * Rejections are terminal for this generation: a changed cache key means the
 * transcript revision moved, and a repeated cursor means paging would loop.
 */
export function applyOlderPage(
  replay: ProviderReplayState,
  page: ReplayPageResult,
  reproject: (lines: string[]) => ChatMessage[]
): OlderPageOutcome {
  if (page.cacheKey !== replay.cacheKey) {
    return {
      status: "rejected",
      replay: failReplay(
        { ...replay, nextCursor: null, hasMore: false },
        "Provider transcript changed while older history was loading."
      ),
    };
  }
  const nextCursor = page.hasMore ? page.nextCursor : null;
  if (
    nextCursor &&
    (nextCursor === replay.nextCursor ||
      replay.seenCursors.includes(nextCursor))
  ) {
    return {
      status: "rejected",
      replay: failReplay(
        { ...replay, nextCursor: null, hasMore: false },
        "Provider transcript returned a repeated page cursor."
      ),
    };
  }
  const lines = [...page.events, ...replay.lines];
  const projected = reproject(lines);
  return {
    status: "applied",
    replay: {
      ...replay,
      lines,
      nextCursor,
      hasMore: page.hasMore,
      loading: null,
      error: null,
      seenCursors: nextCursor
        ? [...replay.seenCursors, nextCursor]
        : replay.seenCursors,
    },
    messages: projected,
    installedMessageCount: projected.length,
  };
}

let nextProviderReplayGeneration = 1;

/** Monotonic generation counter; stale async results are ignored by store guards. */
export function providerReplayGeneration(): number {
  const generation = nextProviderReplayGeneration;
  nextProviderReplayGeneration += 1;
  return generation;
}
