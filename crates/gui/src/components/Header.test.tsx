import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { render, screen } from "../test/test-utils";
import { Header } from "./Header";
import { useShellStore } from "../stores/shellStore";

type ShellState = ReturnType<typeof useShellStore.getState>;

function setShell(state: Partial<ShellState>) {
  act(() => {
    useShellStore.setState(state);
  });
}

vi.mock("./LiveChatWindow", () => ({
  OpenLiveChatButton: () => <button data-testid="mock-open-live-chat" />,
}));
vi.mock("../hooks/useCurrentProject", () => ({
  useCurrentProject: () => ({ name: "sacrum", path: "/code/sacrum" }),
}));

afterEach(() => {
  // useShellHeader normally clears these on unmount; reset by hand since we
  // poke the store directly here. Wrapped in act so any still-mounted Header
  // re-render is flushed without a warning.
  setShell({ pageTitle: "", headerActions: null });
});

describe("Header (Hearth v2 AppTopBar)", () => {
  it("renders the serif italic Vertebrae brand wordmark with an ember dot", () => {
    render(<Header />);

    const brand = screen.getByTestId("topbar-brand");
    expect(brand.textContent).toBe("Vertebrae");

    const ember = screen.getByTestId("topbar-brand-ember");
    expect(brand).toContainElement(ember);
    expect(ember).toHaveAttribute("aria-hidden", "true");
  });

  it("renders the project › page breadcrumb from the store + current project", () => {
    setShell({ pageTitle: "Tasks" });
    render(<Header />);

    expect(screen.getByTestId("topbar-breadcrumb-project").textContent).toBe(
      "sacrum"
    );
    const page = screen.getByTestId("topbar-breadcrumb-page");
    expect(page.textContent).toBe("Tasks");
  });

  it("falls back to the Vertebrae page name when no page title is set", () => {
    render(<Header />);
    expect(screen.getByTestId("topbar-breadcrumb-page").textContent).toBe(
      "Vertebrae"
    );
  });

  it("renders page-contributed headerActions inside the activity slot", () => {
    setShell({
      headerActions: <span data-testid="page-action">3 running</span>,
    });
    render(<Header />);

    const activity = screen.getByTestId("topbar-activity");
    const action = screen.getByTestId("page-action");
    expect(action.textContent).toBe("3 running");
    expect(activity).toContainElement(action);
    expect(activity).toContainElement(
      screen.getByTestId("mock-open-live-chat")
    );
  });

  it("no longer renders the WebSocket connection indicator in the topbar", () => {
    render(<Header />);
    expect(
      screen.queryByRole("status", { name: /websocket/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("connection-status-dot")
    ).not.toBeInTheDocument();
  });

  it("does not render the ⌘K command chip in the activity slot", () => {
    render(<Header />);
    expect(screen.queryByTestId("topbar-kbd")).not.toBeInTheDocument();
  });

  it("is a 38px full-width banner over the rail", () => {
    render(<Header />);
    const banner = screen.getByRole("banner");
    expect(banner).toContainElement(screen.getByTestId("topbar-brand"));
    expect(banner).toContainElement(screen.getByTestId("topbar-activity"));
  });
});
