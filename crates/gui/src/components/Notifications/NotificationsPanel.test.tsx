import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "../../test/test-utils";
import { getUnreadNotificationCount, useNotificationStore } from "../../stores";
import type { NotificationInput } from "../../types";
import {
  NotificationsPanel,
  formatNotificationAge,
} from "./NotificationsPanel";

const NOW = 1_700_000_000_000;

function addNotification(overrides: Partial<NotificationInput> = {}) {
  const input = {
    message: "Task abc123 updated",
    type: "info" as const,
    entity: "task" as const,
    entityId: "task-abc123",
    timestamp: NOW,
    ...overrides,
  };
  return useNotificationStore.getState().addNotification(input);
}

describe("NotificationsPanel", () => {
  beforeEach(() => {
    act(() => {
      useNotificationStore.setState({
        notifications: [],
        isPanelOpen: true,
      });
    });
  });

  afterEach(() => {
    act(() => {
      useNotificationStore.setState({
        notifications: [],
        isPanelOpen: false,
      });
    });
  });

  it("does not render while closed", () => {
    act(() => useNotificationStore.getState().setPanelOpen(false));
    render(<NotificationsPanel />);

    expect(screen.queryByTestId("notifications-panel")).not.toBeInTheDocument();
  });

  it("renders newest activity first in a glass side panel", () => {
    addNotification({
      message: "Task abc123 created",
      timestamp: NOW - 60_000,
    });
    addNotification({
      message: "Step def456 completed",
      type: "success",
      entity: "step",
      entityId: "step-def456",
      timestamp: NOW,
    });

    render(<NotificationsPanel />);

    const list = screen.getByTestId("notification-list");
    expect(screen.getByTestId("notifications-panel")).toHaveClass(
      "detail-float",
      "notifications-panel"
    );
    expect(list.textContent?.indexOf("Step def456 completed")).toBeLessThan(
      list.textContent?.indexOf("Task abc123 created") ?? -1
    );
    expect(screen.getByText("2 unread")).toBeInTheDocument();
    expect(screen.getByText("2 notices")).toBeInTheDocument();
    expect(screen.queryByText("All")).not.toBeInTheDocument();
    expect(screen.queryByText(/days?/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/notification settings/i)
    ).not.toBeInTheDocument();
  });

  it("marks all items read without removing ephemeral activity", () => {
    addNotification();
    addNotification({
      message: "Step def456 failed",
      type: "error",
      entity: "step",
    });
    render(<NotificationsPanel />);

    act(() => useNotificationStore.getState().markAllRead());

    expect(screen.getByText("0 unread")).toBeInTheDocument();
    expect(screen.getByText("2 notices")).toBeInTheDocument();
    expect(
      getUnreadNotificationCount(useNotificationStore.getState().notifications)
    ).toBe(0);
    expect(screen.queryAllByLabelText("Unread")).toHaveLength(0);
  });

  it("dismisses one item from the session feed", () => {
    const id = addNotification();
    render(<NotificationsPanel />);

    act(() => useNotificationStore.getState().removeNotification(id));

    expect(screen.queryByTestId(`notification-${id}`)).not.toBeInTheDocument();
    expect(screen.getByText("0 notices")).toBeInTheDocument();
  });
});

describe("formatNotificationAge", () => {
  it.each([
    [0, "now"],
    [59_000, "now"],
    [60_000, "1m"],
    [3_600_000, "1h"],
    [86_400_000, "1d"],
  ])("formats %i milliseconds as %s", (elapsed, expected) => {
    expect(formatNotificationAge(NOW - elapsed, NOW)).toBe(expected);
  });
});
