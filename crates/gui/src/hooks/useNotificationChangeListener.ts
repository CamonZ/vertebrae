import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, events, type NotificationChangedEvent } from "../bindings";
import {
  newestDurableNotification,
  useNotificationStore,
} from "../stores/notificationStore";
import {
  getProjectScopeGeneration,
  isCurrentProjectScopeGeneration,
  useProjectScopeGeneration,
} from "../stores/projectScopedStores";

/** Sacrum's largest history page and mark-read batch. */
export const NOTIFICATION_BATCH_SIZE = 200;

/**
 * How far before the newest held notification recovery resumes. Sacrum
 * stamps `inserted_at` before commit, so a notification can become visible
 * slightly after a later-stamped one; overlap is deduplicated by ID.
 */
export const NOTIFICATION_RECOVERY_REWIND_MS = 5_000;

/** Sorts before every real ID at the same timestamp. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Load durable notification history into the store for `generation`.
 *
 * With nothing held, this loads every unread notification. Otherwise it
 * loads everything after the newest held notification, rewound by
 * {@link NOTIFICATION_RECOVERY_REWIND_MS}. Pages that arrive after a project
 * switch are dropped.
 */
export async function loadNotificationHistory(generation: number) {
  const newest = newestDurableNotification(
    useNotificationStore.getState().notifications
  );
  const unreadOnly = newest === null;
  let after = newest && {
    insertedAt: new Date(
      Date.parse(newest.insertedAt) - NOTIFICATION_RECOVERY_REWIND_MS
    ).toISOString(),
    id: NIL_UUID,
  };

  for (;;) {
    const result = await commands.listProjectNotifications(
      after?.insertedAt ?? null,
      after?.id ?? null,
      NOTIFICATION_BATCH_SIZE,
      unreadOnly
    );
    if (!isCurrentProjectScopeGeneration(generation)) return;
    if (result.status === "error") {
      console.warn(
        "[NotificationChangeListener] History request failed:",
        result.error.message
      );
      return;
    }

    const { notifications, has_more } = result.data;
    useNotificationStore.getState().upsertDurableNotifications(notifications);
    const last = notifications[notifications.length - 1];
    if (!has_more || !last) return;
    after = { insertedAt: last.inserted_at, id: last.id };
  }
}

/**
 * Mark durable notifications read in Sacrum, in batches, and apply the read
 * state Sacrum returns. A failed batch leaves its notifications unread.
 */
export async function markDurableNotificationsRead(
  ids: readonly string[]
): Promise<boolean> {
  const generation = getProjectScopeGeneration();
  for (let start = 0; start < ids.length; start += NOTIFICATION_BATCH_SIZE) {
    const result = await commands.markNotificationsRead(
      ids.slice(start, start + NOTIFICATION_BATCH_SIZE)
    );
    if (!isCurrentProjectScopeGeneration(generation)) return false;
    if (result.status === "error") {
      console.warn(
        "[NotificationChangeListener] Mark read failed:",
        result.error.message
      );
      return false;
    }
    useNotificationStore.getState().updateDurableNotifications(result.data);
  }
  return true;
}

function applyNotificationChange({
  change_type,
  notification,
}: NotificationChangedEvent) {
  const store = useNotificationStore.getState();
  switch (change_type) {
    case "Created":
      store.upsertDurableNotifications([notification]);
      return;
    case "Updated":
      store.updateDurableNotifications([notification]);
      return;
    case "Deleted":
      store.deleteDurableNotification(notification.id);
      return;
  }
}

/**
 * Keep the active project's durable notifications in the Activity store:
 * load history when the project scope starts, apply realtime changes, and
 * recover what was missed whenever the WebSocket (re)connects.
 */
export function useNotificationChangeListener(
  options: { enabled?: boolean } = {}
) {
  const { enabled = true } = options;
  const generation = useProjectScopeGeneration();

  useEffect(() => {
    if (!enabled) return;

    let loading = false;
    let reloadRequested = false;
    const recover = async () => {
      if (loading) {
        reloadRequested = true;
        return;
      }
      loading = true;
      try {
        do {
          reloadRequested = false;
          await loadNotificationHistory(generation);
        } while (
          reloadRequested &&
          isCurrentProjectScopeGeneration(generation)
        );
      } finally {
        loading = false;
      }
    };

    const unlistenChanges = events.notificationChangedEvent.listen((event) => {
      if (!isCurrentProjectScopeGeneration(generation)) return;
      applyNotificationChange(event.payload);
    });
    const unlistenConnection = listen<string>(
      "websocket-state-changed",
      (event) => {
        if (event.payload === "connected") void recover();
      }
    );
    void recover();

    return () => {
      void unlistenChanges.then((unlisten) => unlisten());
      void unlistenConnection.then((unlisten) => unlisten());
    };
  }, [enabled, generation]);
}
