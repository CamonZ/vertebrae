import { check } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { useNotificationStore } from "./stores/notificationStore";
import {
  GUI_UPDATE_CHANNELS,
  GUI_UPDATE_CHANNEL,
  useGuiUpdateStore,
  type GuiUpdateChannel,
  type GuiUpdateChannelState,
  type GuiUpdateInfo,
  type GuiUpdateTransactionResult,
} from "./stores/guiUpdateStore";

export { GUI_UPDATE_CHANNEL } from "./stores/guiUpdateStore";
export type { GuiUpdateInfo } from "./stores/guiUpdateStore";
export type { GuiUpdateTransactionResult } from "./stores/guiUpdateStore";

export const GUI_UPDATE_INTERVAL_MS = 15 * 60 * 1000;

function applyStateForResult(result: GuiUpdateTransactionResult) {
  if (result.state === "retryable_failure") return "retryable_failure" as const;
  if (result.state === "partial_failure") return "partial_failure" as const;
  return "success" as const;
}

export async function applyApprovedGuiUpdate(
  update: GuiUpdateInfo
): Promise<GuiUpdateTransactionResult | null> {
  useGuiUpdateStore.setState((state) => ({
    ...state,
    apply: { status: "applying", result: null },
  }));

  try {
    const result = await invoke<GuiUpdateTransactionResult>(
      "apply_approved_component_update",
      {
        approved: true,
        channel: update.channel ?? GUI_UPDATE_CHANNEL,
        version: update.version,
        build: update.build ?? null,
      }
    );
    const status = applyStateForResult(result);
    useGuiUpdateStore.setState((state) => ({
      ...state,
      apply: { status, result },
    }));
    return result;
  } catch (reason) {
    const message = updateCheckErrorMessage(reason);
    useGuiUpdateStore.setState((state) => ({
      ...state,
      apply: { status: "error", message },
    }));
    return null;
  }
}

export async function relaunchGuiApplication(): Promise<void> {
  await invoke("relaunch_application");
}

/**
 * Check the signed GUI update manifest without downloading, installing, or
 * relaunching the application. Installation remains an explicit user action.
 */
