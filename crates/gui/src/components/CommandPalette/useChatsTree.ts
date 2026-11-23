import { useMemo, useState, type KeyboardEvent } from "react";
import type { Task } from "../../bindings";
import { isRunPane, useChatStore } from "../../stores/chatStore";
import { localChatSessionProjectDisplayName } from "../../utils/localChatSessionGroups";
import {
  buildChatTree,
  expandedOnFirstShow,
  visibleRows,
  type ChatTreeBranch,
  type ChatTreeRow,
  type TreeChat,
} from "./chatTree";
import { paletteChatEntries } from "./paletteModel";

export const CHATS_TREE_ID = "command-palette-tree";

const treeOptionId = (key: string) => `palette-tree-${encodeURIComponent(key)}`;

/**
 * Activate the chat's tab when it is open; otherwise open it from history
 * as a new tab after the active one (decision 49d12c2c §4.2).
 */
export function openChatFromPalette(sessionId: string) {
  const chat = useChatStore.getState();
  const tab = chat.paneLayout.order.find(
    (pane) => !isRunPane(pane) && pane.sessionId === sessionId
  );
  chat.setPanelOpen(true);
  if (tab) {
    chat.focusPane(tab.id);
    chat.requestComposerFocus();
  } else {
    void chat.openSessionInNewTab(sessionId);
  }
}

/** Every chat worth reopening, placed on its tab or in history. */
function useTreeChats(tasks: readonly Task[] | undefined): readonly TreeChat[] {
  const sessions = useChatStore((state) => state.sessions);
  const summaries = useChatStore((state) => state.localSessionSummaries);
  const order = useChatStore((state) => state.paneLayout.order);
  return useMemo(() => {
    const taskTitles = new Map(
      (tasks ?? []).map((task) => [task.id, task.title] as const)
    );
    const tabs = new Map<string, { paneId: string; index: number }>();
    order.forEach((pane, index) => {
      if (!isRunPane(pane))
        tabs.set(pane.sessionId, { paneId: pane.id, index });
    });
    return paletteChatEntries(
      [...Object.values(summaries), ...Object.values(sessions)],
      taskTitles
    ).map((entry) => ({
      sessionId: entry.sessionId,
      title: entry.label,
      projectPath: entry.projectPath,
      projectLabel: localChatSessionProjectDisplayName(entry.projectPath),
      ticketId: entry.ticketId,
      ticketTitle: entry.ticketTitle || null,
      updatedAt: entry.updatedAt,
      tab: tabs.get(entry.sessionId) ?? null,
    }));
  }, [order, sessions, summaries, tasks]);
}

export interface ChatsTreeController {
  rows: readonly ChatTreeRow[];
  activeKey: string | null;
  optionId(key: string): string;
  setActiveKey(key: string): void;
  /** ↑/↓, ←/→ and ↵ on the tree; true when the key was used. */
  onKeyDown(event: KeyboardEvent): boolean;
  runRow(row: ChatTreeRow): void;
  /** Strip size, for the ⌘⌥N hints. */
  tabCount: number;
}

/**
 * The Chats tree's rows and keyboard model. Branches remember a toggle;
 * untouched ones follow the first-show rule, so a tree that fills in as
 * tasks load still opens on the open chats.
 */
export function useChatsTree(
  tasks: readonly Task[] | undefined,
  query: string,
  onOpenChat: (sessionId: string) => void
): ChatsTreeController {
  const chats = useTreeChats(tasks);
  const tree = useMemo(
    () =>
      buildChatTree(
        (tasks ?? []).map((task) => ({
          id: task.id,
          title: task.title,
          level: task.level,
          parentId: task.parent_id,
        })),
        chats
      ),
    [chats, tasks]
  );
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    () => new Map()
  );
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const tabCount = useChatStore((state) => state.paneLayout.order.length);
  const rows = useMemo(
    () =>
      visibleRows(
        tree,
        query,
        (node) => toggled.get(node.key) ?? expandedOnFirstShow(node)
      ),
    [query, toggled, tree]
  );
  const keys = useMemo(() => rows.map((row) => row.node.key), [rows]);
  // Until the user moves, the first open chat (or first hit) is active.
  const fallback =
    rows.find(
      (row) =>
        row.node.kind === "chat" && (query.trim() !== "" || row.node.chat.tab)
    )?.node.key ??
    keys[0] ??
    null;
  const activeKey =
    chosenKey && keys.includes(chosenKey) ? chosenKey : fallback;
  const activeRow = rows.find((row) => row.node.key === activeKey);

  const setExpanded = (node: ChatTreeBranch, expanded: boolean) =>
    setToggled((current) => new Map(current).set(node.key, expanded));

  const runRow = (row: ChatTreeRow) => {
    if (row.node.kind === "chat") onOpenChat(row.node.chat.sessionId);
    else if (!query.trim()) setExpanded(row.node, !row.expanded);
  };

  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (keys.length) {
        const at = activeKey ? keys.indexOf(activeKey) : -1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setChosenKey(keys[(at + delta + keys.length) % keys.length]);
      }
      return true;
    }
    if (event.key === "Enter") {
      if (activeRow) runRow(activeRow);
      return true;
    }
    // ←/→ walk the tree only with an empty query, so they never steal the
    // caret; a query shows every hit expanded anyway.
    if (query.trim() || !activeRow) return false;
    const node = activeRow.node;
    if (event.key === "ArrowRight") {
      if (node.kind !== "chat") {
        if (!activeRow.expanded) setExpanded(node, true);
        else setChosenKey(node.children[0]?.key ?? node.key);
      }
      return true;
    }
    if (event.key === "ArrowLeft") {
      if (node.kind !== "chat" && activeRow.expanded) setExpanded(node, false);
      else if (activeRow.parentKey && keys.includes(activeRow.parentKey))
        setChosenKey(activeRow.parentKey);
      return true;
    }
    return false;
  };

  return {
    rows,
    activeKey,
    optionId: treeOptionId,
    setActiveKey: setChosenKey,
    onKeyDown,
    runRow,
    tabCount,
  };
}
