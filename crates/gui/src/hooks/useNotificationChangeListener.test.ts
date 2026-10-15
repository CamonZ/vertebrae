import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Notification,
  NotificationChangedEvent,
  NotificationPage,
} from "../bindings";
import { useNotificationStore } from "../stores";
import { resetProjectScopedStores } from "../stores/projectScopedStores";

const mockListProjectNotifications = vi.fn();
const mockMarkNotificationsRead = vi.fn();
let changeHandler:
  | ((event: { payload: NotificationChangedEvent }) => void)
  | null = null;
let connectionHandler: ((event: { payload: string }) => void) | null = null;

vi.mock("../bindings", () => ({
  commands: {
    listProjectNotifications: (...args: unknown[]) =>
      mockListProjectNotifications(...args),
    markNotificationsRead: (...args: unknown[]) =>
      mockMarkNotificationsRead(...args),
  },
  events: {
    notificationChangedEvent: {
      listen: (
        handler: (event: { payload: NotificationChangedEvent }) => void
      ) => {
        changeHandler = handler;
        return Promise.resolve(() => {});
      },
    },
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_event: string, handler: (event: { payload: string }) => void) => {
    connectionHandler = handler;
    return Promise.resolve(() => {});
  },
}));

import {
  NOTIFICATION_BATCH_SIZE,
  markDurableNotificationsRead,
  useNotificationChangeListener,
} from "./useNotificationChangeListener";

const PROJECT = "76267e24-a4e4-4230-88f1-33bd69cfd5ff";

function notification(
  n: number,
  overrides: Partial<Notification> = {}
): Notification {
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    project_id: PROJECT,
    message: `Task [${n}](vtb://task/${n}) has completed.`,
    severity: "success",
    inserted_at: new Date(Date.UTC(2026, 9, 14, 20, 0, n))
      .toISOString()
      .replace(".000Z", ".000001Z"),
    read_at: null,
    ...overrides,
  };
}

function page(
  notifications: Notification[],
  has_more = false
): { status: "ok"; data: NotificationPage } {
  return { status: "ok", data: { notifications, has_more } };
}

function durableIds() {
  return useNotificationStore
    .getState()
    .notifications.filter((held) => held.durable)
    .map((held) => held.id);
}

function emit(payload: NotificationChangedEvent) {
  act(() => changeHandler!({ payload }));
}

