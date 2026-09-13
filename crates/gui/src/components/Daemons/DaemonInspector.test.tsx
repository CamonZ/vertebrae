import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Daemon } from "../../bindings";
import { DaemonInspector } from "./DaemonInspector";

const daemon: Daemon = {
  id: "daemon-123",
  status: "active",
  name: "rack-03",
  display_name: "rack-03",
  enrolled_at: "2026-09-12T09:00:00Z",
  removed_at: null,
  inserted_at: "2026-09-12T08:00:00Z",
  updated_at: "2026-09-12T09:30:00Z",
};

function renderInspector(
  overrides: Partial<React.ComponentProps<typeof DaemonInspector>> = {}
) {
  return render(
    <DaemonInspector
      daemon={daemon}
      isLoading={false}
      error={null}
      onClose={vi.fn()}
      onReissue={vi.fn()}
      onUnregister={vi.fn()}
      onExitAnimationEnd={vi.fn()}
      {...overrides}
    />
  );
}

describe("DaemonInspector", () => {
  it("renders loading, error, and not-found states", () => {
    const { rerender } = renderInspector({ daemon: null, isLoading: true });
    expect(screen.getByTestId("daemon-inspector-loading")).toBeInTheDocument();

    rerender(
      <DaemonInspector
        daemon={null}
        isLoading={false}
        error="Unable to load daemon"
        onClose={vi.fn()}
        onReissue={vi.fn()}
        onUnregister={vi.fn()}
        onExitAnimationEnd={vi.fn()}
      />
    );
    expect(screen.getByTestId("daemon-inspector-error")).toHaveTextContent(
      "Unable to load daemon"
    );

    rerender(
      <DaemonInspector
        daemon={null}
        isLoading={false}
        error={null}
        onClose={vi.fn()}
        onReissue={vi.fn()}
        onUnregister={vi.fn()}
        onExitAnimationEnd={vi.fn()}
      />
    );
    expect(
      screen.getByTestId("daemon-inspector-not-found")
    ).toBeInTheDocument();
  });

  it("renders daemon identity, readiness, status, and action errors", () => {
    renderInspector({
      actionError: "The token could not be re-issued",
    });

    expect(screen.getByTestId("daemon-inspector-title")).toHaveTextContent(
      "rack-03"
    );
    expect(screen.getByTestId("daemon-inspector-status")).toHaveTextContent(
      "Active"
    );
    expect(screen.getByText("daemon-123")).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(
      screen.getByTestId("daemon-inspector-action-error")
    ).toHaveTextContent("The token could not be re-issued");
  });

  it("shows the pending enrollment notice", () => {
    renderInspector({ daemon: { ...daemon, status: "pending" } });

    expect(screen.getByTestId("daemon-inspector-pending")).toHaveTextContent(
      "pending enrollment"
    );
    expect(screen.getByTestId("daemon-inspector-status")).toHaveTextContent(
      "Pending"
    );
  });

  it("fires close, re-issue, and confirmed unregister actions", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onReissue = vi.fn();
    const onUnregister = vi.fn();
    renderInspector({ onClose, onReissue, onUnregister });

    await user.click(screen.getByTestId("daemon-inspector-close"));
    await user.click(screen.getByTestId("daemon-inspector-reissue"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onReissue).toHaveBeenCalledWith(daemon.id);

    await user.click(screen.getByTestId("daemon-inspector-unregister"));
    expect(onUnregister).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Unregister?" }));
    expect(onUnregister).toHaveBeenCalledWith(daemon.id);
  });
});
