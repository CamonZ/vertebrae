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

function LocationDisplay() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

describe("Sidebar Traces nav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useStyleguideStore.setState({ isStyleguideNavVisible: false });
    mockGetCurrentProject.mockResolvedValue({ status: "ok", data: null });
    mockGetProjects.mockResolvedValue({ status: "ok", data: [] });
    mockSetCurrentProject.mockResolvedValue({ status: "ok", data: null });
    mockAddProject.mockResolvedValue({
      status: "ok",
      data: { slug: "new", project_id: "id", path: "/new" },
    });
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
