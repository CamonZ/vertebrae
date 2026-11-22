/**
 * The chat workspace: one ordered list of open chats (local chats and run
 * panes) shown as tabs, with the active chat at full width. Decision record
 * 49d12c2c §1, §4, §8 (ticket 736f94f3). Runtime only: nothing persists.
 *
 * Every function here is pure: the chat store applies them inside `set` and
 * the GUI derives what to render from the result. Entry ids are stable while
 * an entry is retargeted to another session, so focus and the strip order
 * follow the slot rather than the session.
 */

/** A local harness chat session rendered in a workspace entry. */
interface LocalChatPaneTarget {
  kind?: "local";
  /** Store session rendered in this entry */
  sessionId: string;
}

/** Request to scroll a run pane to a thread; `nonce` makes repeats distinct. */
interface RunPaneScrollRequest {
  threadId: string;
  nonce: number;
}

/**
 * A durable TaskRun rendered read-only in a workspace entry. Run entries own
 * no ChatSession and start no harness process; only their target persists.
 */
export interface RunPaneTarget {
  kind: "run";
  taskId: string;
  runId: string;
  /** Render only this subagent thread of the run instead of the whole run. */
  focusThreadId?: string | null;
  scrollRequest?: RunPaneScrollRequest | null;
  sessionId?: never;
}

type ChatPaneTarget = LocalChatPaneTarget | RunPaneTarget;

export type LocalChatPane = { id: string } & LocalChatPaneTarget;
export type RunChatPane = { id: string } & RunPaneTarget;
/** Stable entry identifier plus what the entry renders. */
export type ChatPane = LocalChatPane | RunChatPane;

export interface ChatWorkspaceLayout {
  /** Open chats in strip order; every chat-addressing key uses this order. */
  order: ChatPane[];
  /** The active tab: the one chat shown. */
  activeId: string | null;
}

export const EMPTY_WORKSPACE: ChatWorkspaceLayout = {
  order: [],
  activeId: null,
};

export function isRunPane(
  pane: ChatPane | null | undefined
): pane is RunChatPane {
  return pane?.kind === "run";
}

/** Local sessions shown in entries; run entries own no session. */
export function paneSessionIds(panes: readonly ChatPane[]): string[] {
  return panes.flatMap((pane) => (isRunPane(pane) ? [] : [pane.sessionId]));
}

/** Same run and the same (optional) focused subagent thread. */
function sameRunTarget(
  pane: ChatPane,
  target: Pick<RunPaneTarget, "runId" | "focusThreadId">
): boolean {
  return (
    isRunPane(pane) &&
    pane.runId === target.runId &&
    (pane.focusThreadId ?? null) === (target.focusThreadId ?? null)
  );
}

function sameTarget(pane: ChatPane, target: ChatPaneTarget): boolean {
  return target.kind === "run"
    ? sameRunTarget(pane, target)
    : !isRunPane(pane) && pane.sessionId === target.sessionId;
}

export function paneTarget(pane: ChatPane): ChatPaneTarget {
  return isRunPane(pane)
    ? {
        kind: "run",
        taskId: pane.taskId,
        runId: pane.runId,
        focusThreadId: pane.focusThreadId ?? null,
        scrollRequest: pane.scrollRequest ?? null,
      }
    : { sessionId: pane.sessionId };
}

function retargetPane(pane: ChatPane, target: ChatPaneTarget): ChatPane {
  return { ...target, id: pane.id } as ChatPane;
}

export function activeEntry(layout: ChatWorkspaceLayout): ChatPane | undefined {
  return layout.order.find((pane) => pane.id === layout.activeId);
}

export function findEntry(
  layout: ChatWorkspaceLayout,
  target: ChatPaneTarget
): ChatPane | undefined {
  return layout.order.find((pane) => sameTarget(pane, target));
}

const has = (layout: ChatWorkspaceLayout, id: string | null | undefined) =>
  !!id && layout.order.some((pane) => pane.id === id);

const indexOf = (layout: ChatWorkspaceLayout, id: string | null) =>
  layout.order.findIndex((pane) => pane.id === id);

/**
 * Drop entries `keep` rejects (closed or unloaded sessions), then repair the
 * active id against what is left. Returns the same object when nothing
 * changed.
 */
export function normalizeWorkspace(
  layout: ChatWorkspaceLayout,
  keep: (pane: ChatPane) => boolean
): ChatWorkspaceLayout {
  const order = layout.order.filter(keep);
  const activeId =
    layout.activeId && order.some((pane) => pane.id === layout.activeId)
      ? layout.activeId
      : (order[0]?.id ?? null);
  if (order.length === layout.order.length && activeId === layout.activeId) {
    return layout;
  }
  return { order, activeId };
}

