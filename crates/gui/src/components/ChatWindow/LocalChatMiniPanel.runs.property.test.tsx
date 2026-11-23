import { StatefulMiniPanel } from "../../test/miniPanel";
import { act, render, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Task, TaskRun, TaskRunHistoryEntry } from "../../bindings";
import { commands } from "../../bindings";
import {
  queryClient,
  queryKeys,
  upsertTaskRunInHistoryCache,
} from "../../query";
import type { TaskRunHistoryData } from "../../query";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";
import {
  createMockTask,
  createMockTaskRun,
  createMockTaskRunControls,
} from "../../test/test-utils";

// Keep the real task query, history hook, grouping, and run-row renderer.
vi.mock("../../bindings", async (original) => {
  const actual = await original<typeof import("../../bindings")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listTasks: vi.fn(),
      getTaskRunHistory: vi.fn(),
      getTaskRuns: vi.fn(),
    },
  };
});
vi.mock("../../hooks", () => ({ useRunTrace: vi.fn() }));

const ACTIVE = ["queued", "executing", "waiting", "stopping"] as const;
const TERMINAL = ["completed", "stopped", "failed"] as const;
const LEVELS = ["epic", "ticket", "task"] as const;
const at = (revision: number) =>
  new Date(Date.UTC(2026, 10, 15, 0, revision)).toISOString();

interface EntityModel {
  task: Task;
  // Creation order is the oracle for newest active run; do not call selectors
  // or grouping helpers from production to compute expected visibility.
  runs: TaskRun[];
}
function latestActive(entity: EntityModel) {
  return [...entity.runs]
    .reverse()
    .find((run) => ACTIVE.some((status) => status === run.status));
}
function entry(task: Task, run: TaskRun): TaskRunHistoryEntry {
  return {
    task_run: run,
    task: {
      id: task.id,
      title: task.title,
      level: task.level!,
      parent_id: task.parent_id,
      workflow_id: task.workflow_id,
      workflow_name: task.workflow_name,
      completed_at: task.completed_at,
    },
  };
}

