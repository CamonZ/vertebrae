import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";

const mockGetCurrentProject = vi.fn();
const mockGetProjects = vi.fn();
const mockSetCurrentProject = vi.fn();
const mockInitializeProject = vi.fn();
const mockPreviewProjectSlug = vi.fn();
const mockListEmbeddedSkills = vi.fn();
const mockProjectInitListen = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProject: (...args: unknown[]) => mockGetCurrentProject(...args),
    getProjects: (...args: unknown[]) => mockGetProjects(...args),
    setCurrentProject: (...args: unknown[]) => mockSetCurrentProject(...args),
    initializeProject: (...args: unknown[]) => mockInitializeProject(...args),
    previewProjectSlug: (...args: unknown[]) => mockPreviewProjectSlug(...args),
    listEmbeddedSkills: (...args: unknown[]) => mockListEmbeddedSkills(...args),
  },
  events: {
    projectInitProgressEvent: {
      listen: (...args: unknown[]) => mockProjectInitListen(...args),
    },
  },
}));

const mockOpenDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpenDialog(...args),
}));

const mockResetProjectScopedStores = vi.fn();
vi.mock("../stores", () => ({
  resetProjectScopedStores: () => mockResetProjectScopedStores(),
}));

vi.mock("../hooks/useLocalChat", () => ({
  useOpenChat: () => vi.fn(),
}));

const mockUseWebSocketStatus = vi.fn();
vi.mock("../hooks/useWebSocketStatus", () => ({
  useWebSocketStatus: () => mockUseWebSocketStatus(),
}));

function LocationDisplay() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

describe("Sidebar Traces nav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockUseWebSocketStatus.mockReturnValue("connected");
    mockGetCurrentProject.mockResolvedValue({ status: "ok", data: null });
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
    mockSetCurrentProject.mockResolvedValue({ status: "ok", data: null });
  });

  it("renders the primary nav in design-rail order with 14px icons", () => {
    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Sidebar />
      </MemoryRouter>
    );

    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const order = Array.from(nav.querySelectorAll("a[data-testid]")).map((a) =>
      a.getAttribute("data-testid")
    );
    expect(order).toEqual([
      "sidebar-nav-tasks",
      "sidebar-nav-board",
      "sidebar-nav-design",
      "sidebar-nav-traces",
    ]);

    for (const label of ["tasks", "board", "design", "traces"]) {
      const svg = screen
        .getByTestId(`sidebar-nav-${label}`)
        .querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("width")).toBe("14");
      expect(svg?.getAttribute("height")).toBe("14");
    }
  });

  it("renders a Traces nav link pointing at /traces", () => {
    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Sidebar />
      </MemoryRouter>
    );
    const link = screen.getByTestId("sidebar-nav-traces");
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/traces");
  });

  it("clicking the Traces nav navigates to /traces", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Sidebar />
        <Routes>
          <Route path="*" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
    await user.click(screen.getByTestId("sidebar-nav-traces"));
    await waitFor(() => {
      expect(screen.getByTestId("loc")).toHaveTextContent("/traces");
    });
  });
});

