import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonBootstrap } from "../../bindings";

const mockCreateDaemon = vi.fn();
const mockSacrumConfigStatus = vi.fn();

vi.mock("../../bindings", () => ({
  commands: {
    sacrumConfigStatus: (...args: unknown[]) => mockSacrumConfigStatus(...args),
  },
}));

vi.mock("../../hooks/useDaemonMutations", () => ({
  useDaemonMutations: () => ({
    createDaemon: mockCreateDaemon,
    isBusy: false,
    error: null,
  }),
}));

import { DaemonEnrollmentModal } from "./DaemonEnrollmentModal";

const bootstrap: DaemonBootstrap = {
  daemon: {
    id: "daemon-123",
    status: "pending",
    name: "rack-03",
    display_name: "rack-03",
    enrolled_at: null,
    removed_at: null,
    inserted_at: "2026-09-12T09:00:00Z",
    updated_at: "2026-09-12T09:00:00Z",
  },
  enrollment_token: "enrollment-secret",
  expires_at: "2026-09-12T10:00:00Z",
};

describe("DaemonEnrollmentModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateDaemon.mockResolvedValue(bootstrap);
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

  it("creates a named daemon and renders the one-time enrollment command", async () => {
    const user = userEvent.setup();
    render(<DaemonEnrollmentModal open onClose={vi.fn()} />);

    await user.type(
      screen.getByTestId("daemon-enrollment-name"),
      "  rack-03  "
    );
    await user.click(screen.getByTestId("daemon-enrollment-create"));

    expect(mockCreateDaemon).toHaveBeenCalledWith("rack-03");
    expect(
      await screen.findByTestId("daemon-enrollment-token-step")
    ).toBeInTheDocument();
    expect(mockSacrumConfigStatus).toHaveBeenCalledOnce();
    expect(screen.getByText(/vtb-daemon enroll/)).toHaveTextContent(
      "https://sacrum.example.com"
    );
    expect(
      screen.getByLabelText("Hidden enrollment token")
    ).not.toHaveTextContent(bootstrap.enrollment_token);
  });

  it("reveals the enrollment token and exposes its copy action", async () => {
    const user = userEvent.setup();
    render(
      <DaemonEnrollmentModal
        open
        onClose={vi.fn()}
        initialBootstrap={bootstrap}
      />
    );

    await screen.findByText(/vtb-daemon enroll/);
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByLabelText("Enrollment token")).toHaveTextContent(
      bootstrap.enrollment_token
    );

    const tokenSection = screen.getByText(
      "One-time enrollment token"
    ).parentElement;
    expect(tokenSection).not.toBeNull();
    expect(
      within(tokenSection!).getByRole("button", { name: "Copy" })
    ).toBeInTheDocument();
  });

  it("supports cancelling from the naming step and closing the token step", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<DaemonEnrollmentModal open onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(
      <DaemonEnrollmentModal
        open
        onClose={onClose}
        initialBootstrap={bootstrap}
      />
    );
    await user.click(screen.getByTestId("daemon-enrollment-done"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("starts on the token step for a re-issued bootstrap", async () => {
    render(
      <DaemonEnrollmentModal
        open
        onClose={vi.fn()}
        initialBootstrap={bootstrap}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Re-issue token" })
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("daemon-enrollment-name-step")
    ).not.toBeInTheDocument();
    await waitFor(() => expect(mockSacrumConfigStatus).toHaveBeenCalledOnce());
  });
});
