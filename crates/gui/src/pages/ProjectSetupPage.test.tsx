import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  waitFor,
  userEvent,
  createMockTask,
  createMockWorkflow,
} from "../test/test-utils";
import { queryClient, queryKeys } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";

const {
  mockGetProjects,
  mockSetCurrentProject,
  mockSacrumConfigStatus,
  mockSaveSacrumSettings,
  mockInitializeProject,
  mockRemoveProject,
  mockNavigate,
  mockOpen,
} = vi.hoisted(() => ({
  mockGetProjects: vi.fn(),
  mockSetCurrentProject: vi.fn(),
  mockSacrumConfigStatus: vi.fn(),
  mockSaveSacrumSettings: vi.fn(),
  mockInitializeProject: vi.fn(),
  mockRemoveProject: vi.fn(),
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
    initializeProject: (...args: unknown[]) => mockInitializeProject(...args),
    removeProject: (...args: unknown[]) => mockRemoveProject(...args),
  },
}));

import { ProjectSetupPage } from "./ProjectSetupPage";

const initializedProject = {
  status: "ok" as const,
  data: {
    slug: "new-project",
    project_id: "project-new",
    project_name: "new-project",
    path: "/tmp/new-project",
    project_created: true,
  },
};

async function chooseRemoteBackend() {
  expect(await screen.findByTestId("backend-choice")).toBeInTheDocument();
  await userEvent.click(screen.getByTestId("backend-choice-remote"));
  await userEvent.click(screen.getByTestId("backend-choice-continue"));
  expect(await screen.findByTestId("project-phase-form")).toBeInTheDocument();
}

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
    mockInitializeProject.mockResolvedValue(initializedProject);
    mockRemoveProject.mockResolvedValue({ status: "ok", data: null });
    mockOpen.mockResolvedValue("/tmp/new-project");
  });

  it("resets project-scoped query cache after switching projects and before navigation", async () => {
    const oldTask = createMockTask({ id: "old-task", title: "Old task" });
    const oldWorkflow = createMockWorkflow({ id: "old-workflow" });
    const generation = getProjectScopeGeneration();
    const taskListKey = queryKeys.tasks.list(generation, null);
    const workflowListKey = queryKeys.workflows.list(generation);
    queryClient.setQueryData(taskListKey, [oldTask]);
    queryClient.setQueryData(workflowListKey, [oldWorkflow]);

    let taskCacheClearedWhenNavigating: boolean | null = null;
    let workflowCacheClearedWhenNavigating: boolean | null = null;
    mockNavigate.mockImplementation(() => {
      taskCacheClearedWhenNavigating =
        queryClient.getQueryData(taskListKey) === undefined;
      workflowCacheClearedWhenNavigating =
        queryClient.getQueryData(workflowListKey) === undefined;
    });

    render(<ProjectSetupPage />);

    expect(await screen.findByTestId("first-run-shell")).toBeInTheDocument();
    expect(screen.getByTestId("first-run-spine")).toHaveTextContent("Project");
    expect(screen.getByTestId("first-run-spine")).toHaveTextContent("Ready");
    expect(screen.getByTestId("first-run-spine")).not.toHaveTextContent(
      "Skills & Docs"
    );
    expect(screen.getByTestId("first-run-progress")).toHaveTextContent(
      "Step 1 of 2"
    );

    await userEvent.click(await screen.findByText("new-project"));

    await waitFor(() => {
      expect(mockSetCurrentProject).toHaveBeenCalledWith("new-project");
      expect(mockNavigate).toHaveBeenCalledWith("/");
    });
    expect(taskCacheClearedWhenNavigating).toBe(true);
    expect(workflowCacheClearedWhenNavigating).toBe(true);
  });

  it("keeps returning users on the saved-project list and opens the project form", async () => {
    render(<ProjectSetupPage />);

    expect(await screen.findByTestId("setup-project-list")).toHaveTextContent(
      "new-project"
    );

    await userEvent.click(screen.getByTestId("setup-add-project"));

    expect(await screen.findByTestId("project-phase-form")).toBeInTheDocument();
    expect(mockInitializeProject).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByTestId("setup-project-list")).toHaveTextContent(
      "new-project"
    );
  });

  it("removes saved projects without selecting the project row", async () => {
    mockGetProjects
      .mockResolvedValueOnce({
        status: "ok",
        data: [
          {
            slug: "new-project",
            project_id: "project-new",
            path: "/tmp/new-project",
          },
        ],
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: [],
      });

    render(<ProjectSetupPage />);

    await userEvent.click(await screen.findByTitle("Remove from list"));

    await waitFor(() => {
      expect(mockRemoveProject).toHaveBeenCalledWith("new-project");
    });
    expect(mockSetCurrentProject).not.toHaveBeenCalled();
    expect(await screen.findByTestId("backend-choice")).toBeInTheDocument();
  });

  it("requires an explicit backend choice and preserves project fields", async () => {
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });

    render(<ProjectSetupPage />);

    expect(await screen.findByTestId("backend-choice")).toBeInTheDocument();
    expect(screen.getByTestId("backend-choice-continue")).toBeDisabled();
    expect(mockSacrumConfigStatus).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("backend-choice-local"));
    await userEvent.click(screen.getByTestId("backend-choice-continue"));
    expect(await screen.findByTestId("project-phase-form")).toHaveTextContent(
      "Docker-hosted local backend"
    );
    await userEvent.type(
      screen.getByLabelText("Project name"),
      "first-project"
    );
    await userEvent.click(screen.getByTestId("project-back-backend"));
    expect(await screen.findByTestId("backend-choice")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("backend-choice-remote"));
    await userEvent.click(screen.getByTestId("backend-choice-continue"));
    expect(await screen.findByLabelText("Project name")).toHaveValue(
      "first-project"
    );
    expect(mockSacrumConfigStatus).toHaveBeenCalledTimes(1);
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

  it("saves a changed remote URL while preserving an existing token", async () => {
    render(<ProjectSetupPage />);

    await userEvent.click(await screen.findByTestId("setup-add-project"));
    const url = await screen.findByLabelText("Sacrum URL");
    expect(url).toHaveValue("http://localhost:4000");

    await userEvent.clear(url);
    await userEvent.type(url, "https://sacrum.example.test/graphql");
    await userEvent.click(screen.getByTestId("project-folder-choose"));
    await userEvent.click(screen.getByTestId("project-phase-continue"));

    expect(await screen.findByTestId("ignition-screen")).toBeInTheDocument();
    expect(mockSaveSacrumSettings).toHaveBeenCalledWith(
      "https://sacrum.example.test/graphql",
      ""
    );
  });

  it("saves missing Sacrum settings and initializes directly into the ready state", async () => {
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
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

    await chooseRemoteBackend();
    expect(screen.getByTestId("first-run-progress")).toHaveTextContent(
      "Step 2 of 3"
    );
    await userEvent.click(screen.getByTestId("project-folder-choose"));

    expect(
      await screen.findByLabelText("Sacrum API token")
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("project-phase-continue"));
    expect(await screen.findByTestId("project-phase-error")).toHaveTextContent(
      "Sacrum API token is required."
    );
    expect(mockSaveSacrumSettings).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("Sacrum API token"), "sac_test");
    await userEvent.click(screen.getByTestId("project-phase-continue"));

    expect(await screen.findByTestId("ignition-screen")).toHaveTextContent(
      "/tmp/new-project"
    );
    expect(mockSaveSacrumSettings).toHaveBeenCalledWith(
      "http://localhost:4000",
      "sac_test"
    );
    expect(mockInitializeProject).toHaveBeenCalledWith(
      "/tmp/new-project",
      "new-project"
    );
    expect(mockSetCurrentProject).toHaveBeenCalledWith("new-project");
    expect(screen.queryByText("Skills & Docs")).not.toBeInTheDocument();
  });

  it("retries Sacrum status loading after a transient failure", async () => {
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
    mockSacrumConfigStatus
      .mockResolvedValueOnce({
        status: "error",
        error: { message: "Sacrum config unavailable" },
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: {
          config_path: "/tmp/config.toml",
          config_exists: true,
          url: "http://localhost:4000",
          has_token: true,
        },
      });

    render(<ProjectSetupPage />);

    await chooseRemoteBackend();
    expect(await screen.findByTestId("project-phase-error")).toHaveTextContent(
      "Sacrum config unavailable"
    );

    await userEvent.click(screen.getByTestId("sacrum-status-retry"));

    await waitFor(() => {
      expect(mockSacrumConfigStatus).toHaveBeenCalledTimes(2);
    });
    await userEvent.click(screen.getByTestId("project-folder-choose"));
    await userEvent.click(screen.getByTestId("project-phase-continue"));
    expect(await screen.findByTestId("ignition-screen")).toBeInTheDocument();
  });

  it("returns to token entry when Sacrum rejects the saved API token", async () => {
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
    mockSacrumConfigStatus.mockResolvedValue({
      status: "ok",
      data: {
        config_path: null,
        config_exists: false,
        url: "http://localhost:4000",
        has_token: false,
      },
    });
    mockInitializeProject
      .mockResolvedValueOnce({
        status: "error",
        error: { message: "Unauthorized" },
      })
      .mockResolvedValueOnce(initializedProject);

    render(<ProjectSetupPage />);

    await chooseRemoteBackend();
    await userEvent.click(screen.getByTestId("project-folder-choose"));
    await userEvent.type(
      screen.getByLabelText("Sacrum API token"),
      "bad-token"
    );
    await userEvent.click(screen.getByTestId("project-phase-continue"));

    expect(await screen.findByTestId("project-phase-error")).toHaveTextContent(
      "Sacrum rejected the API token"
    );
    expect(screen.getByLabelText("Sacrum API token")).toHaveValue("");
    expect(mockSetCurrentProject).not.toHaveBeenCalled();

    await userEvent.type(
      screen.getByLabelText("Sacrum API token"),
      "sac_valid-token"
    );
    await userEvent.click(screen.getByTestId("project-phase-continue"));

    expect(await screen.findByTestId("ignition-screen")).toBeInTheDocument();
    expect(mockSaveSacrumSettings).toHaveBeenLastCalledWith(
      "http://localhost:4000",
      "sac_valid-token"
    );
    expect(mockSetCurrentProject).toHaveBeenCalledWith("new-project");
  });

  it("surfaces initialization failures without selecting and allows retry", async () => {
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
    mockInitializeProject
      .mockResolvedValueOnce({
        status: "error",
        error: { message: "Sacrum is unavailable" },
      })
      .mockResolvedValueOnce(initializedProject);

    render(<ProjectSetupPage />);
    await chooseRemoteBackend();
    await userEvent.click(screen.getByTestId("project-folder-choose"));
    await userEvent.click(screen.getByTestId("project-phase-continue"));

    expect(await screen.findByTestId("project-phase-error")).toHaveTextContent(
      "Sacrum is unavailable"
    );
    expect(mockSetCurrentProject).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("project-phase-continue"));

    expect(await screen.findByTestId("ignition-screen")).toBeInTheDocument();
    expect(mockInitializeProject).toHaveBeenCalledTimes(2);
    expect(mockSetCurrentProject).toHaveBeenCalledWith("new-project");
  });

  it("initializes, selects, and reaches ready without rendering a skill phase", async () => {
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
    let resolveInitialize: ((value: typeof initializedProject) => void) | null =
      null;
    mockInitializeProject.mockReturnValue(
      new Promise((resolve) => {
        resolveInitialize = resolve;
      })
    );

    render(<ProjectSetupPage />);

    await chooseRemoteBackend();
    await userEvent.click(screen.getByTestId("project-folder-choose"));
    await userEvent.clear(screen.getByLabelText("Project name"));
    await userEvent.type(screen.getByLabelText("Project name"), "Ørsted");
    await userEvent.click(screen.getByTestId("project-phase-continue"));

    await waitFor(() => {
      expect(mockInitializeProject).toHaveBeenCalledWith(
        "/tmp/new-project",
        "Ørsted"
      );
    });
    expect(screen.getByTestId("project-phase-continue")).toHaveTextContent(
      "Creating..."
    );
    expect(screen.queryByText("Skills & Docs")).not.toBeInTheDocument();
    expect(screen.queryByText(/skill files linked/i)).not.toBeInTheDocument();

    await act(async () => {
      resolveInitialize?.({
        status: "ok",
        data: {
          ...initializedProject.data,
          slug: "orsted",
          project_name: "Ørsted",
        },
      });
    });

    expect(await screen.findByTestId("ignition-screen")).toHaveTextContent(
      "Ørsted"
    );
    expect(mockSetCurrentProject).toHaveBeenCalledWith("orsted");

    await userEvent.click(screen.getByTestId("ignition-enter"));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });
});
