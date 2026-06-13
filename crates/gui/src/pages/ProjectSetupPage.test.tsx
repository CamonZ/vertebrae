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
import { useTaskStore, useWorkflowStore } from "../stores";
import { resetProjectScopedStores } from "../stores/projectScopedStores";

const {
  mockGetProjects,
  mockSetCurrentProject,
  mockSacrumConfigStatus,
  mockSaveSacrumSettings,
  mockListEmbeddedSkills,
  mockInitializeProject,
  mockProjectInitListen,
  mockNavigate,
  mockOpen,
  projectInitProgress,
} = vi.hoisted(() => ({
  mockGetProjects: vi.fn(),
  mockSetCurrentProject: vi.fn(),
  mockSacrumConfigStatus: vi.fn(),
  mockSaveSacrumSettings: vi.fn(),
  mockListEmbeddedSkills: vi.fn(),
  mockInitializeProject: vi.fn(),
  mockProjectInitListen: vi.fn(),
  mockNavigate: vi.fn(),
  mockOpen: vi.fn(),
  projectInitProgress: {
    handler: null as null | ((event: { payload: unknown }) => void),
    unlisten: vi.fn(),
  },
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
    listEmbeddedSkills: (...args: unknown[]) => mockListEmbeddedSkills(...args),
    initializeProject: (...args: unknown[]) => mockInitializeProject(...args),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  },
  events: {
    projectInitProgressEvent: {
      listen: (...args: unknown[]) => mockProjectInitListen(...args),
    },
  },
}));

import { ProjectSetupPage } from "./ProjectSetupPage";

describe("ProjectSetupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectScopedStores();
    projectInitProgress.handler = null;

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
    mockListEmbeddedSkills.mockResolvedValue({
      status: "ok",
      data: ["add", "ready"],
    });
    mockInitializeProject.mockResolvedValue({
      status: "ok",
      data: {
        slug: "new-project",
        project_id: "project-new",
        project_name: "new-project",
        path: "/tmp/new-project",
        project_created: true,
        skills_copied: 2,
        skills_target: "/tmp/new-project/.claude/skills",
      },
    });
    mockProjectInitListen.mockImplementation(async (handler) => {
      projectInitProgress.handler = handler;
      return projectInitProgress.unlisten;
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
    expect(await screen.findByTestId("skills-phase")).toHaveTextContent("add");
    expect(screen.getByTestId("skills-phase")).toHaveTextContent("ready");
  });

  it("streams skill progress, selects the initialized project, and enters the app", async () => {
    mockGetProjects.mockResolvedValue({
      status: "ok",
      data: [],
    });

    let resolveInitialize:
      | ((value: Awaited<ReturnType<typeof mockInitializeProject>>) => void)
      | null = null;
    mockInitializeProject.mockReturnValue(
      new Promise((resolve) => {
        resolveInitialize = resolve;
      })
    );

    render(<ProjectSetupPage />);

    expect(await screen.findByTestId("project-phase-form")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("project-folder-choose"));
    await userEvent.click(screen.getByTestId("project-phase-continue"));

    expect(await screen.findByTestId("skills-phase")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("skills-install"));

    await waitFor(() => {
      expect(mockInitializeProject).toHaveBeenCalledWith(
        "/tmp/new-project",
        "new-project"
      );
      expect(projectInitProgress.handler).not.toBeNull();
    });

    expect(screen.getByTestId("file-state-add/SKILL.md")).toHaveTextContent(
      "queued"
    );

    act(() => {
      projectInitProgress.handler?.({
        payload: {
          project_slug: "other-project",
          kind: "SkillFileInstalled",
          files_copied: 1,
          relative_path: "add/SKILL.md",
          target_path: "/tmp/other/.claude/skills/add/SKILL.md",
        },
      });
    });
    expect(screen.getByTestId("file-state-add/SKILL.md")).toHaveTextContent(
      "queued"
    );

    act(() => {
      projectInitProgress.handler?.({
        payload: {
          project_slug: "new-project",
          kind: "SkillFileInstalled",
          files_copied: 1,
          relative_path: "add/SKILL.md",
          target_path: "/tmp/new-project/.claude/skills/add/SKILL.md",
        },
      });
    });
    expect(screen.getByTestId("file-state-add/SKILL.md")).toHaveTextContent(
      "writing"
    );

    act(() => {
      resolveInitialize?.({
        status: "ok",
        data: {
          slug: "new-project",
          project_id: "project-new",
          project_name: "new-project",
          path: "/tmp/new-project",
          project_created: true,
          skills_copied: 2,
          skills_target: "/tmp/new-project/.claude/skills",
        },
      });
    });

    expect(await screen.findByTestId("ignition-screen")).toHaveTextContent(
      "2"
    );
    expect(screen.getByTestId("ignition-screen")).toHaveTextContent(
      "/tmp/new-project/.claude/skills"
    );
    expect(mockSetCurrentProject).toHaveBeenCalledWith("new-project");
    expect(projectInitProgress.unlisten).toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("ignition-enter"));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });
});
