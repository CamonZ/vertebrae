import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notification } from "../bindings";
import {
  MAX_NOTIFICATIONS,
  getUnreadNotificationCount,
  newestDurableNotification,
  useNotificationStore,
} from "./notificationStore";

const durable = (
  n: number,
  overrides: Partial<Notification> = {}
): Notification => ({
  id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
  project_id: "project-1",
  message: `Task [${n}](vtb://task/${n}) has completed.`,
  severity: "info",
  inserted_at: new Date(Date.UTC(2026, 9, 14, 20, n))
    .toISOString()
    .replace(".000Z", ".000001Z"),
  read_at: null,
  ...overrides,
});

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
    useNotificationStore.setState({
      notifications: [],
      dismissedDurableIds: new Set(),
      isPanelOpen: false,
    });
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

  it("does not read or write notification history through browser storage", () => {
    localStorage.setItem(
      "notifications",
      JSON.stringify([{ message: "stale history" }])
    );
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    useNotificationStore.getState().addNotification(input("Live activity"));
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().notifications).toEqual([
      expect.objectContaining({ message: "Live activity", read: false }),
    ]);

    getItem.mockRestore();
    setItem.mockRestore();
    localStorage.removeItem("notifications");
  });
  describe("durable notifications", () => {
    const ids = () =>
      useNotificationStore.getState().notifications.map((held) => held.id);

    it("deduplicates by ID and orders by insertion time, then ID", () => {
      const store = useNotificationStore.getState();
      const sameTime = durable(2, {
        id: "00000000-0000-4000-8000-0000000000ff",
      });
      store.upsertDurableNotifications([durable(3), sameTime, durable(2)]);
      store.upsertDurableNotifications([durable(2), durable(1)]);

      expect(ids()).toEqual([
        durable(1).id,
        durable(2).id,
        sameTime.id,
        durable(3).id,
      ]);
    });

    it("keeps the first read time and never turns a notification unread", () => {
      const store = useNotificationStore.getState();
      store.upsertDurableNotifications([durable(1)]);
      store.updateDurableNotifications([
        durable(1, { read_at: "2026-10-14T21:00:00.000000Z" }),
      ]);
      store.updateDurableNotifications([
        durable(1, { read_at: "2026-10-14T22:00:00.000000Z" }),
      ]);
      store.upsertDurableNotifications([durable(1)]);

      expect(useNotificationStore.getState().notifications[0]).toMatchObject({
        read: true,
        durable: { readAt: "2026-10-14T21:00:00.000000Z" },
      });
    });

    it("keeps dismissals until the project resets", () => {
      const store = useNotificationStore.getState();
      store.upsertDurableNotifications([durable(1), durable(2)]);
      store.removeNotification(durable(1).id);
      store.upsertDurableNotifications([durable(1)]);
      expect(ids()).toEqual([durable(2).id]);

      store.resetDurableNotifications();
      store.upsertDurableNotifications([durable(1)]);
      expect(ids()).toEqual([durable(1).id]);
    });

    it("caps durable and ephemeral notifications separately", () => {
      const store = useNotificationStore.getState();
      store.upsertDurableNotifications(
        Array.from({ length: MAX_NOTIFICATIONS + 5 }, (_, n) => durable(n))
      );
      for (let n = 0; n < MAX_NOTIFICATIONS + 5; n++) {
        store.addNotification(input(`Activity ${n}`));
      }

      const held = useNotificationStore.getState().notifications;
      expect(held.filter((n) => n.durable)).toHaveLength(MAX_NOTIFICATIONS);
      expect(held.filter((n) => !n.durable)).toHaveLength(MAX_NOTIFICATIONS);
      expect(held.some((n) => n.id === durable(4).id)).toBe(false);
      expect(held.some((n) => n.id === durable(5).id)).toBe(true);
    });

    it("leaves durable read state to Sacrum", () => {
      const store = useNotificationStore.getState();
      store.upsertDurableNotifications([durable(1)]);
      const ephemeral = store.addNotification(input("Local"));
      store.markAllRead();
      store.markRead([durable(1).id]);

      const held = useNotificationStore.getState().notifications;
      expect(held.find((n) => n.id === ephemeral)?.read).toBe(true);
      expect(held.find((n) => n.id === durable(1).id)?.read).toBe(false);
    });

    it("reports the newest held notification as the history cursor", () => {
      const store = useNotificationStore.getState();
      expect(newestDurableNotification(store.notifications)).toBeNull();
      store.upsertDurableNotifications([durable(3), durable(1)]);
      store.addNotification(input("Later local activity"));

      expect(
        newestDurableNotification(useNotificationStore.getState().notifications)
      ).toEqual({ insertedAt: durable(3).inserted_at, id: durable(3).id });
    });
  });
});