describe("useNotificationChangeListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    changeHandler = null;
    connectionHandler = null;
    resetProjectScopedStores();
    useNotificationStore.setState({ notifications: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads every page of unread history when the project scope starts", async () => {
    mockListProjectNotifications
      .mockResolvedValueOnce(page([notification(1), notification(2)], true))
      .mockResolvedValueOnce(page([notification(3)]));

    renderHook(() => useNotificationChangeListener());

    await waitFor(() => expect(durableIds()).toHaveLength(3));
    expect(mockListProjectNotifications.mock.calls).toEqual([
      [null, null, NOTIFICATION_BATCH_SIZE, true],
      [
        notification(2).inserted_at,
        notification(2).id,
        NOTIFICATION_BATCH_SIZE,
        true,
      ],
    ]);
    const [first] = useNotificationStore.getState().notifications;
    expect(first).toMatchObject({
      id: notification(1).id,
      message: notification(1).message,
      type: "success",
      read: false,
      durable: { insertedAt: notification(1).inserted_at, readAt: null },
    });
  });

  it("recovers after a reconnect from a rewound cursor without duplicates", async () => {
    mockListProjectNotifications.mockResolvedValueOnce(
      page([notification(10)])
    );
    renderHook(() => useNotificationChangeListener());
    await waitFor(() => expect(durableIds()).toHaveLength(1));

    mockListProjectNotifications.mockResolvedValueOnce(
      page([notification(10), notification(11)])
    );
    act(() => connectionHandler!({ payload: "connected" }));

    await waitFor(() => expect(durableIds()).toHaveLength(2));
    expect(mockListProjectNotifications).toHaveBeenLastCalledWith(
      "2026-10-14T20:00:05.000Z",
      "00000000-0000-0000-0000-000000000000",
      NOTIFICATION_BATCH_SIZE,
      false
    );
    expect(durableIds()).toEqual([notification(10).id, notification(11).id]);
  });

  it("applies realtime creates, reads and deletes by notification ID", async () => {
    mockListProjectNotifications.mockResolvedValue(page([]));
    renderHook(() => useNotificationChangeListener());
    await waitFor(() => expect(changeHandler).not.toBeNull());

    emit({ change_type: "Created", notification: notification(1) });
    emit({ change_type: "Created", notification: notification(1) });
    expect(durableIds()).toEqual([notification(1).id]);

    const readAt = "2026-10-14T21:00:00.000000Z";
    emit({
      change_type: "Updated",
      notification: notification(1, { read_at: readAt }),
    });
    // An update for a notification that is not held does not insert it.
    emit({
      change_type: "Updated",
      notification: notification(2, { read_at: readAt }),
    });
    expect(useNotificationStore.getState().notifications).toEqual([
      expect.objectContaining({
        id: notification(1).id,
        read: true,
        durable: { insertedAt: notification(1).inserted_at, readAt },
      }),
    ]);

    emit({ change_type: "Deleted", notification: notification(1) });
    expect(durableIds()).toEqual([]);
  });

  it("keeps dismissed notifications hidden when history repeats them", async () => {
    mockListProjectNotifications.mockResolvedValueOnce(
      page([notification(1), notification(2)])
    );
    renderHook(() => useNotificationChangeListener());
    await waitFor(() => expect(durableIds()).toHaveLength(2));

    act(() =>
      useNotificationStore.getState().removeNotification(notification(2).id)
    );
    mockListProjectNotifications.mockResolvedValueOnce(
      page([notification(1), notification(2)])
    );
    act(() => connectionHandler!({ payload: "connected" }));

    await waitFor(() =>
      expect(mockListProjectNotifications).toHaveBeenCalledTimes(2)
    );
    expect(durableIds()).toEqual([notification(1).id]);
  });

  it("drops history and events that arrive after a project switch", async () => {
    let resolveHistory: (value: ReturnType<typeof page>) => void = () => {};
    mockListProjectNotifications.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHistory = resolve;
      })
    );
    const { rerender } = renderHook(() => useNotificationChangeListener());
    await waitFor(() => expect(changeHandler).not.toBeNull());
    const staleHandler = changeHandler!;

    mockListProjectNotifications.mockResolvedValue(page([]));
    act(() => resetProjectScopedStores());
    rerender();
    await act(async () => resolveHistory(page([notification(1)])));
    act(() =>
      staleHandler({
        payload: { change_type: "Created", notification: notification(2) },
      })
    );

    expect(durableIds()).toEqual([]);
  });

  it("keeps ephemeral activity across a project switch", () => {
    act(() => {
      useNotificationStore.getState().addNotification({
        message: "Task updated",
        type: "info",
        entity: "task",
        entityId: "task-1",
      });
      useNotificationStore
        .getState()
        .upsertDurableNotifications([notification(1)]);
      resetProjectScopedStores();
    });

    expect(useNotificationStore.getState().notifications).toEqual([
      expect.objectContaining({ message: "Task updated" }),
    ]);
  });
});

describe("markDurableNotificationsRead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    resetProjectScopedStores();
    useNotificationStore.setState({ notifications: [] });
  });

  it("marks read in batches and applies what Sacrum returns", async () => {
    const held = Array.from({ length: 201 }, (_, n) => notification(n));
    useNotificationStore.getState().upsertDurableNotifications(held);
    const readAt = "2026-10-14T21:00:00.000000Z";
    mockMarkNotificationsRead.mockImplementation(async (ids: string[]) => ({
      status: "ok",
      data: ids.map((id) => ({ ...notification(0), id, read_at: readAt })),
    }));

    const ids = held.map((n) => n.id);
    await expect(markDurableNotificationsRead(ids)).resolves.toBe(true);

    expect(
      mockMarkNotificationsRead.mock.calls.map(([batch]) => batch.length)
    ).toEqual([200, 1]);
    expect(
      useNotificationStore.getState().notifications.every((n) => n.read)
    ).toBe(true);
  });

  it("leaves notifications unread when Sacrum refuses", async () => {
    useNotificationStore
      .getState()
      .upsertDurableNotifications([notification(1)]);
    mockMarkNotificationsRead.mockResolvedValue({
      status: "error",
      error: { message: "offline" },
    });

    await expect(
      markDurableNotificationsRead([notification(1).id])
    ).resolves.toBe(false);

    expect(useNotificationStore.getState().notifications[0].read).toBe(false);
  });
});
