import { beforeEach, describe, expect, it, vi } from "vitest";
import { check } from "@tauri-apps/plugin-updater";
import { useNotificationStore } from "./stores";
import {
  checkGuiUpdate,
  notifyGuiUpdateAvailable,
  type GuiUpdateInfo,
} from "./update";

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

describe("GUI update checker", () => {
  beforeEach(() => {
    checkMock.mockReset();
    useNotificationStore.setState({ notifications: [], isPanelOpen: false });
  });

  it("returns no update when the signed channel is current", async () => {
    checkMock.mockResolvedValue(null);

    await expect(checkGuiUpdate()).resolves.toBeNull();
  });

  it("reports an available version without installing or relaunching", async () => {
    checkMock.mockResolvedValue(updaterResult("0.1.0", "0.2.0"));

    await expect(checkGuiUpdate()).resolves.toEqual({
      currentVersion: "0.1.0",
      version: "0.2.0",
    });
  });

  it("does not block startup when checking fails", async () => {
    checkMock.mockRejectedValue(new Error("network unavailable"));

    await expect(checkGuiUpdate()).resolves.toBeNull();
  });

  it("adds one session notification for an available version", () => {
    const update: GuiUpdateInfo = {
      currentVersion: "0.1.0",
      version: "0.2.0",
    };

    notifyGuiUpdateAvailable(update);
    notifyGuiUpdateAvailable(update);

    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      entity: "application",
      entityId: "gui-update-0.2.0",
      message: "Vertebrae 0.2.0 is available.",
      type: "info",
    });
  });
});
