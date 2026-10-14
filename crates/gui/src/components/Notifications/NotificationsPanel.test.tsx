import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "../../test/test-utils";
import type { Notification } from "../../bindings";
import { getUnreadNotificationCount, useNotificationStore } from "../../stores";
import type { NotificationInput } from "../../types";

const { markDurableNotificationsRead } = vi.hoisted(() => ({
  markDurableNotificationsRead: vi.fn(),
}));
vi.mock("../../hooks/useNotificationChangeListener", () => ({
  markDurableNotificationsRead,
}));

import {
  NotificationsPanel,
  formatNotificationAge,
} from "./NotificationsPanel";

const TASK_ID = "3f1d9f6e-5c1b-4f8e-9f55-0b6f0c7d2a11";
const ARTIFACT_ID = "9b7c1a52-1f0e-4f43-a0c7-2b8d7e6b1c10";

function addDurable(overrides: Partial<Notification> = {}) {
  const notification: Notification = {
    id: "0aec77c7-319d-449d-a3b3-d6d8cdb6ffad",
    project_id: "76267e24-a4e4-4230-88f1-33bd69cfd5ff",
    message: `Artifact [report](vtb://artifact/${ARTIFACT_ID}) has been added to task [Ship \\[it\\]](vtb://task/${TASK_ID}).`,
    severity: "success",
    inserted_at: new Date(NOW).toISOString(),
    read_at: null,
    ...overrides,
  };
  useNotificationStore.getState().upsertDurableNotifications([notification]);
  return notification;
}

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
        dismissedDurableIds: new Set(),
        isPanelOpen: true,
      });
      markDurableNotificationsRead.mockReset();
      markDurableNotificationsRead.mockResolvedValue(true);
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

  it("copies the full entity ID from the shared notification ID chip", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const fullId = "task-abc123-full-id";
    addNotification({ entityId: fullId });
    render(<NotificationsPanel />);

    expect(screen.getByTestId(/notification-id-/)).toHaveTextContent(
      fullId.slice(0, 8)
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Copy full task ID" })
      );
    });

    expect(writeText).toHaveBeenCalledWith(fullId);
  });

  it("dismisses one item from the session feed", () => {
    const id = addNotification();
    render(<NotificationsPanel />);

    act(() => useNotificationStore.getState().removeNotification(id));

    expect(screen.queryByTestId(`notification-${id}`)).not.toBeInTheDocument();
    expect(screen.getByText("0 notices")).toBeInTheDocument();
  });
});

describe("NotificationsPanel durable notifications", () => {
  beforeEach(() => {
    act(() => {
      useNotificationStore.setState({
        notifications: [],
        dismissedDurableIds: new Set(),
        isPanelOpen: true,
      });
    });
    markDurableNotificationsRead.mockReset();
    markDurableNotificationsRead.mockResolvedValue(true);
  });

  it("renders the Markdown message with inline entity links", () => {
    const notification = addDurable();
    render(<NotificationsPanel />);

    const message = screen.getByTestId(
      `notification-markdown-${notification.id}`
    );
    expect(message).toHaveTextContent(
      "Artifact report has been added to task Ship [it]."
    );
    const links = screen.getAllByTestId("vtb-entity-link");
    expect(links.map((link) => link.getAttribute("data-vtb-route"))).toEqual([
      `/artifacts?artifactId=${ARTIFACT_ID}`,
      `/tasks?taskId=${TASK_ID}`,
    ]);
    expect(screen.getByText("SUCCESS")).toBeInTheDocument();
    expect(screen.queryByTestId(/notification-id-/)).not.toBeInTheDocument();
  });

  it("marks durable notifications read in Sacrum and ephemeral ones locally", () => {
    const notification = addDurable();
    addNotification();
    addDurable({
      id: "1aec77c7-319d-449d-a3b3-d6d8cdb6ffad",
      read_at: "2026-10-14T21:00:00.000000Z",
    });
    render(<NotificationsPanel />);
    expect(screen.getByText("2 unread")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

    expect(markDurableNotificationsRead).toHaveBeenCalledWith([
      notification.id,
    ]);
    // The durable notification stays unread until Sacrum confirms it.
    expect(screen.getByText("1 unread")).toBeInTheDocument();
  });

  it("marks one durable notification read from its item or a followed link", () => {
    const notification = addDurable();
    render(<NotificationsPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "Mark notification read" })
    );
    expect(markDurableNotificationsRead).toHaveBeenLastCalledWith([
      notification.id,
    ]);

    fireEvent.click(screen.getAllByTestId("vtb-entity-link")[1]);
    expect(markDurableNotificationsRead).toHaveBeenCalledTimes(2);
  });

  it("dismisses a durable notification without contacting Sacrum", () => {
    const notification = addDurable();
    render(<NotificationsPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: `Dismiss ${notification.message}` })
    );

    expect(screen.getByText("0 notices")).toBeInTheDocument();
    expect(markDurableNotificationsRead).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().dismissedDurableIds).toContain(
      notification.id
    );
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
