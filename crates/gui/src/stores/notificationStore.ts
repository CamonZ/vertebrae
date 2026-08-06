import { create } from "zustand";
import type {
  NotificationEntity,
  NotificationInput,
  NotificationMessage,
} from "../types";

interface NotificationState {
  /** Recent notifications held for the current application session. */
  notifications: NotificationMessage[];
  /** Whether the standalone notifications panel is open. */
  isPanelOpen: boolean;
}

interface NotificationActions {
  /** Add a new unread notification and return its generated ID. */
  addNotification: (input: NotificationInput) => string;
  /** Remove one notification by ID. */
  removeNotification: (id: string) => void;
  /** Remove all notifications from the current session. */
  clearNotifications: () => void;
  /** Mark every current notification as read. */
  markAllRead: () => void;
  /** Set the panel visibility explicitly. */
  setPanelOpen: (open: boolean) => void;
  /** Toggle the panel visibility. */
  togglePanel: () => void;
}

export type NotificationStore = NotificationState & NotificationActions;

/** Keep memory bounded while allowing the panel to show recent activity. */
export const MAX_NOTIFICATIONS = 50;

let notificationCounter = 0;

export const useNotificationStore = create<NotificationStore>()((set) => ({
  notifications: [],
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
      notifications: [...state.notifications, notification].slice(
        -MAX_NOTIFICATIONS
      ),
    }));

    return id;
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter(
        (notification) => notification.id !== id
      ),
    }));
  },

  clearNotifications: () => {
    set({ notifications: [] });
  },

  markAllRead: () => {
    set((state) => ({
      notifications: state.notifications.map((notification) => ({
        ...notification,
        read: true,
      })),
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

/** Convenience constructor for the two currently supported notification entities. */
export function createNotificationInput(
  message: string,
  type: NotificationInput["type"],
  entity: NotificationEntity,
  entityId: string,
  timestamp?: number
): NotificationInput {
  return { message, type, entity, entityId, timestamp };
}
