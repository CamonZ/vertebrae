import { describe, expect, it } from "vitest";
import {
  UNLINKED_LABEL,
  buildChatTree,
  expandedOnFirstShow,
  visibleRows,
  type ChatTreeNode,
  type TreeChat,
  type TreeTask,
} from "./chatTree";

const tasks: TreeTask[] = [
  {
    id: "epic-1",
    title: "Delivery reliability",
    level: "epic",
    parentId: null,
  },
  {
    id: "ticket-1",
    title: "Retry webhook deliveries",
    level: "ticket",
    parentId: "epic-1",
  },
  {
    id: "task-1",
    title: "Add jitter to backoff",
    level: "task",
    parentId: "ticket-1",
  },
  {
    id: "ticket-2",
    title: "Fix timezone drift",
    level: "ticket",
    parentId: "epic-1",
  },
  {
    id: "ticket-empty",
    title: "Nothing chatted here",
    level: "ticket",
    parentId: "epic-1",
  },
  { id: "epic-empty", title: "Quiet epic", level: "epic", parentId: null },
];

function chat(
  sessionId: string,
  title: string,
  ticketId: string | null,
  extra: Partial<TreeChat> = {}
): TreeChat {
  return {
    sessionId,
    title,
    projectPath: "/code/harbor",
    projectLabel: "harbor",
    ticketId,
    ticketTitle: null,
    updatedAt: "2026-11-01T00:00:00Z",
    tab: null,
    ...extra,
  };
}

const chats: TreeChat[] = [
  chat("jitter", "Full or equal jitter", "task-1"),
  chat("retry", "Retry with backoff", "ticket-1", {
    tab: { paneId: "p-retry", index: 0 },
  }),
  chat("drift", "Parse dates in UTC", "ticket-2", {
    updatedAt: "2026-11-05T00:00:00Z",
  }),
  chat("drift-old", "Older drift notes", "ticket-2", {
    updatedAt: "2026-10-01T00:00:00Z",
  }),
  chat("loose", "Scratch notes", null),
  chat("elsewhere", "Other project chat", "foreign-ticket", {
    projectPath: "/code/lumen",
    projectLabel: "lumen",
    ticketTitle: "Lumen ticket",
  }),
];

const tree = buildChatTree(tasks, chats);

function label(node: ChatTreeNode): string {
  switch (node.kind) {
    case "chat":
      return node.chat.title;
    case "task":
      return node.task.title;
    default:
      return node.label;
  }
}

const allExpanded = () => true;
const rows = (query: string, isExpanded = allExpanded) =>
  visibleRows(tree, query, isExpanded).map((row) => label(row.node));

describe("buildChatTree", () => {
  it("nests chats under project, epic, ticket and subtask, unlinked last", () => {
    const shown = visibleRows(tree, "", allExpanded);
    const jitter = shown.find((row) => row.node.key === "chat:jitter")!;
    expect(jitter.depth).toBe(4);
    const path: string[] = [];
    for (let key = jitter.parentKey; key; ) {
      const row = shown.find((r) => r.node.key === key)!;
      path.unshift(label(row.node));
      key = row.parentKey;
    }
    expect(path).toEqual([
      "harbor",
      "Delivery reliability",
      "Retry webhook deliveries",
      "Add jitter to backoff",
    ]);
    expect(rows("")).toEqual([
      "harbor",
      "Delivery reliability",
      "Retry webhook deliveries",
      // Child tasks come before the ticket's own chats.
      "Add jitter to backoff",
      "Full or equal jitter",
      "Retry with backoff",
      "Fix timezone drift",
      // History, most recent first.
      "Parse dates in UTC",
      "Older drift notes",
      UNLINKED_LABEL,
      "Scratch notes",
      "lumen",
      // A ticket that is not loaded sits at the project root.
      "Lumen ticket",
      "Other project chat",
    ]);
  });

  it("drops branches without any chat", () => {
    expect(rows("")).not.toContain("Nothing chatted here");
    expect(rows("")).not.toContain("Quiet epic");
  });

  it("puts the project with an open chat first", () => {
    const reordered = buildChatTree(tasks, [
      chat("history", "History only", null, {
        projectPath: "/a",
        projectLabel: "a",
      }),
      chat("open", "Open", null, {
        projectPath: "/b",
        projectLabel: "b",
        tab: { paneId: "p", index: 0 },
      }),
    ]);
    expect(reordered.map(label)).toEqual(["b", "a"]);
  });
});

describe("expandedOnFirstShow", () => {
  it("expands projects and branches with an open chat, collapses the rest", () => {
    const shown = visibleRows(tree, "", expandedOnFirstShow).map((row) =>
      label(row.node)
    );
    expect(shown).toEqual([
      "harbor",
      "Delivery reliability",
      "Retry webhook deliveries",
      "Add jitter to backoff",
      "Retry with backoff",
      "Fix timezone drift",
      UNLINKED_LABEL,
      "lumen",
      "Lumen ticket",
    ]);
  });
});

describe("visibleRows with a query", () => {
  it("lists every chat under an epic when the query names only the epic", () => {
    const shown = rows("delivery reliability", () => false);
    expect(shown).toEqual(
      expect.arrayContaining([
        "Full or equal jitter",
        "Retry with backoff",
        "Parse dates in UTC",
        "Older drift notes",
      ])
    );
    expect(shown).not.toContain("Scratch notes");
  });

  it("matches tokens from different levels and expands each hit's ancestors", () => {
    expect(rows("timezone utc", () => false)).toEqual([
      "harbor",
      "Delivery reliability",
      "Fix timezone drift",
      "Parse dates in UTC",
    ]);
    expect(rows("timezone jitter")).toEqual([]);
  });

  it("matches the unlinked branch and short ids", () => {
    expect(rows("no ticket scratch")).toEqual([
      "harbor",
      UNLINKED_LABEL,
      "Scratch notes",
    ]);
    expect(rows("ticket-2 older")).toContain("Older drift notes");
  });

  it("flags rows whose own words match every token", () => {
    const matched = visibleRows(tree, "drift", () => false)
      .filter((row) => row.matched)
      .map((row) => label(row.node));
    expect(matched).toEqual(["Fix timezone drift", "Older drift notes"]);
  });
});