describe("Sidebar project switcher", () => {
  let progressHandler: ((event: { payload: unknown }) => void) | null = null;

  const gammaResult = {
    status: "ok",
    data: {
      slug: "gamma",
      project_id: "id",
      project_name: "gamma",
      path: "/Users/dev/code/gamma",
      project_created: true,
      skills_copied: 2,
      skills_target: "/Users/dev/code/gamma/.claude/skills",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    progressHandler = null;
    mockUseWebSocketStatus.mockReturnValue("connected");
    // A project is loaded so the avatar (and switcher) renders.
    mockGetCurrentProject.mockResolvedValue({
      status: "ok",
      data: "/Users/dev/code/alpha",
    });
    mockGetProjects.mockResolvedValue({
      status: "ok",
      data: [
        { slug: "alpha", path: "/Users/dev/code/alpha" },
        { slug: "beta", path: "/Users/dev/code/beta" },
      ],
    });
    mockSetCurrentProject.mockResolvedValue({ status: "ok", data: null });
    mockInitializeProject.mockResolvedValue(gammaResult);
    mockPreviewProjectSlug.mockResolvedValue({ status: "ok", data: "gamma" });
    mockListEmbeddedSkills.mockResolvedValue({
      status: "ok",
      data: ["vtb-add", "vtb-ready"],
    });
    mockProjectInitListen.mockImplementation(
      async (handler: (event: { payload: unknown }) => void) => {
        progressHandler = handler;
        return vi.fn();
      }
    );
  });

  async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
    const avatar = await screen.findByTestId("sidebar-project-avatar");
    await user.click(avatar);
    await screen.findByRole("dialog", { name: "Switch project" });
  }

  function renderSidebar() {
    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Sidebar />
        <Routes>
          <Route path="*" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("clicking a non-active project switches the active project and reloads to root", async () => {
    // The switch does a full reload (not a client-side navigate) so every
    // project-local surface re-initializes for the new project — the sidebar
    // avatar polls the current project only once on mount. Stub
    // window.location to capture the reload target.
    const originalLocation = window.location;
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });

    try {
      const user = userEvent.setup();
      renderSidebar();
      await openSwitcher(user);

      await user.click(await screen.findByTestId("sidebar-project-entry-beta"));

      await waitFor(() => {
        expect(mockSetCurrentProject).toHaveBeenCalledTimes(1);
      });
      expect(mockSetCurrentProject).toHaveBeenCalledWith("beta");
      expect(mockResetProjectScopedStores).toHaveBeenCalledTimes(1);
      // Popover closed and a full reload to root was triggered.
      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Switch project" })
        ).not.toBeInTheDocument();
      });
      expect(assignSpy).toHaveBeenCalledWith("/");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("clicking the currently-active project does not switch or navigate, just closes", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await openSwitcher(user);

    const activeEntry = await screen.findByTestId(
      "sidebar-project-entry-alpha"
    );
    expect(activeEntry).toHaveTextContent("✓");

    await user.click(activeEntry);

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Switch project" })
      ).not.toBeInTheDocument();
    });
    expect(mockSetCurrentProject).not.toHaveBeenCalled();
    expect(mockResetProjectScopedStores).not.toHaveBeenCalled();
    expect(screen.getByTestId("loc")).toHaveTextContent("/tasks");
  });

  it("shows the linking dialog with per-file progress and resets project state after success", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/dev/code/gamma");
    let resolveInitialization!: (value: unknown) => void;
    mockInitializeProject.mockReturnValue(
      new Promise((resolve) => {
        resolveInitialization = resolve;
      })
    );
    renderSidebar();
    await openSwitcher(user);

    await user.click(await screen.findByTestId("sidebar-add-project"));

    expect(mockOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false })
    );
    // The popover closes and the linking dialog opens with the files queued.
    const dialog = await screen.findByRole("dialog", { name: "Adding gamma…" });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Switch project" })
    ).not.toBeInTheDocument();
    expect(
      await screen.findByTestId("add-project-file-state-vtb-add/SKILL.md")
    ).toHaveTextContent("queued");
    await waitFor(() => {
      expect(mockInitializeProject).toHaveBeenCalledWith(
        "/Users/dev/code/gamma",
        null
      );
    });

    // A backend progress event moves the file into the linking state.
    act(() => {
      progressHandler?.({
        payload: {
          project_slug: "gamma",
          kind: "SkillFileInstalled",
          files_copied: 1,
          relative_path: "vtb-add/SKILL.md",
          target_path: "/Users/dev/code/gamma/.claude/skills/vtb-add/SKILL.md",
        },
      });
    });
    expect(
      screen.getByTestId("add-project-file-state-vtb-add/SKILL.md")
    ).toHaveTextContent("linking");
    expect(mockResetProjectScopedStores).not.toHaveBeenCalled();

    await act(async () => {
      resolveInitialization(gammaResult);
    });

    await screen.findByRole("dialog", { name: "Project added" });
    expect(screen.getByText(/2 skill links created/)).toBeInTheDocument();
    expect(
      screen.getByTestId("add-project-file-state-vtb-add/SKILL.md")
    ).toHaveTextContent("linked");
    expect(
      screen.getByTestId("add-project-file-state-vtb-ready/SKILL.md")
    ).toHaveTextContent("linked");
    expect(mockResetProjectScopedStores).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("add-project-done"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("add-project-dialog")
      ).not.toBeInTheDocument();
    });
  });

  it("shows initialization errors in the dialog without resetting and allows retry", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/dev/code/gamma");
    mockInitializeProject
      .mockResolvedValueOnce({
        status: "error",
        error: { message: "Failed to install embedded skills: link denied" },
      })
      .mockResolvedValueOnce(gammaResult);
    renderSidebar();
    await openSwitcher(user);

    await user.click(await screen.findByTestId("sidebar-add-project"));

    await screen.findByRole("dialog", { name: "Failed to add project" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to install embedded skills: link denied"
    );
    expect(mockResetProjectScopedStores).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("add-project-retry"));

    await screen.findByRole("dialog", { name: "Project added" });
    expect(mockInitializeProject).toHaveBeenCalledTimes(2);
    expect(mockResetProjectScopedStores).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cannot be dismissed while initialization is in flight", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/dev/code/gamma");
    let resolveInitialization!: (value: unknown) => void;
    mockInitializeProject.mockReturnValue(
      new Promise((resolve) => {
        resolveInitialization = resolve;
      })
    );
    renderSidebar();
    await openSwitcher(user);

    await user.click(await screen.findByTestId("sidebar-add-project"));
    await screen.findByRole("dialog", { name: "Adding gamma…" });

    // No close affordance and Escape is ignored while linking.
    expect(
      screen.queryByRole("button", { name: "Close" })
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "Adding gamma…" })
    ).toBeInTheDocument();
    expect(mockInitializeProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitialization(gammaResult);
    });
    await screen.findByRole("dialog", { name: "Project added" });

    // Once finished the dialog dismisses normally.
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByTestId("add-project-dialog")
      ).not.toBeInTheDocument();
    });
  });

  it("clicking the avatar while the switcher is open closes it (toggle)", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const avatar = await screen.findByTestId("sidebar-project-avatar");

    await user.click(avatar);
    expect(
      await screen.findByRole("dialog", { name: "Switch project" })
    ).toBeInTheDocument();

    await user.click(avatar);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Switch project" })
      ).not.toBeInTheDocument();
    });
  });
});

