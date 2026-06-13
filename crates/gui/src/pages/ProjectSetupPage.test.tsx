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

const {
  mockGetProjects,
  mockSetCurrentProject,
  mockSacrumConfigStatus,
  mockSaveSacrumSettings,
  mockNavigate,
  mockOpen,
} = vi.hoisted(() => ({
  mockGetProjects: vi.fn(),
  mockSetCurrentProject: vi.fn(),
  mockSacrumConfigStatus: vi.fn(),
  mockSaveSacrumSettings: vi.fn(),
  mockNavigate: vi.fn(),
  mockOpen: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));

vi.mock("../bindings", () => ({
  commands: {
    getProjects: (...args: unknown[]) => mockGetProjects(...args),
    setCurrentProject: (...args: unknown[]) => mockSetCurrentProject(...args),
    sacrumConfigStatus: (...args: unknown[]) => mockSacrumConfigStatus(...args),
    saveSacrumSettings: (...args: unknown[]) => mockSaveSacrumSettings(...args),
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
    mockSacrumConfigStatus.mockResolvedValue({
      status: "ok",
      data: {
        config_path: "/tmp/config.toml",
        config_exists: true,
        url: "http://localhost:4000",
        has_token: true,
      },
    });
    mockSaveSacrumSettings.mockResolvedValue({
      status: "ok",
      data: {
        config_path: "/tmp/config.toml",
        config_exists: true,
        url: "http://localhost:4000",
        has_token: true,
      },
    });
    mockOpen.mockResolvedValue("/tmp/new-project");
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

  it("collects folder and project name without showing Sacrum fields when config is complete", async () => {
    render(<ProjectSetupPage />);

    await userEvent.click(await screen.findByTestId("setup-add-project"));

    expect(await screen.findByTestId("project-phase-form")).toBeInTheDocument();
    expect(mockSacrumConfigStatus).toHaveBeenCalled();
    expect(screen.queryByLabelText("Sacrum API token")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("project-folder-choose"));

    expect(mockOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Select Project Directory",
    });
    expect(screen.getByLabelText("Project name")).toHaveValue("new-project");
    expect(screen.getByText("/tmp/new-project")).toBeInTheDocument();
  });

  it("requires and saves Sacrum settings when config is missing", async () => {
    mockGetProjects.mockResolvedValue({
      status: "ok",
      data: [],
    });
    mockSacrumConfigStatus.mockResolvedValue({
      status: "ok",
      data: {
        config_path: null,
        config_exists: false,
        url: "http://localhost:4000",
        has_token: false,
      },
    });

    render(<ProjectSetupPage />);

    expect(await screen.findByTestId("project-phase-form")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("project-folder-choose"));

    expect(
      await screen.findByLabelText("Sacrum API token")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Sacrum URL")).toHaveValue(
      "http://localhost:4000"
    );

    await userEvent.click(screen.getByTestId("project-phase-continue"));
    expect(await screen.findByTestId("project-phase-error")).toHaveTextContent(
      "Sacrum API token is required."
    );
    expect(mockSaveSacrumSettings).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("Sacrum API token"), "sac_test");
    await userEvent.click(screen.getByTestId("project-phase-continue"));

    await waitFor(() => {
      expect(mockSaveSacrumSettings).toHaveBeenCalledWith(
        "http://localhost:4000",
        "sac_test"
      );
    });
    expect(await screen.findByTestId("project-phase-ready")).toHaveTextContent(
      "new-project"
    );
  });
});