/** Make `id` the active chat. */
export function activateEntry(
  layout: ChatWorkspaceLayout,
  id: string
): ChatWorkspaceLayout {
  if (!has(layout, id) || layout.activeId === id) return layout;
  return { ...layout, activeId: id };
}

/** Activate the chat `offset` places away in strip order, wrapping. */
export function activateByOffset(
  layout: ChatWorkspaceLayout,
  offset: number
): ChatWorkspaceLayout {
  const count = layout.order.length;
  if (count <= 1) return layout;
  const at = Math.max(0, indexOf(layout, layout.activeId));
  const next = layout.order[(((at + offset) % count) + count) % count];
  return activateEntry(layout, next.id);
}

/** Add `entry` after the active chat (or `anchorId`) and activate it. */
export function insertEntryAfterActive(
  layout: ChatWorkspaceLayout,
  entry: ChatPane,
  anchorId: string | null = layout.activeId
): ChatWorkspaceLayout {
  const at = indexOf(layout, anchorId);
  const order =
    at < 0
      ? [...layout.order, entry]
      : [
          ...layout.order.slice(0, at + 1),
          entry,
          ...layout.order.slice(at + 1),
        ];
  return { order, activeId: entry.id };
}

/** Point entry `id` at a new target and activate it. */
export function retargetEntry(
  layout: ChatWorkspaceLayout,
  id: string,
  target: ChatPaneTarget
): ChatWorkspaceLayout {
  const entry = layout.order.find((pane) => pane.id === id);
  if (!entry) return layout;
  const retargeted = retargetPane(entry, target);
  return {
    order: layout.order.map((pane) => (pane.id === id ? retargeted : pane)),
    activeId: id,
  };
}

/**
 * Show `target`: activate the chat already showing it, else retarget the
 * preferred entry (default: the active tab), else open the first entry with
 * `newId`. Opening a session from history therefore replaces the active tab.
 */
export function showTarget(
  layout: ChatWorkspaceLayout,
  target: ChatPaneTarget,
  newId: string,
  preferredId?: string
): ChatWorkspaceLayout {
  const existing = findEntry(layout, target);
  if (existing) return activateEntry(layout, existing.id);
  const into = preferredId ?? layout.activeId ?? layout.order[0]?.id;
  if (into && has(layout, into)) return retargetEntry(layout, into, target);
  if (preferredId) return layout;
  return insertEntryAfterActive(layout, { id: newId, ...target } as ChatPane);
}

/**
 * Close entry `id` (its session stays in history). Closing the active tab
 * activates the chat to its right, else to its left. The last open chat
 * cannot be closed.
 */
export function closeEntry(
  layout: ChatWorkspaceLayout,
  id: string
): ChatWorkspaceLayout {
  const at = indexOf(layout, id);
  if (at < 0 || layout.order.length <= 1) return layout;
  const order = layout.order.filter((pane) => pane.id !== id);
  const neighbour = (order[at] ?? order[at - 1]).id;
  return {
    order,
    activeId: layout.activeId === id ? neighbour : layout.activeId,
  };
}

/** Move entry `id` by `offset` places in strip order (no wrap). */
export function moveEntry(
  layout: ChatWorkspaceLayout,
  id: string,
  offset: number
): ChatWorkspaceLayout {
  const at = indexOf(layout, id);
  if (at < 0) return layout;
  return moveEntryTo(layout, id, at + offset);
}

/** Move entry `id` to strip position `index` (clamped). */
function moveEntryTo(
  layout: ChatWorkspaceLayout,
  id: string,
  index: number
): ChatWorkspaceLayout {
  const at = indexOf(layout, id);
  const to = Math.max(0, Math.min(layout.order.length - 1, index));
  if (at < 0 || at === to) return layout;
  const order = layout.order.filter((pane) => pane.id !== id);
  order.splice(to, 0, layout.order[at]);
  return { ...layout, order };
}

/**
 * Drop entry `id` in front of `beforeId`, or at the end when `beforeId` is
 * null or unknown. Addressed by id so callers need not share an index space.
 */
export function moveEntryBefore(
  layout: ChatWorkspaceLayout,
  id: string,
  beforeId: string | null
): ChatWorkspaceLayout {
  const at = indexOf(layout, id);
  if (at < 0 || id === beforeId) return layout;
  const before = indexOf(layout, beforeId);
  // Removing the moved entry shifts later positions left by one.
  const slot = before < 0 ? layout.order.length : before;
  return moveEntryTo(layout, id, slot > at ? slot - 1 : slot);
}
