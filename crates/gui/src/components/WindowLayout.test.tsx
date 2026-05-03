import { describe, it, expect, vi } from "vitest";
import { render, screen } from "../test/test-utils";

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
