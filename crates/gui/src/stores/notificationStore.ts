import { create } from "zustand";
import type { Notification } from "../bindings";
import type {
  NotificationEntity,
  NotificationInput,
  NotificationMessage,
} from "../types";

interface NotificationState {
  /**
   * Notifications held for the current session, oldest first: ephemeral
   * activity plus the active project's durable notifications.
   */
  notifications: NotificationMessage[];
  /** Durable notification IDs dismissed in this project session. */
  dismissedDurableIds: ReadonlySet<string>;
  /** Whether the standalone notifications panel is open. */
  isPanelOpen: boolean;
}

interface NotificationActions {
  /** Add a new unread notification and return its generated ID. */
  addNotification: (input: NotificationInput) => string;
  /**
   * Insert durable notifications or refresh the ones already held, by Sacrum
   * ID. Dismissed notifications stay hidden.
   */
  upsertDurableNotifications: (notifications: Notification[]) => void;
  /** Refresh read state on durable notifications already held. */
  updateDurableNotifications: (notifications: Notification[]) => void;
  /** Drop a durable notification Sacrum deleted. */
  deleteDurableNotification: (id: string) => void;
  /** Drop every durable notification and dismissal, for a project switch. */
  resetDurableNotifications: () => void;
  /** Remove one notification by ID; a durable one stays dismissed. */
  removeNotification: (id: string) => void;
  /** Remove all notifications from the current session. */
  clearNotifications: () => void;
  /** Mark notifications read locally; durable read state comes from Sacrum. */
  markRead: (ids: readonly string[]) => void;
  /** Mark every current ephemeral notification as read. */
  markAllRead: () => void;
  /** Set the panel visibility explicitly. */
  setPanelOpen: (open: boolean) => void;
  /** Toggle the panel visibility. */
  togglePanel: () => void;
}

export type NotificationStore = NotificationState & NotificationActions;

/**
 * Keep memory bounded while allowing the panel to show recent activity. The
 * limit applies separately to ephemeral and durable notifications, so session
 * activity never pushes project notifications out.
 */
export const MAX_NOTIFICATIONS = 50;

const NO_DISMISSALS: ReadonlySet<string> = new Set();

let notificationCounter = 0;

function durableMessage(notification: Notification): NotificationMessage {
  return {
    id: notification.id,
    message: notification.message,
    type: notification.severity,
    entity: "project",
    entityId: notification.project_id,
    timestamp: Date.parse(notification.inserted_at),
    read: notification.read_at !== null,
    durable: {
      insertedAt: notification.inserted_at,
      readAt: notification.read_at,
    },
  };
}

/** Apply Sacrum's read state; a notification never becomes unread. */
function withReadState(
  held: NotificationMessage,
  notification: Notification
): NotificationMessage {
  const readAt = held.durable?.readAt ?? notification.read_at;
  if (readAt === (held.durable?.readAt ?? null)) return held;
  return {
    ...held,
    read: true,
    durable: { insertedAt: held.durable!.insertedAt, readAt },
  };
}

/**
 * Order by time. Durable notifications break ties like Sacrum, by their
 * microsecond timestamp and then ID; other ties keep their order, since the
 * sort is stable and ephemeral notifications are held in arrival order.
 */
