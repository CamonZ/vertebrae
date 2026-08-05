import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Section, SectionChangedEvent } from "../bindings";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { useNotificationStore } from "../stores";
import { createMockTask } from "../test/test-utils";

const mockGetTask = vi.fn();
const sectionChangedListen = vi.fn();

let sectionChangedHandler:
  | ((event: { payload: SectionChangedEvent }) => void)
  | null = null;

vi.mock("../bindings", () => ({
  commands: {
    getTask: (...args: unknown[]) => mockGetTask(...args),
  },
  events: {
    sectionChangedEvent: {
      listen: (handler: (event: { payload: SectionChangedEvent }) => void) => {
        sectionChangedHandler = handler;
        sectionChangedListen(handler);
        return Promise.resolve(() => {});
      },
    },
  },
}));

import { useSectionChangeListener } from "./useSectionChangeListener";

function emitSectionChanged(payload: SectionChangedEvent) {
  if (!sectionChangedHandler) {
    throw new Error("sectionChanged handler missing");
  }
  act(() => {
    sectionChangedHandler!({ payload });
  });
}

function detailTaskSections(taskId: string): Section[] {
  return (
    queryClient.getQueryData<ReturnType<typeof createMockTask>>(
      queryKeys.tasks.detail(getProjectScopeGeneration(), taskId)
    )?.sections ?? []
  );
}

describe("useSectionChangeListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sectionChangedHandler = null;
    resetProjectScopedStores();
    useNotificationStore.getState().clearNotifications();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("patches created sections into the cached task and hydrates the full task", async () => {
    const taskId = "task-sections";
    const section: Section = {
      type: "constraint",
      content: "Keep it live",
      order: 1,
      done: null,
      done_at: null,
      refs: [],
    };
    const originalTask = createMockTask({ id: taskId, sections: [] });
    const hydratedTask = createMockTask({
      ...originalTask,
      sections: [section],
      updated_at: "2026-06-11T10:00:00Z",
    });
    queryClient.setQueryData(
      queryKeys.tasks.detail(getProjectScopeGeneration(), taskId),
      originalTask
    );
    mockGetTask.mockResolvedValue({ status: "ok", data: hydratedTask });

    renderHook(() => useSectionChangeListener());
    await waitFor(() => {
      expect(sectionChangedListen).toHaveBeenCalledTimes(1);
    });

    emitSectionChanged({
      section_id: "section-1",
      task_id: taskId,
      change_type: "Created",
      section,
    });

    expect(detailTaskSections(taskId)).toEqual([section]);
    await waitFor(() => {
      expect(mockGetTask).toHaveBeenCalledWith(taskId);
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData(
          queryKeys.tasks.detail(getProjectScopeGeneration(), taskId)
        )
      ).toEqual(hydratedTask);
    });
  });

  it("hydrates the full task when deleted section events have no section payload", async () => {
    const taskId = "task-delete-section";
    const section: Section = {
      type: "testing_criterion",
      content: "Old criterion",
      order: 1,
      done: false,
      done_at: null,
      refs: [],
    };
    const originalTask = createMockTask({ id: taskId, sections: [section] });
    const hydratedTask = createMockTask({
      ...originalTask,
      sections: [],
      updated_at: "2026-06-11T10:05:00Z",
    });
    queryClient.setQueryData(
      queryKeys.tasks.detail(getProjectScopeGeneration(), taskId),
      originalTask
    );
    mockGetTask.mockResolvedValue({ status: "ok", data: hydratedTask });

    renderHook(() => useSectionChangeListener());
    await waitFor(() => {
      expect(sectionChangedListen).toHaveBeenCalledTimes(1);
    });

    emitSectionChanged({
      section_id: "section-1",
      task_id: taskId,
      change_type: "Deleted",
      section: null,
    });

    await waitFor(() => {
      expect(detailTaskSections(taskId)).toEqual([]);
    });
  });
});