describe("Sidebar rail connection readout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockUseWebSocketStatus.mockReturnValue("connected");
    mockGetCurrentProject.mockResolvedValue({ status: "ok", data: null });
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
  });

  function renderSidebar() {
    render(
      <MemoryRouter initialEntries={["/board"]}>
        <Sidebar />
      </MemoryRouter>
    );
  }

  const cases = [
    { status: "connected", label: "connected", name: "Connected", token: "ok" },
    {
      status: "connecting",
      label: "connecting",
      name: "Connecting",
      token: "warn",
    },
    {
      status: "reconnecting",
      label: "connecting",
      name: "Reconnecting",
      token: "warn",
    },
    {
      status: "disconnected",
      label: "disconnected",
      name: "Disconnected",
      token: "err",
    },
  ] as const;

  for (const { status, label, name, token } of cases) {
    it(`renders the ${status} state with the ${token} token, glow, and label`, () => {
      mockUseWebSocketStatus.mockReturnValue(status);
      renderSidebar();

      const readout = screen.getByRole("status", {
        name: `WebSocket: ${name}`,
      });
      expect(readout).toHaveTextContent(label);
      expect(readout).toHaveAttribute("aria-label", `WebSocket: ${name}`);
      expect(readout).toHaveAttribute("title", `WebSocket: ${name}`);

      const dot = screen.getByTestId("rail-connection-dot");
      expect(dot).toHaveAttribute("data-status-token", token);
      expect(dot.className).not.toMatch(
        /bg-(red|green|amber|yellow|emerald|orange)-\d/
      );
    });
  }

  it("drops the app icon but keeps the single design separator above the nav", () => {
    renderSidebar();
    expect(screen.queryByLabelText("Vertebrae")).not.toBeInTheDocument();
    const aside = screen.getByRole("complementary", {
      name: "Sidebar navigation",
    });
    // Exactly one thin rule — the design rail's 20px `hr` between the project
    // monogram and the nav icons. No nav-internal dividers.
    const dividers = aside.querySelectorAll("div.h-px");
    expect(dividers).toHaveLength(1);
    expect(dividers[0].className).toContain("w-5");
    expect(aside.querySelectorAll("li.h-px")).toHaveLength(0);
  });
});
