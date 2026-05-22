import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "../test/test-utils";
import { useUIStore } from "../stores";

const mockGlobalListeners = vi.fn();

vi.mock("./GlobalListeners", () => ({
  GlobalListeners: () => {
    mockGlobalListeners();
    return <div data-testid="global-listeners" />;
  },
}));

vi.mock("./Toast", () => ({
  ToastContainer: () => <div data-testid="toast-container" />,
}));

import { WindowLayout } from "./WindowLayout";

describe("WindowLayout", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark", "light");
    useUIStore.setState({ theme: "system" });
  });

  it("renders children inside the main region", () => {
    render(
      <WindowLayout>
        <p>hello pop-out</p>
      </WindowLayout>
    );

    const main = screen.getByRole("main", { name: /pop-out window content/i });
    expect(main).toBeInTheDocument();
    expect(main.textContent).toContain("hello pop-out");
  });

  it("mounts GlobalListeners exactly once so each window bootstraps its own subscriptions", () => {
    render(
      <WindowLayout>
        <span />
      </WindowLayout>
    );

    expect(mockGlobalListeners).toHaveBeenCalled();
    expect(screen.getAllByTestId("global-listeners")).toHaveLength(1);
  });

  it("renders the toast container so pop-out windows can surface notifications", () => {
    render(
      <WindowLayout>
        <span />
      </WindowLayout>
    );

    expect(screen.getByTestId("toast-container")).toBeInTheDocument();
  });

  it("applies the selected theme inside detached windows", () => {
    useUIStore.setState({ theme: "light" });

    render(
      <WindowLayout>
        <span />
      </WindowLayout>
    );

    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("does not render Sidebar, Header, or ChatWindowManager", () => {
    render(
      <WindowLayout>
        <span />
      </WindowLayout>
    );

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });
});
