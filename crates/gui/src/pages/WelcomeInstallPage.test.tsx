import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, userEvent } from "../test/test-utils";
import type { InstallationStatus } from "../bindings";

const {
  mockInstallationStatus,
  mockInstallComponents,
  mockSkipInstallation,
  mockHasProjectSelected,
  mockNavigate,
} = vi.hoisted(() => ({
  mockInstallationStatus: vi.fn(),
  mockInstallComponents: vi.fn(),
  mockSkipInstallation: vi.fn(),
  mockHasProjectSelected: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../bindings", () => ({
  commands: {
    installationStatus: (...args: unknown[]) => mockInstallationStatus(...args),
    installComponents: (...args: unknown[]) => mockInstallComponents(...args),
    skipInstallation: (...args: unknown[]) => mockSkipInstallation(...args),
    hasProjectSelected: (...args: unknown[]) => mockHasProjectSelected(...args),
  },
}));

import { WelcomeInstallPage } from "./WelcomeInstallPage";

function makeStatus(overrides?: Partial<InstallationStatus>): InstallationStatus {
  return {
    cli: {
      installed_at_symlink: false,
      symlink_path: "/home/user/.local/bin/vtb",
      on_path: false,
    },
    daemon: {
      installed_at_symlink: false,
      symlink_path: "/home/user/.local/bin/vtb-daemon",
      on_path: false,
    },
    service: { kind: "not_loaded" },
    skipped: false,
    ...overrides,
  };
}

describe("WelcomeInstallPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInstallationStatus.mockResolvedValue({ status: "ok", data: makeStatus() });
    mockInstallComponents.mockResolvedValue({ status: "ok", data: makeStatus() });
    mockSkipInstallation.mockResolvedValue({ status: "ok", data: null });
    mockHasProjectSelected.mockResolvedValue({ status: "ok", data: false });
  });

  it("renders the symlink target paths reported by installationStatus", async () => {
    render(<WelcomeInstallPage />);

    await waitFor(() => {
      expect(screen.getByTestId("welcome-cli")).toBeInTheDocument();
    });
    expect(screen.getByTestId("welcome-cli")).toHaveTextContent(
      "/home/user/.local/bin/vtb"
    );
    expect(screen.getByTestId("welcome-daemon")).toHaveTextContent(
      "/home/user/.local/bin/vtb-daemon"
    );
  });

  it("defaults both checkboxes ON when nothing is installed", async () => {
    render(<WelcomeInstallPage />);

    await waitFor(() => {
      expect(screen.getByTestId("welcome-cli-checkbox")).toBeInTheDocument();
    });
    expect(screen.getByTestId("welcome-cli-checkbox")).toBeChecked();
    expect(screen.getByTestId("welcome-daemon-checkbox")).toBeChecked();
  });

  it("pre-checks OFF and disables a component already installed at the symlink", async () => {
    mockInstallationStatus.mockResolvedValue({
      status: "ok",
      data: makeStatus({
        cli: {
          installed_at_symlink: true,
          symlink_path: "/home/user/.local/bin/vtb",
          on_path: true,
        },
      }),
    });

    render(<WelcomeInstallPage />);

    await waitFor(() => {
      expect(screen.getByTestId("welcome-cli-checkbox")).toBeInTheDocument();
    });
    const cliCheckbox = screen.getByTestId("welcome-cli-checkbox");
    expect(cliCheckbox).not.toBeChecked();
    expect(cliCheckbox).toBeDisabled();
    expect(
      screen.getByTestId("welcome-cli-already-installed")
    ).toHaveTextContent("already installed");
    // Daemon, untouched, stays checked.
    expect(screen.getByTestId("welcome-daemon-checkbox")).toBeChecked();
  });

  it("calls installComponents with the selected checkbox state and proceeds to /setup", async () => {
    const user = userEvent.setup();
    render(<WelcomeInstallPage />);

    await waitFor(() => {
      expect(screen.getByTestId("welcome-daemon-checkbox")).toBeInTheDocument();
    });
    // Uncheck the daemon so we install CLI only.
    await user.click(screen.getByTestId("welcome-daemon-checkbox"));
    await user.click(screen.getByTestId("welcome-install"));

    await waitFor(() => {
      expect(mockInstallComponents).toHaveBeenCalledWith(true, false);
    });
    expect(screen.getByTestId("welcome-success")).toBeInTheDocument();

    await waitFor(
      () => {
        expect(mockNavigate).toHaveBeenCalledWith("/setup", { replace: true });
      },
      { timeout: 2000 }
    );
  });

  it("routes home after install when a project is already selected", async () => {
    mockHasProjectSelected.mockResolvedValue({ status: "ok", data: true });
    const user = userEvent.setup();
    render(<WelcomeInstallPage />);

    await waitFor(() => {
      expect(screen.getByTestId("welcome-install")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("welcome-install"));

    await waitFor(
      () => {
        expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
      },
      { timeout: 2000 }
    );
  });

  it("persists the skip flag and proceeds to /setup on Skip", async () => {
    const user = userEvent.setup();
    render(<WelcomeInstallPage />);

    await waitFor(() => {
      expect(screen.getByTestId("welcome-skip")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("welcome-skip"));

    await waitFor(() => {
      expect(mockSkipInstallation).toHaveBeenCalledTimes(1);
    });
    expect(mockNavigate).toHaveBeenCalledWith("/setup", { replace: true });
  });

  it("renders install errors inline without navigating", async () => {
    mockInstallComponents.mockResolvedValue({
      status: "error",
      error: { message: "could not write to ~/.local/bin" },
    });
    const user = userEvent.setup();
    render(<WelcomeInstallPage />);

    await waitFor(() => {
      expect(screen.getByTestId("welcome-install")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("welcome-install"));

    await waitFor(() => {
      expect(screen.getByTestId("welcome-error")).toHaveTextContent(
        "could not write to ~/.local/bin"
      );
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
