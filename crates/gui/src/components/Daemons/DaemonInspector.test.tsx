import { render, screen, waitFor, within } from "@testing-library/react";
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
    const onUnregister = vi.fn().mockResolvedValue(true);
    renderInspector({ onClose, onReissue, onUnregister });

    await user.click(screen.getByTestId("daemon-inspector-close"));
    await user.click(screen.getByTestId("daemon-inspector-reissue"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onReissue).toHaveBeenCalledWith(daemon.id);

    await user.click(screen.getByTestId("daemon-inspector-delete-button"));
    expect(onUnregister).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("daemon-lifecycle-confirmation")
    ).toHaveTextContent("no runs will be orphaned");
    await user.click(screen.getByTestId("daemon-lifecycle-confirm-unregister"));
    expect(onUnregister).toHaveBeenCalledWith(daemon.id);
  });

  it("renames from the editor with Enter and restores the old value on Escape", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn().mockResolvedValue(true);
    const view = renderInspector({ onRename });
    const editor = within(screen.getByTestId("daemon-inspector-name-editor"));

    await user.click(editor.getByText("rack-03"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "rack-04{Enter}");
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith(daemon.id, {
        kind: "set",
        value: "rack-04",
      })
    );

    view.rerender(
      <DaemonInspector
        daemon={daemon}
        isLoading={false}
        error={null}
        onClose={vi.fn()}
        onRename={onRename}
        onReissue={vi.fn()}
        onUnregister={vi.fn().mockResolvedValue(true)}
        onExitAnimationEnd={vi.fn()}
      />
    );
    await user.click(
      within(screen.getByTestId("daemon-inspector-name-editor")).getByText(
        "rack-03"
      )
    );
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "discarded");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("daemon-inspector-name-editor")).getByText(
        "rack-03"
      )
    ).toBeInTheDocument();
  });

  it("keeps an active-work unregister refusal visible and truthful", async () => {
    const user = userEvent.setup();
    const onUnregister = vi.fn().mockResolvedValue(false);
    renderInspector({
      onUnregister,
      actionError:
        "The server refused to unregister this daemon because active work or a live session is still present. Drain the daemon first; no work was orphaned.",
      actionErrorKind: "active_session",
      lifecycleAction: "unregister",
    });

    await user.click(screen.getByTestId("daemon-inspector-delete-button"));
    await user.click(screen.getByTestId("daemon-lifecycle-confirm-unregister"));

    expect(onUnregister).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("daemon-lifecycle-confirmation")
    ).toHaveTextContent("no work was orphaned");
    expect(
      screen
        .getAllByTestId("daemon-lifecycle-status")
        .some((status) =>
          status.textContent?.includes("Drain the daemon first")
        )
    ).toBe(true);
  });

  it("shows revoked state without offering credential controls", () => {
    renderInspector({ daemon: { ...daemon, status: "revoked" } });

    expect(
      screen.getByTestId("daemon-inspector-reenrollment-status")
    ).toHaveTextContent("controlled by the server");
    expect(screen.getByTestId("daemon-inspector-reissue")).toBeDisabled();
  });
});
