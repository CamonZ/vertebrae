/**
 * Pure presentation helpers for the chat tab strip (ticket 736f94f3): ids,
 * accessible names, tooltips and which tabs fit inline.
 */
import type { TaskRunStatus } from "../../bindings";
import {
  chatAttentionText,
  type ChatAttention,
} from "../../utils/chatAttention";
import { isActiveRunStatus } from "../../utils/runState";
import { WORKSPACE_SHORTCUTS, presentChatShortcut } from "./chatShortcuts";

export function chatTabId(entryId: string) {
  return `chat-tab-${entryId}`;
}

export function chatTabPanelId(entryId: string) {
  return `chat-tabpanel-${entryId}`;
}

/** One strip entry as the tab, switcher and overflow menu render it. */
export interface ChatTabModel {
  id: string;
  title: string;
  /** Local chats: the attention state. Runs: derived from the run status. */
  attention: ChatAttention;
  isRun: boolean;
  project: string | null;
}

/** The `⌘⌥N` hint for strip position `index`; ⌘⌥9 is always the last chat. */
export function chatNumberHint(index: number, count: number): string | null {
  const keys = presentChatShortcut(WORKSPACE_SHORTCUTS.chatByNumber)?.keys;
  if (!keys) return null;
  const prefix = keys.slice(0, -1).join("");
  if (index === count - 1 && count > 8) return `${prefix}9`;
  return index < 8 ? `${prefix}${index + 1}` : null;
}

/** Accessible name: "title, state[: reason][, run, read-only]". */
export function chatTabLabel(tab: ChatTabModel): string {
  const parts = [tab.title, chatAttentionText(tab.attention)];
  if (tab.isRun) parts.push("run", "read-only");
  return parts.join(", ");
}

/** Tooltip: "title · state · ⌘⌥N". */
export function chatTabTooltip(tab: ChatTabModel, hint: string | null) {
  return [tab.title, chatAttentionText(tab.attention), hint]
    .filter(Boolean)
    .join(" · ");
}

export function runAttention(status: TaskRunStatus | undefined): ChatAttention {
  if (!status) return { state: "idle", reason: null, since: null };
  if (status === "failed") return { state: "error", reason: null, since: null };
  if (isActiveRunStatus(status)) {
    return { state: "running", reason: null, since: null };
  }
  return { state: "idle", reason: status, since: null };
}

/** The tabs that fit; the active tab always stays inline. */
export function inlineTabs(
  tabs: readonly ChatTabModel[],
  activeId: string | null,
  capacity: number
): ChatTabModel[] {
  const fit = Math.max(1, capacity);
  if (tabs.length <= fit) return [...tabs];
  const head = tabs.slice(0, fit);
  if (head.some((tab) => tab.id === activeId)) return head;
  const active = tabs.find((tab) => tab.id === activeId);
  return active ? [...head.slice(0, -1), active] : head;
}
