import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  userEvent,
  createMockTask,
  createMockWorkflow,
} from "../test/test-utils";
import { useTaskStore, useWorkflowStore } from "../stores";
import { resetProjectScopedStores } from "../stores/projectScopedStores";

const { mockGetProjects, mockSetCurrentProject, mockNavigate } = vi.hoisted(
  () => ({
    mockGetProjects: vi.fn(),
    mockSetCurrentProject: vi.fn(),
    mockNavigate: vi.fn(),
  })
);

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../bindings", () => ({
  commands: {
    getProjects: (...args: unknown[]) => mockGetProjects(...args),
    setCurrentProject: (...args: unknown[]) => mockSetCurrentProject(...args),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  },
}));

import { ProjectSetupPage } from "./ProjectSetupPage";

describe("ProjectSetupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();

    mockGetProjects.mockResolvedValue({
      status: "ok",
      data: [
        {
          slug: "new-project",
          project_id: "project-new",
          path: "/tmp/new-project",
        },
      ],
    });
    mockSetCurrentProject.mockResolvedValue({ status: "ok", data: null });
  });

  it("resets project-scoped stores after switching projects and before navigation", async () => {
    const oldTask = createMockTask({ id: "old-task", title: "Old task" });
    useTaskStore.setState({ tasks: [oldTask] });
    useWorkflowStore.setState({
      workflows: [createMockWorkflow({ id: "old-workflow" })],
    });

    let taskIdsWhenNavigating: string[] | null = null;
    let workflowIdsWhenNavigating: Array<string | null> | null = null;
    mockNavigate.mockImplementation(() => {
      taskIdsWhenNavigating = useTaskStore
        .getState()
        .tasks.map((task) => task.id);
      workflowIdsWhenNavigating = useWorkflowStore
        .getState()
        .workflows.map((workflow) => workflow.id);
    });

    render(<ProjectSetupPage />);

    expect(await screen.findByTestId("first-run-shell")).toBeInTheDocument();
    expect(screen.getByTestId("first-run-spine")).toHaveTextContent("Project");
    expect(screen.getByTestId("first-run-progress")).toHaveTextContent(
      "Step 1 of 3"
    );

    await userEvent.click(await screen.findByText("new-project"));

    await waitFor(() => {
      expect(mockSetCurrentProject).toHaveBeenCalledWith("new-project");
      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
    expect(taskIdsWhenNavigating).toEqual([]);
    expect(workflowIdsWhenNavigating).toEqual([]);
  });
});
