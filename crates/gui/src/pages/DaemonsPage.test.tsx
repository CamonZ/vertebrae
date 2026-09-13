import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Daemon } from "../bindings";

const mockUseDaemonFleet = vi.fn();
const mockUseDaemonDetail = vi.fn();
const mockUseWebSocketStatus = vi.fn();
const mockUseDaemonMutations = vi.fn();
const mockCreateDaemon = vi.fn();
const mockRotateDaemonCredentials = vi.fn();
const mockUnregisterDaemon = vi.fn();
const mockSacrumConfigStatus = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    sacrumConfigStatus: (...args: unknown[]) => mockSacrumConfigStatus(...args),
  },
}));

vi.mock("../hooks/useDaemonFleet", () => ({
  useDaemonFleet: (...args: unknown[]) => mockUseDaemonFleet(...args),
}));
vi.mock("../hooks/useDaemonDetail", () => ({
  useDaemonDetail: (...args: unknown[]) => mockUseDaemonDetail(...args),
}));
vi.mock("../hooks/useWebSocketStatus", () => ({
  useWebSocketStatus: () => mockUseWebSocketStatus(),
}));
vi.mock("../hooks/useDaemonMutations", () => ({
  useDaemonMutations: (...args: unknown[]) => mockUseDaemonMutations(...args),
}));
vi.mock("../hooks/useShellHeader", () => ({
  useShellHeader: vi.fn(),
}));

import { DaemonsPage } from "./DaemonsPage";

const daemon = (
  id: string,
  status: string,
  overrides: Partial<Daemon> & Record<string, unknown> = {}
): Daemon =>
  ({
    id,
    status,
    name: id,
    display_name: id,
    enrolled_at: null,
    removed_at: null,
    inserted_at: null,
    updated_at: null,
    ...overrides,
  }) as Daemon;

const active = daemon("active-1", "active", { host: "alpha-host" });
const pending = daemon("pending-1", "pending");
const unknown = daemon("foreign-1", "paused");

function fleet(overrides: Record<string, unknown> = {}) {
  return {
    daemons: [active, pending, unknown],
    isLoading: false,
    isRefreshing: false,
    error: null,
    errorKind: null,
    connectionId: "identity-a",
    refetch: vi.fn(),
    ...overrides,
  };
}

function renderPage() {
  return render(<DaemonsPage />);
}