function compareNotifications(a: NotificationMessage, b: NotificationMessage) {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (!a.durable || !b.durable) return 0;
  if (a.durable.insertedAt !== b.durable.insertedAt) {
    return a.durable.insertedAt < b.durable.insertedAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Keep the newest of each kind, ordered by time. */
function capped(notifications: NotificationMessage[]): NotificationMessage[] {
  const ephemeral = notifications.filter(
    (notification) => !notification.durable
  );
  const durable = notifications
    .filter((notification) => notification.durable)
    .sort(compareNotifications);
  return [
    ...ephemeral.slice(-MAX_NOTIFICATIONS),
    ...durable.slice(-MAX_NOTIFICATIONS),
  ].sort(compareNotifications);
}

export const useNotificationStore = create<NotificationStore>()((set) => ({
  notifications: [],
  dismissedDurableIds: NO_DISMISSALS,
  isPanelOpen: false,

  addNotification: (input) => {
    const id = `notification-${++notificationCounter}`;
    const notification: NotificationMessage = {
      id,
      message: input.message,
      type: input.type,
      entity: input.entity,
      entityId: input.entityId,
      timestamp: input.timestamp ?? Date.now(),
      read: false,
    };

    set((state) => ({
      notifications: capped([...state.notifications, notification]),
    }));

    return id;
  },

  upsertDurableNotifications: (incoming) => {
    set((state) => {
      const held = new Map(
        state.notifications.map((notification) => [
          notification.id,
          notification,
        ])
      );
      let changed = false;
      for (const notification of incoming) {
        if (state.dismissedDurableIds.has(notification.id)) continue;
        const existing = held.get(notification.id);
        const next = existing
          ? withReadState(existing, notification)
          : durableMessage(notification);
        if (next !== existing) {
          held.set(notification.id, next);
          changed = true;
        }
      }
      return changed ? { notifications: capped([...held.values()]) } : state;
    });
  },

  updateDurableNotifications: (incoming) => {
    const byId = new Map(
      incoming.map((notification) => [notification.id, notification])
    );
    set((state) => {
      let changed = false;
      const notifications = state.notifications.map((held) => {
        const notification = held.durable ? byId.get(held.id) : undefined;
        if (!notification) return held;
        const next = withReadState(held, notification);
        changed ||= next !== held;
        return next;
      });
      return changed ? { notifications } : state;
    });
  },

  deleteDurableNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter(
        (notification) => !(notification.durable && notification.id === id)
      ),
    }));
  },

  resetDurableNotifications: () => {
    set((state) => ({
      notifications: state.notifications.filter(
        (notification) => !notification.durable
      ),
      dismissedDurableIds: NO_DISMISSALS,
    }));
  },

  removeNotification: (id) => {
    set((state) => {
      const removed = state.notifications.find(
        (notification) => notification.id === id
      );
      const dismissedDurableIds = removed?.durable
        ? new Set([...state.dismissedDurableIds, id])
        : state.dismissedDurableIds;
      return {
        notifications: state.notifications.filter(
          (notification) => notification.id !== id
        ),
        dismissedDurableIds,
      };
    });
  },

  clearNotifications: () => {
    set((state) => ({
      notifications: [],
      dismissedDurableIds: new Set([
        ...state.dismissedDurableIds,
        ...state.notifications
          .filter((notification) => notification.durable)
          .map((notification) => notification.id),
      ]),
    }));
  },

  markRead: (ids) => {
    const marked = new Set(ids);
    set((state) => ({
      notifications: state.notifications.map((notification) =>
        marked.has(notification.id) && !notification.durable
          ? { ...notification, read: true }
          : notification
      ),
    }));
  },

  markAllRead: () => {
    set((state) => ({
      notifications: state.notifications.map((notification) =>
        notification.durable ? notification : { ...notification, read: true }
      ),
    }));
  },

  setPanelOpen: (open) => {
    set({ isPanelOpen: open });
  },

  togglePanel: () => {
    set((state) => ({ isPanelOpen: !state.isPanelOpen }));
  },
}));

/** Return the number of unread notifications in a snapshot. */
export function getUnreadNotificationCount(
  notifications: NotificationMessage[]
): number {
  return notifications.reduce(
    (count, notification) => count + (notification.read ? 0 : 1),
    0
  );
}

/**
 * The newest durable notification held, as a history cursor. Dismissed
 * notifications are not held, so the cursor may be older than the newest
 * one seen; history re-sends those and the dismissal hides them again.
 */
export function newestDurableNotification(
  notifications: NotificationMessage[]
): { insertedAt: string; id: string } | null {
  let newest: NotificationMessage | null = null;
  for (const notification of notifications) {
    if (!notification.durable) continue;
    if (!newest || compareNotifications(newest, notification) < 0) {
      newest = notification;
    }
  }
  return newest?.durable
    ? { insertedAt: newest.durable.insertedAt, id: newest.id }
    : null;
}

/** Convenience constructor for ephemeral notification input. */
export function createNotificationInput(
  message: string,
  type: NotificationInput["type"],
  entity: NotificationEntity,
  entityId: string,
  timestamp?: number
): NotificationInput {
  return { message, type, entity, entityId, timestamp };
}
