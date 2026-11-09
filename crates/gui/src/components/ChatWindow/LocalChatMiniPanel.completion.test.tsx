import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "../../bindings";
import { queryClient, queryKeys, upsertTaskInQueryCache } from "../../query";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";
import { createMockTask } from "../../test/test-utils";
import type { LocalChatSessionGroup } from "../../utils/localChatSessionGroups";
import { LocalChatMiniPanel } from "./LocalChatMiniPanel";

vi.mock("../../bindings", () => ({ commands: { getTask: vi.fn() } }));

const sessions: LocalChatSessionGroup["sessions"] = [
  "associated",
  "general",
].map((id) => ({
  id,
  label: id,
  title: id,
  harness: "claude",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  projectPath: "/foreign",
  providerResumeId: null,
  messageCount: 1,
  lifecycle: "idle",
  association:
    id === "associated" ? { ticketId: "ticket", ticketTitle: "Work" } : null,
}));

const group: LocalChatSessionGroup = {
  id: "foreign",
  label: "Foreign",
  projectId: "foreign",
  projectPath: "/foreign",
  isCurrentProject: false,
  isFallback: false,
  sessions,
};

const onSelect = vi.fn();
const onDelete = vi.fn();

const props = {
  width: 320,
  activeSessionId: "associated",
  searchQuery: "",
  onSearchQueryChange: vi.fn(),
  selectedProjectId: "foreign",
  onSelectProject: vi.fn(),
  deleteError: null,
  projectWarning: null,
  sessionGroups: [group],
  spawnOutlineBySessionId: new Map(),
  activityBySessionId: new Map([["associated", "thinking" as const]]),
  onSelect,
  onDelete,
};

const completed = createMockTask({
  id: "ticket",
  title: "Work",
  completed_at: "2026-01-02",
  updated_at: "2026-01-02",
});

const row = () =>
  screen.queryByRole("button", { name: /Load local chat associated/ });

async function tick(ms = 10) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  vi.useFakeTimers();

  vi.mocked(commands.getTask).mockResolvedValue({
    status: "ok",
    data: completed,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

it("keeps rows and empty groups hidden through pending/rejected refreshes, then restores canonical reopening", async () => {
  const view = render(<LocalChatMiniPanel {...props} />);

  await tick();

  const hiddenGroup = screen.queryByRole("button", { name: "Work" });

  expect(hiddenGroup).not.toBeInTheDocument();
  expect(row()).not.toBeInTheDocument();

  let reject!: (reason: Error) => void;
  const pendingRefresh = new Promise<never>((_, fail) => {
    reject = fail;
  });

  vi.mocked(commands.getTask).mockReturnValue(pendingRefresh);

  await tick(30_010);

  const pendingGroup = screen.queryByRole("button", { name: "Work" });

  expect(row()).not.toBeInTheDocument();
  expect(pendingGroup).not.toBeInTheDocument();

  const offlineError = new Error("Offline");

  await act(async () => {
    reject(offlineError);
  });
  await tick();

  expect(row()).not.toBeInTheDocument();

  const search = screen.getByRole("searchbox");

  fireEvent.keyDown(search, { key: "ArrowDown" });

  expect(onSelect).toHaveBeenLastCalledWith("general");

  onSelect.mockClear();
  view.rerender(<LocalChatMiniPanel {...props} searchQuery="associated" />);

  expect(row()).not.toBeInTheDocument();

  view.rerender(<LocalChatMiniPanel {...props} />);

  const showCompleted = screen.getByRole("switch", { name: "Show completed" });

  fireEvent.click(showCompleted);

  const workGroup = screen.getByRole("button", { name: "Work" });

  fireEvent.click(workGroup);

  const completedIcon = screen.getByRole("img", {
    name: "Completed conversation",
  });

  expect(row()).toBeInTheDocument();
  expect(completedIcon).toBeInTheDocument();

  fireEvent.click(showCompleted);

  expect(row()).not.toBeInTheDocument();

  vi.mocked(commands.getTask).mockResolvedValue({
    status: "ok",
    data: completed,
  });

  await tick(30_010);

  expect(row()).not.toBeInTheDocument();

  const reopened = {
    ...completed,
    completed_at: null,
    updated_at: "2026-01-03",
  };

  vi.mocked(commands.getTask).mockResolvedValue({
    status: "ok",
    data: reopened,
  });

  await tick(30_010);

  const restoredGroup = screen.getByRole("button", { name: "Work" });

  expect(restoredGroup).toBeInTheDocument();
  expect(row()).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
  expect(onDelete).not.toHaveBeenCalled();

  view.unmount();
});

it("retains current-project rows through eviction and allows explicit reveal", async () => {
  const current = { ...group, isCurrentProject: true };
  const generation = getProjectScopeGeneration();
  const key = queryKeys.tasks.list(generation, null);

  queryClient.setQueryData(key, [completed]);

  const currentProps = { ...props, sessionGroups: [current] };
  const view = render(<LocalChatMiniPanel {...currentProps} />);

  expect(row()).not.toBeInTheDocument();

  act(() => queryClient.removeQueries({ queryKey: key, exact: true }));
  await tick(600_010);

  expect(row()).not.toBeInTheDocument();
  expect(commands.getTask).not.toHaveBeenCalled();

  const revealSession = { sessionId: "associated", revision: 1 };

  view.rerender(
    <LocalChatMiniPanel {...currentProps} revealSession={revealSession} />
  );

  const showCompleted = screen.getByRole("switch", { name: "Show completed" });

  expect(row()).toBeInTheDocument();
  expect(showCompleted).toHaveAttribute("aria-checked", "true");

  fireEvent.click(showCompleted);

  expect(row()).not.toBeInTheDocument();

  const reopened = {
    ...completed,
    completed_at: null,
    updated_at: "2026-01-03",
  };

  act(() => upsertTaskInQueryCache(reopened));

  expect(row()).toBeInTheDocument();
  expect(onSelect).not.toHaveBeenCalled();
  expect(onDelete).not.toHaveBeenCalled();

  view.unmount();
});
