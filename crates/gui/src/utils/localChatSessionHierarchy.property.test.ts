import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { SessionGroupList } from "../components/ChatWindow/SessionGroupList";
import type { Task, SavedProject } from "../bindings";
import type { LocalChatSessionSummary } from "./localChatPersistence";
import {
  groupLocalChatSessionsByHierarchy,
  groupLocalChatSessionsByProject,
  type LocalChatTicketGroup,
} from "./localChatSessionGroups";

type Entity = Pick<Task, "id" | "title" | "level" | "parent_id">;

const session = (
  id: string,
  entity: string | null,
  projectPath: string
): LocalChatSessionSummary => ({
  id,
  label: id,
  harness: "claude",
  lifecycle: "idle",
  messageCount: 1,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  projectPath,
  providerResumeId: null,
  association: entity ? { ticketId: entity } : null,
});

test("generated hierarchies conserve eligible conversations, parent edges, child-first order and project isolation", () =>
  hegel.test((tc) => {
    const entities = new Map<string, Entity>();
    const entityCountGenerator = gs.integers({ minValue: 1, maxValue: 20 });
    const count = tc.draw(entityCountGenerator);

    for (let index = 0; index < count; index++) {
      const candidates = [...entities.values()].filter(
        (entity) => entity.level !== "task"
      );
      const booleanGenerator = gs.booleans();
      const hasParent = candidates.length > 0 && tc.draw(booleanGenerator);
      let parent: Entity | null = null;

      if (hasParent) {
        const parentIndexGenerator = gs.integers({
          minValue: 0,
          maxValue: candidates.length - 1,
        });
        const parentIndex = tc.draw(parentIndexGenerator);

        parent = candidates[parentIndex];
      }

      const id = `entity-${index}`;
      const level = parent
        ? parent.level === "epic"
          ? "ticket"
          : "task"
        : "epic";

      entities.set(id, {
        id,
        title: id,
        level,
        parent_id: parent?.id ?? null,
      });
    }

    const entityIds = [...entities.keys()];
    const entityGenerator = gs.sampledFrom(entityIds);
    const completedIdsGenerator = gs.arrays(entityGenerator, {
      maxSize: count,
    });
    const completedIds = tc.draw(completedIdsGenerator);
    const completed = new Set(completedIds);

    const associationGenerator = gs.sampledFrom([null, ...entityIds]);
    const projectGenerator = gs.sampledFrom(["/a", "/b"]);
    const assignmentGenerator = gs.record({
      entity: associationGenerator,
      project: projectGenerator,
    });
    const assignmentsGenerator = gs.arrays(assignmentGenerator, {
      maxSize: 70,
    });
    const assignments = tc.draw(assignmentsGenerator);
    const sessions = assignments.map((row, index) =>
      session(`chat-${index}`, row.entity, row.project)
    );
    const projects: SavedProject[] = ["a", "b"].map((id) => ({
      slug: id,
      project_id: id,
      path: `/${id}`,
    }));
    const before = JSON.stringify({ sessions, entities: [...entities] });

    for (const showCompleted of [false, true]) {
      const eligible = sessions.filter((row) => {
        const association = row.association as { ticketId?: string } | null;
        const taskId = association?.ticketId ?? null;

        return showCompleted || taskId === null || !completed.has(taskId);
      });
      const projectGroups = groupLocalChatSessionsByProject(
        eligible,
        projects,
        "/a"
      );
      const found: string[] = [];

      for (const project of projectGroups) {
        const groups = groupLocalChatSessionsByHierarchy(
          project.sessions,
          entities
        );
        const repeatedGroups = groupLocalChatSessionsByHierarchy(
          project.sessions,
          entities
        );

        expect(groups).toEqual(repeatedGroups);

        const walk = (
          nodes: LocalChatTicketGroup[],
          parentId: string | null
        ): string[] =>
          nodes.flatMap((node) => {
            if (node.ticketId) {
              const entity = entities.get(node.ticketId);

              expect(entity?.parent_id).toBe(parentId);
            }

            const childRows = walk(node.children ?? [], node.ticketId);
            const ownRows = node.sessions.map((row) => {
              const association = row.association as {
                ticketId?: string;
              } | null;
              const taskId = association?.ticketId ?? null;

              expect(row.projectPath).toBe(project.projectPath);
              expect(taskId).toBe(node.ticketId);

              return row.id;
            });
            const rowCount = childRows.length + ownRows.length;

            expect(rowCount).toBeGreaterThan(0);

            // This is the rendering contract: all descendants precede direct rows.
            return [...childRows, ...ownRows];
          });
        const expectedOrder = walk(groups, null);

        const list = createElement(SessionGroupList<LocalChatTicketGroup>, {
          sessionGroups: groups,
          activeSessionId: "",
          getChildGroups: (group) => group.children ?? [],
          renderRow: (row) => createElement("span", { "data-chat": row.id }),
          renderGroup: (group, rows) =>
            createElement("section", { "data-entity": group.ticketId }, rows),
        });
        const markup = renderToStaticMarkup(list);
        const parser = new DOMParser();
        const rendered = parser.parseFromString(markup, "text/html");
        const renderedRows = [...rendered.querySelectorAll("[data-chat]")];
        const renderedOrder = renderedRows.map((row) =>
          row.getAttribute("data-chat")
        );

        expect(renderedOrder).toEqual(expectedOrder);

        found.push(...expectedOrder);
      }

      const foundIds = [...found].sort();
      const eligibleIds = eligible.map((row) => row.id).sort();
      const uniqueIds = new Set(found);

      expect(foundIds).toEqual(eligibleIds);
      expect(uniqueIds.size).toBe(found.length);
    }

    const after = JSON.stringify({ sessions, entities: [...entities] });

    expect(after).toBe(before);
  }));

test("missing ancestors and cyclic metadata never lose conversations", () => {
  const rows = [session("one", "child", "/a"), session("two", "unknown", "/a")];
  const child: Entity = {
    id: "child",
    title: "Child",
    level: "task",
    parent_id: "missing",
  };
  const tasks = new Map([["child", child]]);
  const groupsWithMissingParent = groupLocalChatSessionsByHierarchy(
    rows,
    tasks
  );
  const missingParent = groupsWithMissingParent[1];

  expect(missingParent).toMatchObject({
    ticketId: "missing",
    sessions: [],
    children: [{ ticketId: "child", sessions: [rows[0]] }],
  });

  tasks.set("missing", {
    id: "missing",
    title: "Parent",
    level: "task",
    parent_id: "child",
  });

  const flatten = (groups: LocalChatTicketGroup[]): string[] =>
    groups.flatMap((group) => {
      const childIds = flatten(group.children ?? []);
      const ownIds = group.sessions.map((row) => row.id);

      return [...childIds, ...ownIds];
    });
  const cyclicGroups = groupLocalChatSessionsByHierarchy(rows, tasks);
  const conversationIds = flatten(cyclicGroups).sort();

  expect(conversationIds).toEqual(["one", "two"]);
});
