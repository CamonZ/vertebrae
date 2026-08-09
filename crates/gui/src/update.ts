import { check } from "@tauri-apps/plugin-updater";
import { useNotificationStore } from "./stores/notificationStore";
import {
  GUI_UPDATE_CHANNEL,
  useGuiUpdateStore,
  type GuiUpdateInfo,
} from "./stores/guiUpdateStore";

export { GUI_UPDATE_CHANNEL } from "./stores/guiUpdateStore";
export type { GuiUpdateInfo } from "./stores/guiUpdateStore";

export const GUI_UPDATE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Check the signed GUI update manifest without downloading, installing, or
 * relaunching the application. Installation remains an explicit user action.
 */
async function readGuiUpdate(): Promise<GuiUpdateInfo | null> {
  const update = await check();
  if (!update) return null;

  return {
    channel: GUI_UPDATE_CHANNEL,
    currentVersion: update.currentVersion,
    version: update.version,
  };
}

/**
 * Safe one-shot wrapper retained for callers that only need the optional
 * result. The lifecycle scheduler uses the rejecting reader so it can expose
 * transient errors without turning them into a false "current" state.
 */
export async function checkGuiUpdate(): Promise<GuiUpdateInfo | null> {
  try {
    return await readGuiUpdate();
  } catch {
    return null;
  }
}

export interface GuiUpdateSchedulerTimers {
  setInterval: (callback: () => void, delay: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export interface GuiUpdateSchedulerOptions {
  check?: () => Promise<GuiUpdateInfo | null>;
  intervalMs?: number;
  timers?: GuiUpdateSchedulerTimers;
}

export interface GuiUpdateScheduler {
  start: () => void;
  stop: () => void;
}

const notifiedGuiUpdateIds = new Set<string>();

const browserTimers: GuiUpdateSchedulerTimers = {
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: (id) => window.clearInterval(id as number),
};

/**
 * Own the immediate check and polling interval for the GUI lifecycle.
 *
 * The scheduler is intentionally independent from React state. This keeps the
 * timer and its single-flight guard testable while allowing the App component
 * to dispose both the timer and stale promise callbacks on unmount.
 */
export function createGuiUpdateScheduler(
  options: GuiUpdateSchedulerOptions = {}
): GuiUpdateScheduler {
  const checkUpdate = options.check ?? readGuiUpdate;
  const intervalMs = options.intervalMs ?? GUI_UPDATE_INTERVAL_MS;
  const timers = options.timers ?? browserTimers;

  let started = false;
  let lifecycleGeneration = 0;
  let intervalId: unknown;
  let inFlight = false;
  let requestId = 0;
  let runAfterRestart = false;

  function isCurrentLifecycle(generation: number): boolean {
    return started && lifecycleGeneration === generation;
  }

  async function runCheck(generation: number): Promise<void> {
    if (!isCurrentLifecycle(generation) || inFlight) return;

    inFlight = true;
    const currentRequestId = ++requestId;
    useGuiUpdateStore.setState((state) => ({
      ...state,
      checking: true,
      error: null,
      status: "checking",
    }));

    try {
      const update = await checkUpdate();
      if (!isCurrentLifecycle(generation)) return;

      if (update) {
        useGuiUpdateStore.setState((state) => ({
          ...state,
          available: update,
          checking: false,
          currentVersion: update.currentVersion,
          error: null,
          status: "available",
        }));
        notifyGuiUpdateAvailable(update);
      } else {
        useGuiUpdateStore.setState((state) => ({
          ...state,
          available: null,
          checking: false,
          error: null,
          status: "current",
        }));
      }
    } catch (reason) {
      if (!isCurrentLifecycle(generation)) return;

      useGuiUpdateStore.setState((state) => ({
        ...state,
        checking: false,
        // Keep `available` and `currentVersion`: a network failure is not
        // evidence that the previously observed release disappeared.
        error: reason instanceof Error ? reason.message : "Update check failed",
        status: "error",
      }));
    } finally {
      if (requestId === currentRequestId) {
        inFlight = false;
      }

      if (started && runAfterRestart && !inFlight) {
        runAfterRestart = false;
        void runCheck(lifecycleGeneration);
      }
    }
  }

  return {
    start() {
      if (started) return;

      started = true;
      lifecycleGeneration += 1;
      const generation = lifecycleGeneration;
      if (inFlight) {
        // React StrictMode can replay an effect while the first request is
        // still pending. Wait for that request to settle before retrying so
        // the replay cannot create overlapping network calls.
        runAfterRestart = true;
      } else {
        void runCheck(generation);
      }
      intervalId = timers.setInterval(() => {
        void runCheck(lifecycleGeneration);
      }, intervalMs);
    },

    stop() {
      if (!started) return;

      started = false;
      lifecycleGeneration += 1;
      runAfterRestart = false;
      if (intervalId !== undefined) {
        timers.clearInterval(intervalId);
        intervalId = undefined;
      }
      // The updater promise cannot be cancelled by tauri-plugin-updater. Its
      // callbacks remain harmless because they fail the lifecycle-generation
      // check above, and `inFlight` stays true until the promise settles.
    },
  };
}

/** Add one session notification for a newly discovered channel/release. */
export function notifyGuiUpdateAvailable(update: GuiUpdateInfo): void {
  const entityId = guiUpdateNotificationId(update);
  const { notifications, addNotification } = useNotificationStore.getState();
  if (notifiedGuiUpdateIds.has(entityId)) return;
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
  notifiedGuiUpdateIds.add(entityId);
}

export function guiUpdateNotificationId(update: GuiUpdateInfo): string {
  return `gui-update-${update.channel ?? GUI_UPDATE_CHANNEL}-${update.version}`;
}

/** Reset session deduplication between isolated consumers/tests. */
export function resetGuiUpdateNotificationDeduplication(): void {
  notifiedGuiUpdateIds.clear();
}
