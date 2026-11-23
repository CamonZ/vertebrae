/**
 * The palette's Chats scope as a tree (decision 49d12c2c §4.2): project ›
 * epic › ticket › task › chats, with unlinked chats under "No ticket" per
 * project. Only branches with a chat below them exist: this is a chat
 * picker. A chat matches when every query token appears somewhere on its
 * path, so typing an epic's name lists every chat under it.
 */
import type { TaskLevel } from "../../bindings";

export interface TreeTask {
  id: string;
  title: string;
  level: TaskLevel | null;
  parentId: string | null;
}

export interface TreeChat {
  sessionId: string;
  title: string;
  /** Project key (its path); null groups under the fallback project. */
  projectPath: string | null;
  projectLabel: string;
  /** Linked ticket, from the chat association. */
  ticketId: string | null;
  /** The association's ticket title, used when the task is not loaded. */
  ticketTitle: string | null;
  updatedAt: string | null;
  /** Strip position when the chat has a workspace tab, else history. */
  tab: { paneId: string; index: number } | null;
}

interface Branch<Kind extends string> {
  kind: Kind;
  /** Unique within the tree: a task can sit under two projects. */
  key: string;
  children: readonly ChatTreeNode[];
}

export type ChatTreeNode =
  | (Branch<"project"> & { label: string })
  | (Branch<"task"> & { task: TreeTask })
  | (Branch<"unlinked"> & { label: string })
  | { kind: "chat"; key: string; chat: TreeChat };

export type ChatTreeBranch = Exclude<ChatTreeNode, { kind: "chat" }>;

export const UNLINKED_LABEL = "No ticket";

interface MutableBranch {
  key: string;
  task: TreeTask;
  tasks: MutableBranch[];
  chats: TreeChat[];
}

/** Open chats in strip order, then history, most recent first. */
function chatOrder(a: TreeChat, b: TreeChat): number {
  if (a.tab && b.tab) return a.tab.index - b.tab.index;
  if (a.tab || b.tab) return a.tab ? -1 : 1;
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

/**
 * Projects (the first with an open chat first), then tasks from the root
 * down in task-list order, child tasks before the chats on a task. A chat
 * linked to a ticket that is not loaded (another project's) sits under that
 * ticket at the project's root.
 */
export function buildChatTree(
  tasks: readonly TreeTask[],
  chats: readonly TreeChat[]
): ChatTreeNode[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const rank = new Map(tasks.map((task, index) => [task.id, index]));
  const projects = new Map<
    string,
    {
      label: string;
      roots: MutableBranch[];
      branches: Map<string, MutableBranch>;
      unlinked: TreeChat[];
    }
  >();

  const branchFor = (
    project: NonNullable<ReturnType<typeof projects.get>>,
    projectKey: string,
    task: TreeTask,
    seen: Set<string>
  ): MutableBranch => {
    const existing = project.branches.get(task.id);
    if (existing) return existing;
    const branch: MutableBranch = {
      key: `${projectKey}›${task.id}`,
      task,
      tasks: [],
      chats: [],
    };
    project.branches.set(task.id, branch);
    seen.add(task.id);
    const parent = task.parentId ? taskById.get(task.parentId) : undefined;
    if (parent && !seen.has(parent.id)) {
      branchFor(project, projectKey, parent, seen).tasks.push(branch);
    } else {
      project.roots.push(branch);
    }
    return branch;
  };

  for (const chat of [...chats].sort(chatOrder)) {
    const projectKey = chat.projectPath ?? "";
    let project = projects.get(projectKey);
    if (!project) {
      project = {
        label: chat.projectLabel,
        roots: [],
        branches: new Map(),
        unlinked: [],
      };
      projects.set(projectKey, project);
    }
    if (!chat.ticketId) {
      project.unlinked.push(chat);
      continue;
    }
    const task = taskById.get(chat.ticketId) ?? {
      id: chat.ticketId,
      title: chat.ticketTitle || chat.ticketId.slice(0, 8),
      level: "ticket",
      parentId: null,
    };
    branchFor(project, projectKey, task, new Set()).chats.push(chat);
  }

  const byTaskOrder = (a: MutableBranch, b: MutableBranch) =>
    (rank.get(a.task.id) ?? Infinity) - (rank.get(b.task.id) ?? Infinity);
  const chatNode = (chat: TreeChat): ChatTreeNode => ({
    kind: "chat",
    key: `chat:${chat.sessionId}`,
    chat,
  });
  const taskNode = (branch: MutableBranch): ChatTreeNode => ({
    kind: "task",
    key: branch.key,
    task: branch.task,
    children: [
      ...[...branch.tasks].sort(byTaskOrder).map(taskNode),
      ...branch.chats.map(chatNode),
    ],
  });

  return [...projects].map(([projectKey, project]) => ({
    kind: "project",
    key: `project:${projectKey}`,
    label: project.label,
    children: [
      ...[...project.roots].sort(byTaskOrder).map(taskNode),
      ...(project.unlinked.length
        ? [
            {
              kind: "unlinked" as const,
              key: `${projectKey}›unlinked`,
              label: UNLINKED_LABEL,
              children: project.unlinked.map(chatNode),
            },
          ]
        : []),
    ],
  }));
}

function words(node: ChatTreeNode): string {
  switch (node.kind) {
    case "chat":
      return node.chat.title;
    case "task":
      return `${node.task.title} ${node.task.id} ${node.task.level ?? ""}`;
    default:
      return node.label;
  }
}

function hasOpenChat(node: ChatTreeNode): boolean {
  return node.kind === "chat"
    ? node.chat.tab !== null
    : node.children.some(hasOpenChat);
}

/**
 * Whether a branch starts expanded: projects always, other branches only
 * with an open chat below, so open chats show at once and history stays
 * one → away.
 */
export function expandedOnFirstShow(node: ChatTreeBranch): boolean {
  return node.kind === "project" || hasOpenChat(node);
}

export interface ChatTreeRow {
  node: ChatTreeNode;
  depth: number;
  parentKey: string | null;
  expanded: boolean;
  /** The node's own words match every token (not only shown as an ancestor). */
  matched: boolean;
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Visible rows in order. With a query, a chat shows when its whole path
 * matches every token and its ancestors show expanded, whatever
 * `isExpanded` says, so every hit is reachable with ↑/↓ alone.
 */
export function visibleRows(
  tree: readonly ChatTreeNode[],
  query: string,
  isExpanded: (node: ChatTreeBranch) => boolean
): ChatTreeRow[] {
  const tokens = queryTokens(query);
  const walk = (
    node: ChatTreeNode,
    depth: number,
    parentKey: string | null,
    path: string
  ): ChatTreeRow[] => {
    const own = words(node).toLowerCase();
    const here = `${path} ${own}`;
    const matched =
      tokens.length > 0 && tokens.every((token) => own.includes(token));
    if (node.kind === "chat") {
      return tokens.every((token) => here.includes(token))
        ? [{ node, depth, parentKey, expanded: false, matched }]
        : [];
    }
    const below = node.children.flatMap((child) =>
      walk(child, depth + 1, node.key, here)
    );
    if (below.length === 0) return [];
    const expanded = tokens.length > 0 || isExpanded(node);
    const row = { node, depth, parentKey, expanded, matched };
    return expanded ? [row, ...below] : [row];
  };
  return tree.flatMap((node) => walk(node, 0, null, ""));
}
