import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_NOTIFICATIONS,
  getUnreadNotificationCount,
  useNotificationStore,
} from "./notificationStore";

const input = (message: string, entityId = "task-1") => ({
  message,
  type: "info" as const,
  entity: "task" as const,
  entityId,
});

describe("notificationStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T10:00:00.000Z"));
    useNotificationStore.setState({ notifications: [], isPanelOpen: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts empty and closed for a new session", () => {
    expect(useNotificationStore.getState().notifications).toEqual([]);
    expect(useNotificationStore.getState().isPanelOpen).toBe(false);
  });

  it("adds timestamped unread task and step notifications", () => {
    const store = useNotificationStore.getState();
    const taskId = store.addNotification(input("Task updated"));
    const stepId = store.addNotification({
      ...input("Step completed", "step-1"),
      type: "success",
      entity: "step",
    });

    expect(useNotificationStore.getState().notifications).toEqual([
      {
        id: taskId,
        message: "Task updated",
        type: "info",
        entity: "task",
        entityId: "task-1",
        timestamp: new Date("2026-08-06T10:00:00.000Z").getTime(),
        read: false,
      },
      {
        id: stepId,
        message: "Step completed",
        type: "success",
        entity: "step",
        entityId: "step-1",
        timestamp: new Date("2026-08-06T10:00:00.000Z").getTime(),
        read: false,
      },
    ]);
    expect(
      getUnreadNotificationCount(useNotificationStore.getState().notifications)
    ).toBe(2);
  });

  it("honors an explicit timestamp", () => {
    useNotificationStore.getState().addNotification({
      ...input("Earlier activity"),
      timestamp: 123,
    });

    expect(useNotificationStore.getState().notifications[0].timestamp).toBe(
      123
    );
  });

  it("keeps only the most recent bounded records", () => {
    for (let index = 0; index < MAX_NOTIFICATIONS + 2; index += 1) {
      useNotificationStore
        .getState()
        .addNotification(input(`Notification ${index}`));
    }

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(MAX_NOTIFICATIONS);
    expect(notifications[0].message).toBe("Notification 2");
    expect(notifications[notifications.length - 1]?.message).toBe(
      `Notification ${MAX_NOTIFICATIONS + 1}`
    );
  });

  it("marks all records read without deleting them", () => {
    useNotificationStore.getState().addNotification(input("First"));
    useNotificationStore.getState().addNotification(input("Second"));

    useNotificationStore.getState().markAllRead();

    expect(useNotificationStore.getState().notifications).toHaveLength(2);
    expect(
      getUnreadNotificationCount(useNotificationStore.getState().notifications)
    ).toBe(0);
  });

  it("supports panel visibility and removal actions", () => {
    const store = useNotificationStore.getState();
    const id = store.addNotification(input("Dismiss me"));

    store.setPanelOpen(true);
    expect(useNotificationStore.getState().isPanelOpen).toBe(true);
    store.togglePanel();
    expect(useNotificationStore.getState().isPanelOpen).toBe(false);

    store.removeNotification(id);
    expect(useNotificationStore.getState().notifications).toEqual([]);
  });

  it("clears the current session without persistence", () => {
    useNotificationStore.getState().addNotification(input("Clear me"));
    useNotificationStore.getState().setPanelOpen(true);

    useNotificationStore.getState().clearNotifications();

    expect(useNotificationStore.getState().notifications).toEqual([]);
    expect(useNotificationStore.getState().isPanelOpen).toBe(true);
  });
});
