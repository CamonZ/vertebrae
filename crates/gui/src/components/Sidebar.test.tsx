import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useStyleguideStore } from "../stores/styleguideStore";

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProject: vi.fn(() => Promise.resolve({ status: "ok", data: null })),
  },
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
