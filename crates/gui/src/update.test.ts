import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@tauri-apps/plugin-updater";
import {
  resetGuiUpdateState,
  useGuiUpdateStore,
} from "./stores/guiUpdateStore";
import {
  GUI_UPDATE_CHANNEL,
  GUI_UPDATE_INTERVAL_MS,
  checkGuiUpdate,
  createGuiUpdateScheduler,
  guiUpdateNotificationId,
  notifyGuiUpdateAvailable,
  resetGuiUpdateNotificationDeduplication,
  type GuiUpdateInfo,
} from "./update";
import { useNotificationStore } from "./stores";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

const checkMock = vi.mocked(check);

function updaterResult(
  currentVersion: string,
  version: string
): Awaited<ReturnType<typeof check>> {
  return { currentVersion, version } as Awaited<ReturnType<typeof check>>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("GUI update checker", () => {
  beforeEach(() => {
    checkMock.mockReset();
    resetGuiUpdateState();
    resetGuiUpdateNotificationDeduplication();
    useNotificationStore.setState({ notifications: [], isPanelOpen: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns no update when the signed channel is current", async () => {
    checkMock.mockResolvedValue(null);

    await expect(checkGuiUpdate()).resolves.toBeNull();
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("reports an available version without installing or relaunching", async () => {
    const downloadAndInstall = vi.fn();
    const install = vi.fn();
    const relaunch = vi.fn();
    const updater = updaterResult("0.1.0", "0.2.0") as NonNullable<
      Awaited<ReturnType<typeof check>>
    >;
    checkMock.mockResolvedValue({
      ...updater,
      downloadAndInstall,
      install,
      relaunch,
    } as unknown as Awaited<ReturnType<typeof check>>);

    await expect(checkGuiUpdate()).resolves.toEqual({
      channel: GUI_UPDATE_CHANNEL,
      currentVersion: "0.1.0",
      version: "0.2.0",
    });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("does not block startup when checking fails", async () => {
    checkMock.mockRejectedValue(new Error("network unavailable"));

    await expect(checkGuiUpdate()).resolves.toBeNull();
  });

  it("deduplicates notifications by channel and release identity", () => {
    const update: GuiUpdateInfo = {
      channel: "release",
      currentVersion: "0.1.0",
      version: "0.2.0",
    };

    notifyGuiUpdateAvailable(update);
    notifyGuiUpdateAvailable(update);

    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    const releaseNotification =
      useNotificationStore.getState().notifications[0];
    useNotificationStore.getState().removeNotification(releaseNotification.id);
    notifyGuiUpdateAvailable(update);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);

    const previewUpdate = { ...update, channel: "master" };
    notifyGuiUpdateAvailable(previewUpdate);
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      entity: "application",
      entityId: guiUpdateNotificationId(previewUpdate),
      message: "Vertebrae 0.2.0 is available.",
      type: "info",
    });
  });

  it("checks immediately and once per interval", async () => {
    vi.useFakeTimers();
    checkMock.mockResolvedValue(null);
    const scheduler = createGuiUpdateScheduler();

    scheduler.start();
    expect(checkMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(GUI_UPDATE_INTERVAL_MS - 1);
    expect(checkMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(checkMock).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("does not overlap a slow request and retains the result for the next interval", async () => {
    vi.useFakeTimers();
    const first = deferred<Awaited<ReturnType<typeof check>>>();
    const second = deferred<Awaited<ReturnType<typeof check>>>();
    checkMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const scheduler = createGuiUpdateScheduler();

    scheduler.start();
    await vi.advanceTimersByTimeAsync(GUI_UPDATE_INTERVAL_MS);
    expect(checkMock).toHaveBeenCalledTimes(1);

    first.resolve(updaterResult("0.1.0", "0.2.0"));
    await flushPromises();
    expect(useGuiUpdateStore.getState().available?.version).toBe("0.2.0");

    await vi.advanceTimersByTimeAsync(GUI_UPDATE_INTERVAL_MS);
    expect(checkMock).toHaveBeenCalledTimes(2);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);

    second.resolve(null);
    await flushPromises();
    scheduler.stop();
  });

  it("preserves the last known availability when a later check fails", async () => {
    vi.useFakeTimers();
    checkMock
      .mockResolvedValueOnce(updaterResult("0.1.0", "0.2.0"))
      .mockRejectedValueOnce(new Error("network unavailable"));
    const scheduler = createGuiUpdateScheduler();

    scheduler.start();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(GUI_UPDATE_INTERVAL_MS);
    await flushPromises();

    expect(useGuiUpdateStore.getState()).toMatchObject({
      available: {
        channel: GUI_UPDATE_CHANNEL,
        currentVersion: "0.1.0",
        version: "0.2.0",
      },
      checking: false,
      error: "network unavailable",
      status: "error",
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);

    scheduler.stop();
  });

  it("cleans up the interval and ignores an in-flight callback", async () => {
    vi.useFakeTimers();
    const pending = deferred<Awaited<ReturnType<typeof check>>>();
    checkMock.mockReturnValue(pending.promise);
    const scheduler = createGuiUpdateScheduler();

    scheduler.start();
    expect(useGuiUpdateStore.getState().checking).toBe(true);
    const stateBeforeStop = useGuiUpdateStore.getState();
    scheduler.stop();

    pending.resolve(updaterResult("0.1.0", "0.2.0"));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(GUI_UPDATE_INTERVAL_MS * 2);

    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(useGuiUpdateStore.getState()).toEqual(stateBeforeStop);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });
});