describe("DaemonsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseDaemonFleet.mockReturnValue(fleet());
    mockUseDaemonDetail.mockReturnValue({
      data: null,
      isLoading: false,
      isRefreshing: false,
      error: null,
      errorKind: null,
      connectionId: "identity-a",
      refetch: vi.fn(),
    });
    mockUseWebSocketStatus.mockReturnValue("connected");
    mockUseDaemonMutations.mockReturnValue({
      createDaemon: mockCreateDaemon,
      rotateDaemonCredentials: mockRotateDaemonCredentials,
      unregisterDaemon: mockUnregisterDaemon,
      isBusy: false,
      error: null,
    });
    mockCreateDaemon.mockResolvedValue({
      daemon: daemon("new-daemon", "pending"),
      enrollment_token: "sacrum_enrollment_token",
      expires_at: "2026-09-12T09:35:00Z",
    });
    mockRotateDaemonCredentials.mockResolvedValue({
      daemon: active,
      enrollment_token: "rotated_enrollment_token",
      expires_at: "2026-09-12T09:35:00Z",
    });
    mockUnregisterDaemon.mockResolvedValue(
      daemon(active.id, "removed", { removed_at: "2026-09-12T10:00:00Z" })
    );
    mockSacrumConfigStatus.mockResolvedValue({
      status: "ok",
      data: {
        url: "https://sacrum.example.com",
        config_path: null,
        config_exists: true,
        has_token: true,
      },
    });
  });

  it("shows status counts and groups all fleet statuses", () => {
    renderPage();

    expect(screen.getByTestId("daemon-group-active")).toBeInTheDocument();
    expect(screen.getByTestId("daemon-group-pending")).toBeInTheDocument();
    expect(screen.getByTestId("daemon-group-unknown")).toBeInTheDocument();
    expect(
      screen.queryByTestId("daemon-status-filter-all")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("daemon-status-filter-active")).toHaveTextContent(
      /Active\s*1/
    );
    expect(
      screen.getByTestId("daemon-status-filter-pending")
    ).toHaveTextContent(/Pending\s*1/);
    expect(
      screen.getByTestId("daemon-status-filter-revoked")
    ).toHaveTextContent(/Revoked\s*0/);
    expect(
      screen.getByTestId("daemon-status-filter-removed")
    ).toHaveTextContent(/Removed\s*0/);
    expect(
      screen.queryByTestId("daemon-status-filter-unknown")
    ).not.toBeInTheDocument();
  });

  it("intersects search and status filters", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("daemon-status-filter-active"));
    expect(screen.getByTestId("daemon-row-active-1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("daemon-row-pending-1")
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId("daemon-status-filter-active"));
    expect(screen.getByTestId("daemon-row-pending-1")).toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search daemons" });
    await user.clear(search);
    await user.type(search, "alpha-host");
    expect(screen.getByTestId("daemon-row-active-1")).toBeInTheDocument();
    expect(
      screen.queryByTestId("daemon-fleet-no-matches")
    ).not.toBeInTheDocument();
  });

  it("keeps last-known rows visible with a stale error and marks pending separately", () => {
    mockUseDaemonFleet.mockReturnValue(
      fleet({ error: "request failed", errorKind: "unavailable" })
    );
    renderPage();

    expect(screen.getByTestId("daemon-fleet-stale")).toHaveTextContent(
      "last known"
    );
    expect(screen.getByTestId("daemon-row-status-pending-1")).toHaveTextContent(
      "Pending"
    );
    expect(screen.getByTestId("daemon-row-active-1")).toBeInTheDocument();
  });

  it("updates the responsive inspector selection and clears focus on close", async () => {
    const user = userEvent.setup();
    mockUseDaemonDetail.mockImplementation((id: string | null) => ({
      data: id ? (id === active.id ? active : pending) : null,
      isLoading: false,
      isRefreshing: false,
      error: null,
      errorKind: null,
      connectionId: "identity-a",
      refetch: vi.fn(),
    }));
    renderPage();

    await user.click(screen.getByTestId("daemon-row-active-1"));
    expect(screen.getByTestId("daemon-inspector")).toBeInTheDocument();
    expect(screen.getByTestId("daemon-inspector-title")).toHaveTextContent(
      "active-1"
    );
    expect(
      screen.getByRole("button", { name: "Close daemon inspector" })
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("daemon-row-pending-1"));
    expect(screen.getByTestId("daemon-inspector-title")).toHaveTextContent(
      "pending-1"
    );
    expect(screen.getByTestId("daemon-inspector-pending")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Close daemon inspector" })
    );
    await waitFor(() =>
      expect(screen.getByTestId("daemon-row-pending-1")).not.toHaveFocus()
    );
  });

  it("clears row focus when Escape closes the inspector", async () => {
    const user = userEvent.setup();
    mockUseDaemonDetail.mockImplementation((id: string | null) => ({
      data: id === active.id ? active : null,
      isLoading: false,
      isRefreshing: false,
      error: null,
      errorKind: null,
      connectionId: "identity-a",
      refetch: vi.fn(),
    }));
    renderPage();

    const row = screen.getByTestId("daemon-row-active-1");
    await user.click(row);
    expect(row).toHaveFocus();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(row).not.toHaveFocus());
  });

  it("uses the current fleet lifecycle state when detail data is stale", async () => {
    const user = userEvent.setup();
    mockUseDaemonDetail.mockImplementation((id: string | null) => ({
      data:
        id === active.id
          ? daemon(active.id, "pending")
          : id === pending.id
            ? pending
            : null,
      isLoading: false,
      isRefreshing: false,
      error: null,
      errorKind: null,
      connectionId: "identity-a",
      refetch: vi.fn(),
    }));
    renderPage();

    await user.click(screen.getByTestId("daemon-row-active-1"));

    expect(screen.getByTestId("daemon-inspector-status")).toHaveTextContent(
      "Active"
    );
    expect(
      screen.queryByTestId("daemon-inspector-pending")
    ).not.toBeInTheDocument();
  });

  it("re-issues a token from the inspector and opens the enrollment step", async () => {
    const user = userEvent.setup();
    mockUseDaemonDetail.mockImplementation((id: string | null) => ({
      data: id === active.id ? active : null,
      isLoading: false,
      isRefreshing: false,
      error: null,
      errorKind: null,
      connectionId: "identity-a",
      refetch: vi.fn(),
    }));
    renderPage();

    await user.click(screen.getByTestId("daemon-row-active-1"));
    await user.click(screen.getByTestId("daemon-inspector-reissue"));

    await waitFor(() =>
      expect(mockRotateDaemonCredentials).toHaveBeenCalledWith(active.id)
    );
    expect(
      screen.getByTestId("daemon-enrollment-token-step")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByText("rotated_enrollment_token")).toBeInTheDocument();
  });

  it("confirms unregistering a daemon before closing its inspector", async () => {
    const user = userEvent.setup();
    mockUseDaemonDetail.mockImplementation((id: string | null) => ({
      data: id === active.id ? active : null,
      isLoading: false,
      isRefreshing: false,
      error: null,
      errorKind: null,
      connectionId: "identity-a",
      refetch: vi.fn(),
    }));
    renderPage();

    await user.click(screen.getByTestId("daemon-row-active-1"));
    await user.click(screen.getByTestId("daemon-inspector-unregister"));
    expect(
      screen.getByRole("button", { name: "Unregister?" })
    ).toBeInTheDocument();
    expect(mockUnregisterDaemon).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Unregister?" }));
    await waitFor(() =>
      expect(mockUnregisterDaemon).toHaveBeenCalledWith(active.id)
    );
  });

  it("does not keep a removed selection from the detail cache", async () => {
    const user = userEvent.setup();
    let daemons = [active, pending, unknown];
    mockUseDaemonFleet.mockImplementation(() => fleet({ daemons }));
    mockUseDaemonDetail.mockImplementation((id: string | null) => ({
      data: id === active.id ? active : null,
      isLoading: false,
      isRefreshing: false,
      error: null,
      errorKind: null,
      connectionId: "identity-a",
      refetch: vi.fn(),
    }));
    const view = renderPage();

    await user.click(screen.getByTestId("daemon-row-active-1"));
    expect(screen.getByTestId("daemon-inspector-title")).toHaveTextContent(
      "active-1"
    );

    daemons = [pending, unknown];
    view.rerender(<DaemonsPage />);

    expect(
      screen.getByTestId("daemon-inspector-not-found")
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("daemon-inspector")).toHaveAttribute(
        "data-closing",
        "true"
      )
    );
  });

  it("refreshes the fleet when the shell reconnects without treating that as daemon health", async () => {
    const refetch = vi.fn();
    mockUseDaemonFleet.mockReturnValue(fleet({ refetch }));
    mockUseWebSocketStatus.mockReturnValue("reconnecting");
    const view = renderPage();

    mockUseWebSocketStatus.mockReturnValue("connected");
    view.rerender(<DaemonsPage />);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByTestId("daemon-fleet-sync-state")
    ).not.toBeInTheDocument();
  });

  it("walks through daemon registration and shows the one-time enrollment command", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("daemon-register"));
    expect(
      screen.getByTestId("daemon-enrollment-name-step")
    ).toBeInTheDocument();

    await user.type(screen.getByTestId("daemon-enrollment-name"), "rack-03");
    await user.click(screen.getByTestId("daemon-enrollment-create"));

    expect(
      await screen.findByTestId("daemon-enrollment-token-step")
    ).toBeInTheDocument();
    expect(mockCreateDaemon).toHaveBeenCalledWith("rack-03");
    expect(screen.getByText(/vtb-daemon enroll/)).toHaveTextContent(
      "https://sacrum.example.com"
    );
    expect(
      screen.queryByText(/sacrum_enrollment_token/)
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByText("sacrum_enrollment_token")).toBeInTheDocument();

    await user.click(screen.getByTestId("daemon-enrollment-done"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("daemon-enrollment-token-step")
      ).not.toBeInTheDocument()
    );
  });
});