test("generated lifecycle sequences keep the latest active run of every open entity available beyond history pages", async () => {
  await hegel.testAsync(
    async (tc) => {
      queryClient.clear();
      vi.mocked(commands.listTasks).mockClear();
      vi.mocked(commands.getTaskRunHistory).mockClear();
      vi.mocked(commands.getTaskRuns).mockClear();
      const generation = getProjectScopeGeneration();
      const entities: EntityModel[] = LEVELS.map((level, index) => {
        const id = `entity-${index}`;
        const status = tc.draw(gs.sampledFrom(ACTIVE));
        return {
          task: createMockTask({
            id,
            title: `Entity ${level}`,
            level,
            parent_id: index ? `entity-${index - 1}` : null,
            workflow_id: "workflow",
            workflow_name: "Delivery",
          }),
          runs: [
            createMockTaskRun({
              id: `initial-${index}`,
              task_id: id,
              status,
              inserted_at: at(index),
              started_at: at(index),
              updated_at: at(index),
            }),
          ],
        };
      });
      const tasksKey = queryKeys.tasks.list(generation, null);
      const historyKey = queryKeys.taskRunHistory.list(
        generation,
        false,
        "entity"
      );
      const publishTasks = () =>
        queryClient.setQueryData(
          tasksKey,
          entities.map((entity) => {
            const active = latestActive(entity);
            return {
              ...entity.task,
              run_controls: active ? createMockTaskRunControls(active) : null,
            };
          })
        );
      // A partial history snapshot does not include the active runs. The hook
      // regression test separately exercises a full 50-entry first page.
      const noise = createMockTask({
        id: "noise",
        title: "Entity noise",
        workflow_id: "workflow",
      });
      const noiseEntries = Array.from({ length: 3 }, (_, index) =>
        entry(
          noise,
          createMockTaskRun({
            id: `noise-${index}`,
            task_id: noise.id,
            status: "failed",
            updated_at: at(100 + index),
          })
        )
      );
      queryClient.setQueryData<TaskRunHistoryData>(historyKey, {
        pages: [
          {
            entries: noiseEntries,
            has_more: true,
            hidden_completed_count: 0,
            next: { id: "noise-2", updated_at: at(102) },
          },
        ],
        pageParams: [null],
      });
      publishTasks();
      const props = {
        width: 272,
        activeSessionId: "",
        searchQuery: "entity",
        onSearchQueryChange: vi.fn(),
        selectedProjectId: "project",
        onSelectProject: vi.fn(),
        deleteError: null,
        projectWarning: null,
        sessionGroups: [
          {
            id: "project",
            label: "Project",
            projectId: "project",
            projectPath: "/repo",
            isCurrentProject: true,
            isFallback: false,
            sessions: [],
          },
        ],
        spawnOutlineBySessionId: new Map(),
        onSelect: vi.fn(),
        onDelete: vi.fn(),
        onSelectRun: vi.fn(),
      };
      const view = render(<StatefulMiniPanel {...props} />);
      const check = async () => {
        // Query observers batch notifications onto the next timer turn.
        // Flushing only promises can compare the model to the previous frame.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        // Force a render as well as flushing cache notifications, without
        // remounting the sidebar or resetting its accordion/filter preferences.
        view.rerender(<StatefulMiniPanel {...props} />);
        const visible = [
          ...view.container.querySelectorAll<HTMLElement>("[data-run-id]"),
        ];
        const ids = visible.map((row) => row.dataset.runId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const entity of entities) {
          const active = latestActive(entity);
          const own = visible.filter((row) =>
            entity.runs.some((run) => run.id === row.dataset.runId)
          );
          if (entity.task.completed_at || entity.task.archived) {
            expect(own).toHaveLength(0);
          } else if (active) {
            const row = own.find((row) => row.dataset.runId === active.id);
            expect(
              row,
              `${entity.task.level}: missing latest active run ${active.id}`
            ).toBeDefined();
            expect(row).toBeVisible();
            expect(row?.closest("section")).toHaveAttribute(
              "aria-label",
              `${entity.task.title} conversations`
            );
            expect(row?.querySelector("[data-status]")).toHaveAttribute(
              "data-status",
              active.status
            );
            within(row!)
              .getByRole("button", { name: /Load run/ })
              .click();
            expect(props.onSelectRun).toHaveBeenLastCalledWith(
              expect.objectContaining({ id: active.id, taskId: entity.task.id })
            );
          }
        }
      };
      try {
        await check();
        const actions = tc.draw(
          gs.arrays(
            gs.record({
              entity: gs.integers({ minValue: 0, maxValue: 2 }),
              kind: gs.sampledFrom([
                "start",
                "status",
                "complete",
                "reopen",
                "archive",
                "history",
              ] as const),
              status: gs.sampledFrom([...ACTIVE, ...TERMINAL]),
            }),
            { minSize: 1, maxSize: 12 }
          )
        );
        for (const [index, action] of actions.entries()) {
          const entity = entities[action.entity];
          const revision = 200 + index;
          await act(async () => {
            if (action.kind === "start") {
              entity.runs.push(
                createMockTaskRun({
                  id: `new-${revision}`,
                  task_id: entity.task.id,
                  status: action.status,
                  inserted_at: at(revision),
                  started_at: at(revision),
                  updated_at: at(revision),
                })
              );
            } else if (action.kind === "status") {
              const run = entity.runs.at(-1)!;
              entity.runs[entity.runs.length - 1] = {
                ...run,
                status: action.status,
                updated_at: at(revision),
              };
              upsertTaskRunInHistoryCache(entity.runs.at(-1)!, generation);
            } else if (action.kind === "complete")
              entity.task = { ...entity.task, completed_at: at(revision) };
            else if (action.kind === "reopen")
              entity.task = {
                ...entity.task,
                completed_at: null,
                archived: false,
              };
            else if (action.kind === "archive")
              entity.task = { ...entity.task, archived: true };
            else {
              // Repeated/overlapping history pages must not duplicate live rows.
              const entries = entity.runs.map((run) => entry(entity.task, run));
              queryClient.setQueryData<TaskRunHistoryData>(
                historyKey,
                (data) => ({
                  ...data!,
                  pages: [
                    ...data!.pages,
                    {
                      entries: [...entries, ...entries],
                      has_more: false,
                      hidden_completed_count: 0,
                      next: null,
                    },
                  ],
                  pageParams: [...data!.pageParams, null],
                })
              );
            }
            publishTasks();
          });
          await check();
        }
        expect(commands.listTasks).not.toHaveBeenCalled();
        expect(commands.getTaskRunHistory).not.toHaveBeenCalled();
        expect(commands.getTaskRuns).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        queryClient.clear();
      }
    },
    { testCases: 35 }
  );
}, 60_000);
