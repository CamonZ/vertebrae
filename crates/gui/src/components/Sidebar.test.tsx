import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import {
  resetGuiUpdateState,
  useGuiUpdateStore,
} from "../stores/guiUpdateStore";

const mockGetCurrentProject = vi.fn();
const mockGetProjects = vi.fn();
const mockSetCurrentProject = vi.fn();
const mockInitializeProject = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProject: (...args: unknown[]) => mockGetCurrentProject(...args),
    getProjects: (...args: unknown[]) => mockGetProjects(...args),
    setCurrentProject: (...args: unknown[]) => mockSetCurrentProject(...args),
    initializeProject: (...args: unknown[]) => mockInitializeProject(...args),
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
    resetGuiUpdateState();
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
      "sidebar-nav-artifacts",
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

    const settingsLink = screen.getByTestId("sidebar-nav-settings");
    expect(screen.getByTestId("sidebar-settings-utility")).toContainElement(
      settingsLink
    );
    expect(settingsLink.querySelector("svg")).not.toBeNull();
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

  it("shows the Settings badge when a GUI update is available", () => {
    useGuiUpdateStore.setState({
      ...useGuiUpdateStore.getState(),
      available: {
        channel: "release",
        currentVersion: "0.1.0",
        version: "0.2.0",
      },
      status: "available",
    });

    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Sidebar />
      </MemoryRouter>
    );

    expect(
      screen.getByTestId("sidebar-nav-settings-badge")
    ).toBeInTheDocument();
  });
});

describe("Sidebar project switcher", () => {
  const gammaResult = {
    status: "ok",
    data: {
      slug: "gamma",
      project_id: "id",
      project_name: "gamma",
      path: "/Users/dev/code/gamma",
      project_created: true,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
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

  it("initializes and selects an added project without a linking dialog or progress UI", async () => {
    const originalLocation = window.location;
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/dev/code/gamma");
    let resolveInitialization!: (value: unknown) => void;
    mockInitializeProject.mockReturnValue(
      new Promise((resolve) => {
        resolveInitialization = resolve;
      })
    );
    try {
      renderSidebar();
      await openSwitcher(user);

      await user.click(await screen.findByTestId("sidebar-add-project"));

      expect(mockOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ directory: true, multiple: false })
      );
      expect(
        screen.getByRole("dialog", { name: "Switch project" })
      ).toBeInTheDocument();
      expect(screen.getByTestId("sidebar-add-project")).toHaveTextContent(
        "Adding project…"
      );
      expect(
        screen.queryByTestId("add-project-dialog")
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/skill/i)).not.toBeInTheDocument();
      await waitFor(() => {
        expect(mockInitializeProject).toHaveBeenCalledWith(
          "/Users/dev/code/gamma",
          null
        );
      });

      await act(async () => {
        resolveInitialization(gammaResult);
      });

      expect(mockSetCurrentProject).toHaveBeenCalledWith("gamma");
      expect(mockResetProjectScopedStores).toHaveBeenCalledTimes(1);
      expect(assignSpy).toHaveBeenCalledWith("/");
      expect(
        screen.queryByRole("dialog", { name: "Switch project" })
      ).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("shows initialization errors inline without selecting and allows retry", async () => {
    const originalLocation = window.location;
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/dev/code/gamma");
    mockInitializeProject
      .mockResolvedValueOnce({
        status: "error",
        error: { message: "Sacrum is unavailable" },
      })
      .mockResolvedValueOnce(gammaResult);
    try {
      renderSidebar();
      await openSwitcher(user);

      await user.click(await screen.findByTestId("sidebar-add-project"));

      expect(
        await screen.findByTestId("sidebar-add-project-error")
      ).toHaveTextContent("Sacrum is unavailable");
      expect(mockSetCurrentProject).not.toHaveBeenCalled();
      expect(mockResetProjectScopedStores).not.toHaveBeenCalled();
      expect(assignSpy).not.toHaveBeenCalled();

      await user.click(screen.getByTestId("sidebar-add-project-retry"));

      await waitFor(() => {
        expect(mockInitializeProject).toHaveBeenCalledTimes(2);
        expect(mockSetCurrentProject).toHaveBeenCalledWith("gamma");
      });
      expect(mockResetProjectScopedStores).toHaveBeenCalledTimes(1);
      expect(assignSpy).toHaveBeenCalledWith("/");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("surfaces project selection failures without resetting or reloading", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/dev/code/gamma");
    mockSetCurrentProject.mockResolvedValue({
      status: "error",
      error: { message: "Could not select gamma" },
    });
    renderSidebar();
    await openSwitcher(user);

    await user.click(await screen.findByTestId("sidebar-add-project"));

    expect(
      await screen.findByTestId("sidebar-add-project-error")
    ).toHaveTextContent("Could not select gamma");
    expect(mockInitializeProject).toHaveBeenCalledTimes(1);
    expect(mockSetCurrentProject).toHaveBeenCalledWith("gamma");
    expect(mockResetProjectScopedStores).not.toHaveBeenCalled();
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
