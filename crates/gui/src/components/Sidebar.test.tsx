import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useStyleguideStore } from "../stores/styleguideStore";

const mockGetCurrentProject = vi.fn();
const mockGetProjects = vi.fn();
const mockSetCurrentProject = vi.fn();
const mockAddProject = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProject: (...args: unknown[]) => mockGetCurrentProject(...args),
    getProjects: (...args: unknown[]) => mockGetProjects(...args),
    setCurrentProject: (...args: unknown[]) => mockSetCurrentProject(...args),
    addProject: (...args: unknown[]) => mockAddProject(...args),
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

vi.mock("../hooks/useScopedChat", () => ({
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
    useStyleguideStore.setState({ isStyleguideNavVisible: false });
    mockGetCurrentProject.mockResolvedValue({ status: "ok", data: null });
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
    mockSetCurrentProject.mockResolvedValue({ status: "ok", data: null });
    mockAddProject.mockResolvedValue({
      status: "ok",
      data: { slug: "new", project_id: "id", path: "/new" },
    });
  });

  it("renders the primary nav in design-rail order with 14px icons", () => {
    render(
      <MemoryRouter initialEntries={["/operations"]}>
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
      <MemoryRouter initialEntries={["/operations"]}>
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
      <MemoryRouter initialEntries={["/operations"]}>
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

  it("hides the Styleguide nav until it has been revealed", () => {
    render(
      <MemoryRouter initialEntries={["/operations"]}>
        <Sidebar />
      </MemoryRouter>
    );

    expect(screen.queryByTestId("sidebar-nav-styleguide")).not.toBeInTheDocument();
  });

  it("renders a Styleguide nav link pointing at /styleguide when revealed", () => {
    useStyleguideStore.getState().revealStyleguideNav();

    render(
      <MemoryRouter initialEntries={["/operations"]}>
        <Sidebar />
      </MemoryRouter>
    );

    const link = screen.getByTestId("sidebar-nav-styleguide");
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/styleguide");
  });

  it("clicking the Styleguide nav navigates to /styleguide", async () => {
    const user = userEvent.setup();
    useStyleguideStore.getState().revealStyleguideNav();

    render(
      <MemoryRouter initialEntries={["/operations"]}>
        <Sidebar />
        <Routes>
          <Route path="*" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("sidebar-nav-styleguide"));

    await waitFor(() => {
      expect(screen.getByTestId("loc")).toHaveTextContent("/styleguide");
    });
  });
});

describe("Sidebar project switcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockUseWebSocketStatus.mockReturnValue("connected");
    useStyleguideStore.setState({ isStyleguideNavVisible: false });
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
    mockAddProject.mockResolvedValue({
      status: "ok",
      data: { slug: "new", project_id: "id", path: "/new" },
    });
  });

  async function openSwitcher(user: ReturnType<typeof userEvent.setup>) {
    const avatar = await screen.findByTestId("sidebar-project-avatar");
    await user.click(avatar);
    await screen.findByRole("dialog", { name: "Switch project" });
  }

  function renderSidebar() {
    render(
      <MemoryRouter initialEntries={["/operations"]}>
        <Sidebar />
        <Routes>
          <Route path="*" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("clicking a non-active project switches the active project and reloads to root", async () => {
    // The switch does a full reload (not a client-side navigate) so every
    // project-scoped surface re-initializes for the new project — the sidebar
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

    const activeEntry = await screen.findByTestId("sidebar-project-entry-alpha");
    expect(activeEntry).toHaveTextContent("✓");

    await user.click(activeEntry);

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Switch project" })
      ).not.toBeInTheDocument();
    });
    expect(mockSetCurrentProject).not.toHaveBeenCalled();
    expect(mockResetProjectScopedStores).not.toHaveBeenCalled();
    expect(screen.getByTestId("loc")).toHaveTextContent("/operations");
  });

  it("clicking the + button opens the directory picker and adds a project", async () => {
    const user = userEvent.setup();
    mockOpenDialog.mockResolvedValue("/Users/dev/code/gamma");
    renderSidebar();
    await openSwitcher(user);

    await user.click(await screen.findByTestId("sidebar-add-project"));

    await waitFor(() => {
      expect(mockOpenDialog).toHaveBeenCalledTimes(1);
    });
    expect(mockOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false })
    );
    await waitFor(() => {
      expect(mockAddProject).toHaveBeenCalledWith("/Users/dev/code/gamma");
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
    useStyleguideStore.setState({ isStyleguideNavVisible: false });
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

      const readout = screen.getByRole("status", { name: `WebSocket: ${name}` });
      expect(readout).toHaveTextContent(label);
      expect(readout).toHaveAttribute("aria-label", `WebSocket: ${name}`);
      expect(readout).toHaveAttribute("title", `WebSocket: ${name}`);

      expect(readout).toHaveClass("[writing-mode:vertical-rl]");
      expect(readout).toHaveClass("rotate-180");
      expect(readout).toHaveClass("mt-auto");

      const dot = screen.getByTestId("rail-connection-dot");
      expect(dot).toHaveClass(`bg-[var(--color-${token})]`);
      expect(dot).toHaveClass(
        `shadow-[0_0_6px_color-mix(in_oklch,var(--color-${token})_60%,transparent)]`
      );
      expect(dot).toHaveClass("[writing-mode:horizontal-tb]");
      expect(dot).toHaveClass("rotate-180");
      expect(dot.className).not.toMatch(
        /bg-(red|green|amber|yellow|emerald|orange)-\d/
      );
    });
  }

  it("drops the app icon (LogoMark) and the top separators from the rail", () => {
    renderSidebar();
    expect(screen.queryByLabelText("Vertebrae")).not.toBeInTheDocument();
    const aside = screen.getByRole("complementary", {
      name: "Sidebar navigation",
    });
    const dividers = aside.querySelectorAll("div.h-px");
    expect(dividers).toHaveLength(0);
    expect(aside.querySelectorAll("li.h-px")).toHaveLength(0);
  });
});
