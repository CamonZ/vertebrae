import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fireEvent,
  render,
  screen,
  createMockTask,
  userEvent,
} from "../test/test-utils";
import { TasksPage } from "./TasksPage";
import { useShellStore } from "../stores/shellStore";
import type { Task } from "../bindings";

/**
 * The visible page title and status pills (active count, task counts, and the
 * selected-task short ID) live in the shell header now, surfaced via
 * useShellHeader. The shell chrome isn't mounted in this isolated render, so we
 * mount the stored header actions alongside the page to assert on them.
 */
function TasksPageWithHeader() {
  const headerActions = useShellStore((s) => s.headerActions);
  return (
    <>
      <TasksPage />
      <div data-testid="shell-header-actions">{headerActions}</div>
    </>
  );
}

let mockTasks: Task[] = [];

vi.mock("../hooks/useTasks", () => ({
  useTasks: () => ({
    tasks: mockTasks,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../components/TaskDetail", () => ({
  TaskDetailPanel: ({ taskId }: { taskId: string | null }) =>
    taskId ? <div data-testid="task-detail-panel" /> : null,
}));

vi.mock("../utils", async () => {
  const actual = await vi.importActual<typeof import("../utils")>("../utils");
  return {
    ...actual,
    popOut: vi.fn(),
    stashTask: vi.fn(),
  };
});

describe("TasksPage", () => {
  beforeEach(() => {
    mockTasks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders the selected task as an 8-digit short ID", () => {
    const taskId = "860cde1b-9093-42ff-a19d-7453f3b7891b";
    mockTasks = [
      createMockTask({
        id: taskId,
        title: "Standardize GUI entity ID primitives",
      }),
    ];

    render(<TasksPageWithHeader />);
    fireEvent.click(screen.getAllByRole("treeitem")[0]);

    expect(screen.getByTestId("tasks-page-selected-task-id")).toHaveTextContent(
      "860cde1b"
    );
    expect(screen.queryByText(taskId)).not.toBeInTheDocument();
  });

  it("copies the full selected task ID from the acceptance surface", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const taskId = "860cde1b-9093-42ff-a19d-7453f3b7891b";
    mockTasks = [
      createMockTask({
        id: taskId,
        title: "Standardize GUI entity ID primitives",
      }),
    ];

    render(<TasksPageWithHeader />);
    fireEvent.click(screen.getAllByRole("treeitem")[0]);

    const selectedTaskId = screen.getByTestId("tasks-page-selected-task-id");
    const copyButton = selectedTaskId.querySelector('[role="button"]');
    expect(copyButton).not.toBeNull();

    await user.click(copyButton!);

    expect(writeText).toHaveBeenCalledWith(taskId);
  });
});
