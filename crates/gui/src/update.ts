import { check } from "@tauri-apps/plugin-updater";
import { useNotificationStore } from "./stores";

export interface GuiUpdateInfo {
  currentVersion: string;
  version: string;
}

/**
 * Check the signed GUI update manifest without downloading, installing, or
 * relaunching the application. Installation remains an explicit user action.
 */
export async function checkGuiUpdate(): Promise<GuiUpdateInfo | null> {
  try {
    const update = await check();
    if (!update) return null;

    return {
      currentVersion: update.currentVersion,
      version: update.version,
    };
  } catch {
    // A failed optional check must never prevent the current GUI from
    // starting. The next launch can retry against the same signed channel.
    return null;
  }
}

/** Add one session notification for a newly discovered GUI version. */
export function notifyGuiUpdateAvailable(update: GuiUpdateInfo): void {
  const entityId = `gui-update-${update.version}`;
  const { notifications, addNotification } = useNotificationStore.getState();
  if (
    notifications.some(
      (notification) =>
        notification.entity === "application" &&
        notification.entityId === entityId
    )
  ) {
    return;
  }

  addNotification({
    message: `Vertebrae ${update.version} is available.`,
    type: "info",
    entity: "application",
    entityId,
  });
}
