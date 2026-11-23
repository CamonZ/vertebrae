import { useEffect } from "react";
import type { ChatTreeNode, ChatTreeRow, TreeChat } from "./chatTree";
import { useChatAttention } from "../../hooks/useChatAttention";
import { formatRelative } from "../../utils/formatRelative";
import { ChatAttentionDot } from "../ChatWindow/ChatAttentionDot";
import { chatNumberHint } from "../ChatWindow/chatTabs";
import { Glyph, IdChip } from "../shared/HearthPrimitives";
import { CHATS_TREE_ID, type ChatsTreeController } from "./useChatsTree";

const LEVEL_LABEL = { epic: "Epic", ticket: "Ticket", task: "Task" } as const;

/** The Chats scope's results: an ARIA tree driven from the palette input. */
export function ChatsTreeList({ tree }: { tree: ChatsTreeController }) {
  const { activeKey, optionId } = tree;
  useEffect(() => {
    if (!activeKey) return;
    document
      .getElementById(optionId(activeKey))
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeKey, optionId]);
  return (
    <div
      id={CHATS_TREE_ID}
      className="cmdk-list"
      role="tree"
      aria-label="Chats by project, epic and ticket"
    >
      {tree.rows.length === 0 ? (
        <div className="cmdk-empty" role="status">
          No matching chats
        </div>
      ) : (
        tree.rows.map((row) => (
          <TreeRow
            key={row.node.key}
            row={row}
            tree={tree}
            active={row.node.key === tree.activeKey}
          />
        ))
      )}
    </div>
  );
}

function TreeRow({
  row,
  tree,
  active,
}: {
  row: ChatTreeRow;
  tree: ChatsTreeController;
  active: boolean;
}) {
  const { node, depth } = row;
  const indent = { paddingLeft: `calc(var(--s-2) + ${depth * 16}px)` };
  return (
    <div
      id={tree.optionId(node.key)}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={node.kind === "chat" ? undefined : row.expanded}
      aria-selected={active}
      className={`cmdk-item cmdk-tree-row${node.kind === "project" ? " cmdk-tree-project" : ""}`}
      data-matched={row.matched || undefined}
      style={indent}
      onMouseMove={() => tree.setActiveKey(node.key)}
      onClick={() => tree.runRow(row)}
    >
      <span aria-hidden="true" className="cmdk-tree-chevron">
        {node.kind === "chat" ? "" : row.expanded ? "▾" : "▸"}
      </span>
      <RowBody node={node} tabCount={tree.tabCount} />
    </div>
  );
}

function RowBody({ node, tabCount }: { node: ChatTreeNode; tabCount: number }) {
  if (node.kind === "project" || node.kind === "unlinked") {
    return <span className="cmdk-label">{node.label}</span>;
  }
  if (node.kind === "task") {
    const level = node.task.level ?? "task";
    return (
      <>
        <span className="cmdk-tree-glyph">
          <Glyph level={level} />
        </span>
        <span className="cmdk-tree-level">{LEVEL_LABEL[level]}</span>
        <span className="cmdk-label">{node.task.title}</span>
        <IdChip id={node.task.id} kind="task" level={level} />
      </>
    );
  }
  return <ChatRowBody chat={node.chat} tabCount={tabCount} />;
}

function ChatRowBody({ chat, tabCount }: { chat: TreeChat; tabCount: number }) {
  const attention = useChatAttention(chat.sessionId);
  const number = chat.tab ? chatNumberHint(chat.tab.index, tabCount) : null;
  return (
    <>
      <span className="cmdk-tree-status">
        {chat.tab ? (
          <ChatAttentionDot attention={attention} subject={chat.title} />
        ) : (
          <span aria-hidden="true" className="cmdk-tree-history-dot" />
        )}
      </span>
      <span className="cmdk-label">{chat.title}</span>
      {chat.tab ? (
        <span className="cmdk-hint">open{number ? ` · ${number}` : ""}</span>
      ) : (
        <span className="cmdk-detail">{formatRelative(chat.updatedAt)}</span>
      )}
    </>
  );
}