async function readGuiUpdate(): Promise<GuiUpdateInfo | null> {
  const update = await check();
  if (!update) return null;

  // Tauri exposes `body` and `date` from the updater manifest. Keep the
  // adapter tolerant of the optional release metadata added to newer
  // manifests while preserving the small legacy result used by the checker
  // tests and existing callers.
  const metadata = update as unknown as {
    body?: unknown;
    build?: unknown;
    channel?: unknown;
    components?: GuiUpdateInfo["components"];
    date?: unknown;
    notes?: unknown;
    preflight?: GuiUpdateInfo["verification"];
    pub_date?: unknown;
    releaseNotes?: unknown;
    verification?: GuiUpdateInfo["verification"];
  };
  const releaseNotes = [
    metadata.releaseNotes,
    metadata.body,
    metadata.notes,
  ].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  const publicationDate = [metadata.date, metadata.pub_date].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  const build =
    typeof metadata.build === "string" && metadata.build.length > 0
      ? metadata.build
      : undefined;
  const channel =
    typeof metadata.channel === "string" && metadata.channel.length > 0
      ? metadata.channel
      : GUI_UPDATE_CHANNEL;

  return {
    channel,
    currentVersion: update.currentVersion,
    version: update.version,
    ...(build ? { build } : {}),
    ...(publicationDate
      ? { date: publicationDate, publishedAt: publicationDate }
      : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(metadata.components ? { components: metadata.components } : {}),
    ...(metadata.verification
      ? { verification: metadata.verification }
      : metadata.preflight
        ? { verification: metadata.preflight }
        : {}),
  };
}

export interface GuiUpdateChannelCheck extends GuiUpdateChannelState {
  channel: GuiUpdateChannel;
  endpoint: string;
}

interface NativeGuiUpdateChannelStatus {
  channel: GuiUpdateChannel;
  endpoint: string;
  available: boolean;
  release: {
    currentVersion: string;
    version: string;
    date: string | null;
    body: string | null;
    rawJson: Record<string, unknown>;
    isUpdate: boolean;
  } | null;
  error: string | null;
}

function updateFromChannelRelease(
  status: NativeGuiUpdateChannelStatus
): GuiUpdateInfo | null {
  const release = status.release;
  if (!status.available || !release || !release.isUpdate) return null;

  const metadata = release.rawJson;
  const releaseNotes = [
    metadata.releaseNotes,
    metadata.body,
    metadata.notes,
    release.body,
  ].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  const publicationDate = [
    metadata.date,
    metadata.pub_date,
    metadata.pubDate,
    release.date,
  ].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  return {
    channel: status.channel,
    currentVersion: release.currentVersion,
    version: release.version,
    ...(typeof metadata.build === "string" && metadata.build.length > 0
      ? { build: metadata.build }
      : {}),
    ...(publicationDate
      ? { date: publicationDate, publishedAt: publicationDate }
      : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(metadata.components ? { components: metadata.components } : {}),
    ...(metadata.verification
      ? { verification: metadata.verification }
      : metadata.preflight
        ? { verification: metadata.preflight }
        : {}),
  };
}

/** Check both signed release channels without downloading or installing. */
export async function checkGuiUpdateChannels(): Promise<
  GuiUpdateChannelCheck[]
> {
  const statuses = await invoke<NativeGuiUpdateChannelStatus[]>(
    "check_gui_update_channels"
  );

  return statuses.map((status) => ({
    channel: status.channel,
    endpoint: status.endpoint,
    available: status.available,
    currentVersion: status.release?.currentVersion ?? null,
    latestVersion: status.release?.version ?? null,
    update: updateFromChannelRelease(status),
    error: status.error,
  }));
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
  checkChannels?: () => Promise<GuiUpdateChannelCheck[]>;
  intervalMs?: number;
  timers?: GuiUpdateSchedulerTimers;
  reportFailure?: (message: string) => Promise<unknown>;
}

export interface GuiUpdateScheduler {
  start: () => void;
  stop: () => void;
}

const notifiedGuiUpdateIds = new Set<string>();

function updateCheckErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (reason && typeof reason === "object") {
    try {
      return JSON.stringify(reason);
    } catch {
      // Fall through to the generic message for non-serializable errors.
    }
  }
  return "Update check failed";
}

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
  const checkChannels = options.checkChannels;
  const intervalMs = options.intervalMs ?? GUI_UPDATE_INTERVAL_MS;
  const timers = options.timers ?? browserTimers;
  const reportFailure =
    options.reportFailure ??
    ((message: string) =>
      invoke("diagnose_gui_update_check", { reason: message }));

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
      if (checkChannels) {
        const channelChecks = await checkChannels();
        if (!isCurrentLifecycle(generation)) return;

        const currentState = useGuiUpdateStore.getState();
        const checkedChannels = GUI_UPDATE_CHANNELS.reduce(
          (channels, channel) => {
            const checked = channelChecks.find(
              (result) => result.channel === channel
            );
            channels[channel] = checked ?? {
              available: false,
              currentVersion: null,
              latestVersion: null,
              update: null,
              error: "No signed channel result was returned.",
            };
            return channels;
          },
          {} as typeof currentState.channels
        );
        const selectedChannel = checkedChannels[currentState.selectedChannel]
          ?.available
          ? currentState.selectedChannel
          : (GUI_UPDATE_CHANNELS.find(
              (channel) => checkedChannels[channel].available
            ) ?? currentState.selectedChannel);
        const selected = checkedChannels[selectedChannel];
        const status = selected.available
          ? selected.update
            ? "available"
            : "current"
          : "unavailable";

        useGuiUpdateStore.setState((state) => ({
          ...state,
          available: selected.update,
          channels: checkedChannels,
          checking: false,
          currentVersion: selected.currentVersion,
          error: selected.error,
          selectedChannel,
          status,
        }));
        if (selected.update) notifyGuiUpdateAvailable(selected.update);
        return;
      }

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

      const message = updateCheckErrorMessage(reason);
      console.warn("[GUI updater] Signed update check failed", {
        message,
        reason,
        retryInMs: intervalMs,
      });
      void Promise.resolve()
        .then(() => reportFailure(message))
        .catch(() => undefined);

      useGuiUpdateStore.setState((state) => ({
        ...state,
        checking: false,
        // Keep `available` and `currentVersion`: a network failure is not
        // evidence that the previously observed release disappeared.
        error: message,
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
