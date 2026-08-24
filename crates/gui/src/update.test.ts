import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import {
  resetGuiUpdateState,
  useGuiUpdateStore,
} from "./stores/guiUpdateStore";
import {
  GUI_UPDATE_CHANNEL,
  GUI_UPDATE_INTERVAL_MS,
  adoptLocalBackend,
  applyApprovedGuiUpdate,
  applyApprovedLocalBackendUpdate,
  checkGuiUpdate,
  checkGuiUpdateChannels,
  checkLocalBackendUpdate,
  createGuiUpdateScheduler,
  guiUpdateNotificationId,
  notifyGuiUpdateAvailable,
  resetGuiUpdateNotificationDeduplication,
  type GuiUpdateInfo,
  type LocalBackendUpdateInfo,
} from "./update";
import { useNotificationStore } from "./stores";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const checkMock = vi.mocked(check);
const invokeMock = vi.mocked(invoke);

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
    invokeMock.mockReset();
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

  it("preserves optional release metadata for the Settings review surface", async () => {
    const updater = updaterResult("0.1.0", "0.2.0") as NonNullable<
      Awaited<ReturnType<typeof check>>
    >;
    checkMock.mockResolvedValue({
      ...updater,
      body: "Signed component update",
      build: "abc1234",
      channel: "master",
      components: {
        gui: { currentVersion: "0.1.0", version: "0.2.0", status: "ready" },
      },
      date: "2026-08-10T12:00:00Z",
      verification: { signature: "Verified" },
    } as unknown as Awaited<ReturnType<typeof check>>);

    await expect(checkGuiUpdate()).resolves.toMatchObject({
      channel: "master",
      currentVersion: "0.1.0",
      version: "0.2.0",
      build: "abc1234",
      date: "2026-08-10T12:00:00Z",
      publishedAt: "2026-08-10T12:00:00Z",
      releaseNotes: "Signed component update",
      verification: { signature: "Verified" },
    });
  });

  it("does not block startup when checking fails", async () => {
    checkMock.mockRejectedValue(new Error("network unavailable"));

    await expect(checkGuiUpdate()).resolves.toBeNull();
  });

  it("starts the native transaction only for explicit approval and exposes completion", async () => {
    const result = {
      transaction_id: null,
      state: "deferred_relaunch",
      channel: "release",
      version: "0.2.0",
      build: "abc1234",
      progress: [
        { component: "cli", state: "health_checked", message: "ready" },
        { component: "daemon", state: "health_checked", message: "ready" },
        { component: "gate", state: "health_checked", message: "ready" },
        {
          component: "gui",
          state: "pending_relaunch",
          message: "deferred",
        },
      ],
      compatibility: "compatible",
      signature: "verified",
      hash: "verified",
      disk: "sufficient",
      component_readiness: "ready",
      daemon_service: "running; no restart forced",
      recovery_action: "Relaunch later",
      restart_forced: false,
    } as const;
    invokeMock.mockResolvedValue(result);

    await expect(
      applyApprovedGuiUpdate({
        channel: "release",
        currentVersion: "0.1.0",
        version: "0.2.0",
        build: "abc1234",
      })
    ).resolves.toEqual(result);

    expect(invokeMock).toHaveBeenCalledWith("apply_approved_component_update", {
      approved: true,
      channel: "release",
      version: "0.2.0",
      build: "abc1234",
    });
    expect(useGuiUpdateStore.getState().apply).toEqual({
      status: "success",
      result,
    });
  });

  it("checks the configured local backend without applying an image update", async () => {
    invokeMock.mockResolvedValue({
      configured: true,
      channel: "release",
      current_image_ref:
        "ghcr.io/camonz/sacrum@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      current_generated_at: "2026-08-20T00:00:00Z",
      latest: {
        channel: "release",
        version: "0.4.0",
        build: "backend-build",
        image_ref:
          "ghcr.io/camonz/sacrum@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        generated_at: "2026-08-21T00:00:00Z",
      },
      available: true,
    });

    await expect(checkLocalBackendUpdate()).resolves.toEqual({
      management: "managed_local",
      configured: true,
      channel: "release",
      currentVersion: null,
      currentBuild: null,
      currentImageRef:
        "ghcr.io/camonz/sacrum@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      currentImageCreatedAt: "2026-08-20T00:00:00Z",
      update: {
        channel: "release",
        currentImageRef:
          "ghcr.io/camonz/sacrum@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        currentImageCreatedAt: "2026-08-20T00:00:00Z",
        version: "0.4.0",
        build: "backend-build",
        imageRef:
          "ghcr.io/camonz/sacrum@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        generatedAt: "2026-08-21T00:00:00Z",
      },
      adoptionMessage: null,
      diagnostic: null,
      error: null,
    });
    expect(invokeMock).toHaveBeenCalledWith("check_local_backend_update");
  });

  it("reports an adoptable loopback legacy backend without auto-adopting it", async () => {
    invokeMock.mockResolvedValue({
      management: "adoptable_legacy",
      configured: true,
      channel: null,
      current_image_ref: null,
      latest: null,
      available: false,
      adoption_message:
        "Confirm adoption to preserve the PostgreSQL 17 volume.",
      diagnostic: null,
    });

    await expect(checkLocalBackendUpdate()).resolves.toMatchObject({
      management: "adoptable_legacy",
      configured: true,
      adoptionMessage: "Confirm adoption to preserve the PostgreSQL 17 volume.",
      diagnostic: null,
      update: null,
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("confirms adoption explicitly and refreshes the managed backend status", async () => {
    const adoptionResult = {
      status: "ready" as const,
      backend_url: "http://127.0.0.1:8000",
      adoption_message: null,
    };
    const managedStatus = {
      management: "managed_local",
      configured: true,
      channel: "release",
      current_version: "0.4.0",
      current_build: "backend-build",
      current_image_ref: "current-image",
      current_generated_at: "2026-08-21T00:00:00Z",
      latest: null,
      available: false,
      adoption_message: null,
      diagnostic: null,
    };
    invokeMock
      .mockResolvedValueOnce(adoptionResult)
      .mockResolvedValueOnce(managedStatus);

    await expect(adoptLocalBackend()).resolves.toEqual(adoptionResult);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "adopt_local_backend", {
      confirmed: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "check_local_backend_update");
    expect(invokeMock).not.toHaveBeenCalledWith(
      "initialize_project",
      expect.anything()
    );
    expect(useGuiUpdateStore.getState().localBackend).toMatchObject({
      management: "managed_local",
      currentVersion: "0.4.0",
      adoption: {
        status: "success",
      },
    });
  });

  it("reports a volume-only or unsafe legacy backend as recovery-required", async () => {
    invokeMock.mockResolvedValue({
      management: "adoption_recovery_required",
      configured: true,
      channel: null,
      current_image_ref: null,
      latest: null,
      available: false,
      adoption_message: null,
      diagnostic: {
        code: "legacy_host_port_required",
        retryable: false,
        message: "Provide the prior host port; existing data was preserved.",
      },
    });

    await expect(checkLocalBackendUpdate()).resolves.toMatchObject({
      management: "adoption_recovery_required",
      configured: true,
      diagnostic: {
        code: "legacy_host_port_required",
        retryable: false,
      },
      update: null,
    });
  });

  it("keeps remote and absent backend statuses distinct", async () => {
    for (const status of [
      {
        management: "external",
        configured: true,
        channel: null,
        current_image_ref: null,
        latest: null,
        available: false,
      },
      {
        management: "not_configured",
        configured: false,
        channel: null,
        current_image_ref: null,
        latest: null,
        available: false,
      },
    ]) {
      invokeMock.mockResolvedValueOnce(status);
      await expect(checkLocalBackendUpdate()).resolves.toMatchObject({
        management: status.management,
        configured: status.configured,
        update: null,
      });
    }
  });

  it("applies a local backend image only after explicit approval", async () => {
    const update: LocalBackendUpdateInfo = {
      channel: "release",
      currentImageRef: "current-image",
      currentImageCreatedAt: "2026-08-20T00:00:00Z",
      version: "0.4.0",
      build: "backend-build",
      imageRef: "target-image",
      generatedAt: "2026-08-21T00:00:00Z",
    };
    const result = {
      channel: "release",
      version: "0.4.0",
      build: "backend-build",
      image_ref: "target-image",
      generated_at: "2026-08-21T00:00:00Z",
    };
    invokeMock.mockResolvedValue(result);

    await expect(applyApprovedLocalBackendUpdate(update)).resolves.toEqual({
      channel: "release",
      version: "0.4.0",
      build: "backend-build",
      image_ref: "target-image",
      generated_at: "2026-08-21T00:00:00Z",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "apply_approved_local_backend_update",
      {
        approved: true,
        channel: "release",
        version: "0.4.0",
        build: "backend-build",
        imageRef: "target-image",
      }
    );
    expect(useGuiUpdateStore.getState().localBackend.apply).toEqual({
      status: "success",
      result,
    });
  });

  it("keeps failed apply results retryable and visible", async () => {
    const result = {
      state: "retryable_failure",
      progress: [],
      recovery_action: "Previous components remain active",
    };
    invokeMock.mockResolvedValue(result);

    await applyApprovedGuiUpdate({
      channel: "release",
      currentVersion: "0.1.0",
      version: "0.2.0",
    });

    expect(useGuiUpdateStore.getState().apply).toEqual({
      status: "retryable_failure",
      result,
    });
  });

  it("keeps valid and unavailable channel results separate", async () => {
    invokeMock.mockResolvedValue([
      {
        channel: "master",
        endpoint: "https://example.test/channel-master/gui-latest.json",
        available: true,
        release: {
          currentVersion: "0.1.0",
          version: "0.2.0",
          date: "2026-08-10T12:00:00Z",
          body: "Master update",
          rawJson: {
            build: "master-build",
            components: { gui: { version: "0.2.0" } },
          },
          isUpdate: true,
        },
        error: null,
      },
      {
        channel: "release",
        endpoint: "https://example.test/channel-release/gui-latest.json",
        available: false,
        release: null,
        error: "Could not fetch a valid release JSON from the remote",
      },
    ]);

    await expect(checkGuiUpdateChannels()).resolves.toEqual([
      {
        channel: "master",
        endpoint: "https://example.test/channel-master/gui-latest.json",
        available: true,
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        update: {
          channel: "master",
          currentVersion: "0.1.0",
          version: "0.2.0",
          build: "master-build",
          date: "2026-08-10T12:00:00Z",
          publishedAt: "2026-08-10T12:00:00Z",
          releaseNotes: "Master update",
          components: { gui: { version: "0.2.0" } },
        },
        error: null,
      },
      {
        channel: "release",
        endpoint: "https://example.test/channel-release/gui-latest.json",
        available: false,
        currentVersion: null,
        latestVersion: null,
        update: null,
        error: "Could not fetch a valid release JSON from the remote",
      },
    ]);
  });

  it("notifies and stores a local backend update from the scheduler", async () => {
    const checkChannels = vi.fn().mockResolvedValue([
      {
        channel: "release" as const,
        endpoint: "https://example.test/release/gui-latest.json",
        available: true,
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        update: null,
        error: null,
      },
      {
        channel: "master" as const,
        endpoint: "https://example.test/master/gui-latest.json",
        available: true,
        currentVersion: "0.1.0",
        latestVersion: "0.1.0",
        update: null,
        error: null,
      },
    ]);
    const checkLocalBackend = vi.fn().mockResolvedValue({
      management: "managed_local" as const,
      configured: true,
      channel: "release" as const,
      currentVersion: "0.3.0",
      currentBuild: "backend-current-build",
      currentImageRef: "current-image",
      currentImageCreatedAt: "2026-08-20T00:00:00Z",
      adoptionMessage: null,
      diagnostic: null,
      update: {
        channel: "release" as const,
        currentImageRef: "current-image",
        currentImageCreatedAt: "2026-08-20T00:00:00Z",
        version: "0.4.0",
        build: "backend-build",
        imageRef: "target-image",
        generatedAt: "2026-08-21T00:00:00Z",
      },
      error: null,
    });
    const scheduler = createGuiUpdateScheduler({
      checkChannels,
      checkLocalBackend,
    });

    scheduler.start();
    await flushPromises();

    expect(useGuiUpdateStore.getState().localBackend.update).toMatchObject({
      version: "0.4.0",
      build: "backend-build",
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      message: "Local backend 0.4.0 is available.",
    });
    scheduler.stop();
  });

  it("selects the valid channel when the preferred channel is unavailable", async () => {
    vi.useFakeTimers();
    const masterUpdate = { currentVersion: "0.1.0", version: "0.2.0" };
    const checkChannels = vi.fn().mockResolvedValue([
      {
        channel: "master" as const,
        endpoint: "https://example.test/channel-master/gui-latest.json",
        available: true,
        currentVersion: masterUpdate.currentVersion,
        latestVersion: masterUpdate.version,
        update: { ...masterUpdate, channel: "master" },
        error: null,
      },
      {
        channel: "release" as const,
        endpoint: "https://example.test/channel-release/gui-latest.json",
        available: false,
        currentVersion: null,
        latestVersion: null,
        update: null,
        error: "release channel unavailable",
      },
    ]);
    const scheduler = createGuiUpdateScheduler({ checkChannels });

    scheduler.start();
    await flushPromises();

    expect(checkChannels).toHaveBeenCalledOnce();
    expect(useGuiUpdateStore.getState()).toMatchObject({
      available: { channel: "master", version: "0.2.0" },
      selectedChannel: "master",
      status: "available",
      channels: {
        master: { available: true },
        release: { available: false, error: "release channel unavailable" },
      },
    });

    scheduler.stop();
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
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    warning.mockRestore();
  });

  it("logs the underlying failure and retry interval", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkMock.mockRejectedValue(new Error("signature mismatch"));
    const scheduler = createGuiUpdateScheduler();

    scheduler.start();
    await flushPromises();

    expect(warning).toHaveBeenCalledWith(
      "[GUI updater] Signed update check failed",
      expect.objectContaining({
        message: "signature mismatch",
        reason: expect.any(Error),
        retryInMs: GUI_UPDATE_INTERVAL_MS,
      })
    );
    expect(useGuiUpdateStore.getState().error).toBe("signature mismatch");

    scheduler.stop();
    warning.mockRestore();
  });

  it("reports the underlying failure to native diagnostics", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reportFailure = vi.fn().mockResolvedValue(undefined);
    checkMock.mockRejectedValue(new Error("endpoint unavailable"));
    const scheduler = createGuiUpdateScheduler({ reportFailure });

    scheduler.start();
    await flushPromises();

    expect(reportFailure).toHaveBeenCalledWith("endpoint unavailable");

    scheduler.stop();
    warning.mockRestore();
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
