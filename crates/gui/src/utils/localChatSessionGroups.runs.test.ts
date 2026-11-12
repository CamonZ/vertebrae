import { describe, expect, it } from "vitest";
import { createMockTask, createMockTaskRun } from "../test/test-utils";
import type { LocalChatSessionSummary } from "./localChatPersistence";
import {
  groupLocalChatSessionsByHierarchy,
  localChatGroupRows,
  type LocalChatRunRow,
} from "./localChatSessionGroups";

function session(
  id: string,
  ticketId: string | null,
  updatedAt: string
): LocalChatSessionSummary {
  return {
    id,
    label: id,
    title: null,
    harness: "claude",
    createdAt: updatedAt,
    updatedAt,
    projectPath: "/repo",
    providerResumeId: null,
    messageCount: 1,
    lifecycle: "idle",
    association: ticketId ? { ticketId } : null,
  } as LocalChatSessionSummary;
}

function runRow(
  id: string,
  taskId: string,
  updatedAt: string
): LocalChatRunRow {
  return {
    id,
    taskId,
    run: createMockTaskRun({ id, task_id: taskId, updated_at: updatedAt }),
    label: "Run",
    updatedAt,
    completed: false,
  };
}

const tasks = new Map([
  ["epic", createMockTask({ id: "epic", title: "Epic", level: "epic" })],
  [
    "ticket",
    createMockTask({
      id: "ticket",
      title: "Ticket",
      level: "ticket",
      parent_id: "epic",
    }),
  ],
  [
    "task",
    createMockTask({
      id: "task",
      title: "Task",
      level: "task",
      parent_id: "ticket",
    }),
  ],
  ["other", createMockTask({ id: "other", title: "Other", level: "ticket" })],
]);

describe("groupLocalChatSessionsByHierarchy with runs", () => {
  it("places runs under their task inside the epic → ticket → task hierarchy", () => {
    const groups = groupLocalChatSessionsByHierarchy(
      [session("chat-1", "ticket", "2026-01-01T00:00:00Z")],
      tasks,
      [runRow("run-1", "task", "2026-01-02T00:00:00Z")]
    );

    expect(groups.map((group) => group.label)).toEqual(["Epic"]);
    const ticket = groups[0].children![0];
    expect(ticket.label).toBe("Ticket");
    expect(ticket.sessions.map((s) => s.id)).toEqual(["chat-1"]);
    const task = ticket.children![0];
    expect(task).toMatchObject({ label: "Task", entityLevel: "task" });
    expect(task.runs?.map((run) => run.id)).toEqual(["run-1"]);
  });

  it("orders root groups by their newest session or run", () => {
    const groups = groupLocalChatSessionsByHierarchy(
      [
        session("chat-old", "other", "2026-01-01T00:00:00Z"),
        session("loose", null, "2026-01-05T00:00:00Z"),
      ],
      tasks,
      [runRow("run-new", "task", "2026-01-03T00:00:00Z")]
    );

    expect(groups.map((group) => group.label)).toEqual([
      "Epic",
      "Other",
      "Other chats",
    ]);
  });

  it("leaves session-only grouping unchanged without runs", () => {
    const sessions = [
      session("a", "other", "2026-01-02T00:00:00Z"),
      session("b", "ticket", "2026-01-01T00:00:00Z"),
    ];
    expect(groupLocalChatSessionsByHierarchy(sessions, tasks, [])).toEqual(
      groupLocalChatSessionsByHierarchy(sessions, tasks)
    );
  });
});

describe("localChatGroupRows", () => {
  it("interleaves sessions and runs newest first", () => {
    const rows = localChatGroupRows({
      sessions: [
        session("s-new", "t", "2026-01-03T00:00:00Z"),
        session("s-old", "t", "2026-01-01T00:00:00Z"),
      ],
      runs: [runRow("r-mid", "t", "2026-01-02T00:00:00Z")],
    });

    expect(
      rows.map((row) => (row.kind === "session" ? row.session.id : row.run.id))
    ).toEqual(["s-new", "r-mid", "s-old"]);
  });
});
