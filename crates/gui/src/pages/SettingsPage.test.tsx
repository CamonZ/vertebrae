import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "./SettingsPage";
import { useLocalChatDefaultsStore } from "../utils/localChatDefaults";
import { useUIStore } from "../stores/uiStore";
import {
  initialGuiUpdateState,
  resetGuiUpdateState,
  useGuiUpdateStore,
  type GuiUpdateInfo,
} from "../stores/guiUpdateStore";

const mockGetSupportedLocalChatHarnesses = vi.fn();
const mockGetLocalFileEditors = vi.fn();

vi.mock("../bindings", () => ({
  commands: {
    getSupportedLocalChatHarnesses: (...args: unknown[]) =>
      mockGetSupportedLocalChatHarnesses(...args),
    getLocalFileEditors: (...args: unknown[]) =>
      mockGetLocalFileEditors(...args),
  },
}));

const catalog = {
  default_harness: "claude" as const,
  harnesses: [
    {
      harness: "claude" as const,
      label: "Claude",
      available: true,
      unavailable_reason: null,
      default_model_id: "sonnet",
      models: [
        { id: "sonnet", label: "Sonnet" },
        { id: "opus", label: "Opus" },
      ],
      default_reasoning_effort: null,
      reasoning_efforts: [],
      permission_modes: [
        { id: "default" as const, label: "Ask before edits", is_default: true },
        { id: "plan" as const, label: "Plan mode", is_default: false },
      ],
      supports_resume: true,
    },
    {
      harness: "codex" as const,
      label: "Codex",
      available: true,
      unavailable_reason: null,
      default_model_id: "gpt-5.6-luna",
      models: [
        {
          id: "gpt-5.6-luna",
          label: "GPT-5.6-Luna",
          supported_reasoning_effort_ids: ["medium", "high"],
        },
      ],
      default_reasoning_effort: "medium",
      reasoning_efforts: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      permission_modes: [
        { id: "default" as const, label: "Default", is_default: true },
        {
          id: "bypass_permissions" as const,
          label: "Full access",
          is_default: false,
        },
      ],
      supports_resume: true,
    },
  ],
};

describe("SettingsPage", () => {
  const availableUpdate: GuiUpdateInfo = {
    channel: "release",
    currentVersion: "0.1.0",
    version: "0.2.0",
    build: "abc1234",
    date: "2026-08-10T12:00:00Z",
    releaseNotes: "Improved update safety.\nNo forced restart.",
    components: {
      gui: { currentVersion: "0.1.0", version: "0.2.0", status: "ready" },
      cli: { currentVersion: "0.1.0", version: "0.2.0", status: "ready" },
      daemon: {
        currentVersion: "0.1.0",
        version: "0.2.0",
        status: "ready",
      },
      gate: { currentVersion: "0.1.0", version: "0.2.0", status: "ready" },
    },
    verification: {
      signature: "Verified",
      preflight: "Ready",
      compatibility: "Compatible",
      componentManifest: "Available",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetGuiUpdateState();
    useLocalChatDefaultsStore.setState({
      defaults: {},
      defaultHarness: null,
      storageWarning: null,
    });
    useUIStore.setState({ theme: "system", externalEditor: "" });
    mockGetSupportedLocalChatHarnesses.mockResolvedValue({
      status: "ok",
      data: catalog,
    });
    mockGetLocalFileEditors.mockResolvedValue({
      status: "ok",
      data: [
        {
          id: "app:/Applications/Visual Studio Code.app",
          name: "Visual Studio Code",
          path: "/Applications/Visual Studio Code.app",
        },
      ],
    });
  });

  it("keeps file-link settings available when harness discovery fails", async () => {
    mockGetSupportedLocalChatHarnesses.mockResolvedValue({
      status: "error",
      error: { message: "Harness discovery failed" },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(await screen.findByTestId("settings-error")).toHaveTextContent(
      "Harness discovery failed"
    );
    expect(screen.getByTestId("settings-external-editor")).toBeInTheDocument();
  });

  it("preserves and explains a configured editor when discovery fails", async () => {
    useUIStore.setState({
      externalEditor: "app:/Applications/Visual Studio Code.app",
    });
    mockGetLocalFileEditors.mockResolvedValue({
      status: "error",
      error: { message: "Editor discovery failed" },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByTestId("settings-external-editor-error")
    ).toHaveTextContent("Editor discovery failed");
    expect(screen.getByTestId("settings-external-editor")).toHaveValue(
      "app:/Applications/Visual Studio Code.app"
    );
    expect(
      screen.getByRole("option", { name: "Configured editor (unavailable)" })
    ).toBeInTheDocument();
  });

  it("renders an available release and lets the user review it", async () => {
    const user = userEvent.setup();
    const onApproveUpdate = vi.fn();
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      available: availableUpdate,
      currentVersion: availableUpdate.currentVersion,
      status: "available",
    });

    render(
      <MemoryRouter>
        <SettingsPage onApproveUpdate={onApproveUpdate} />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    expect(screen.getByTestId("settings-nav-updates-badge")).toHaveTextContent(
      "1"
    );
    expect(screen.getByTestId("settings-update-card")).toBeVisible();
    expect(screen.getByText("Vertebrae 0.2.0")).toBeVisible();
    expect(screen.getByText("abc1234")).toBeVisible();
    expect(screen.getByTestId("settings-release-notes")).toHaveTextContent(
      "Improved update safety."
    );
    expect(screen.getByTestId("settings-release-notes")).toHaveTextContent(
      "No forced restart."
    );

    for (const [key, label] of [
      ["gui", "Vertebrae GUI"],
      ["cli", "vtb CLI"],
      ["daemon", "vtb-daemon"],
      ["gate", "vtb-gate"],
    ]) {
      expect(
        screen.getByTestId(`settings-update-component-${key}`)
      ).toHaveTextContent(label);
      expect(
        screen.getByTestId(`settings-update-component-${key}`)
      ).toHaveTextContent("0.1.0 → 0.2.0");
      expect(
        screen.getByTestId(`settings-update-component-${key}`)
      ).toHaveTextContent("Ready");
    }

    await user.click(screen.getByTestId("settings-review-update"));
    expect(screen.getByRole("dialog", { name: "Review update" })).toBeVisible();
    expect(screen.getByText("Verified")).toBeVisible();
    expect(screen.getByText("Compatible")).toBeVisible();
    expect(screen.getByText("Available")).toBeVisible();
    expect(screen.getByTestId("settings-review-update-approve")).toBeVisible();

    await user.click(screen.getByTestId("settings-review-update-cancel"));
    expect(onApproveUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("only calls the approval callback after explicit approval", async () => {
    const user = userEvent.setup();
    const onApproveUpdate = vi.fn();
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      available: availableUpdate,
      currentVersion: availableUpdate.currentVersion,
      status: "available",
    });

    render(
      <MemoryRouter>
        <SettingsPage onApproveUpdate={onApproveUpdate} />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    await user.click(screen.getByTestId("settings-review-update"));
    await user.click(screen.getByTestId("settings-review-update-approve"));

    expect(onApproveUpdate).toHaveBeenCalledOnce();
    expect(onApproveUpdate).toHaveBeenCalledWith(availableUpdate);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reviews and explicitly approves a local backend update", async () => {
    const user = userEvent.setup();
    const onApproveLocalBackendUpdate = vi.fn();
    const localBackendUpdate = {
      channel: "release" as const,
      currentImageRef:
        "ghcr.io/camonz/sacrum@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      version: "0.4.0",
      build: "backend-build",
      imageRef:
        "ghcr.io/camonz/sacrum@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    };
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      localBackend: {
        ...initialGuiUpdateState.localBackend,
        management: "managed_local",
        configured: true,
        channel: "release",
        currentImageRef: localBackendUpdate.currentImageRef,
        update: localBackendUpdate,
      },
    });

    render(
      <MemoryRouter>
        <SettingsPage
          onApproveLocalBackendUpdate={onApproveLocalBackendUpdate}
        />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    expect(screen.getByTestId("settings-nav-updates-badge")).toHaveTextContent(
      "1"
    );
    expect(
      screen.getByTestId("settings-local-backend-update-card")
    ).toHaveTextContent("Backend 0.4.0");
    await user.click(
      screen.getByTestId("settings-review-local-backend-update")
    );
    expect(
      screen.getByRole("dialog", { name: "Review local backend update" })
    ).toBeVisible();

    await user.click(
      screen.getByTestId("settings-review-local-backend-update-cancel")
    );
    expect(onApproveLocalBackendUpdate).not.toHaveBeenCalled();

    await user.click(
      screen.getByTestId("settings-review-local-backend-update")
    );
    await user.click(
      screen.getByTestId("settings-review-local-backend-update-approve")
    );
    expect(onApproveLocalBackendUpdate).toHaveBeenCalledOnce();
    expect(onApproveLocalBackendUpdate).toHaveBeenCalledWith(
      localBackendUpdate
    );
  });

  it("shows the externally managed backend notice separately from frontend updates", async () => {
    const user = userEvent.setup();
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      currentVersion: "0.2.0",
      status: "current",
      localBackend: {
        ...initialGuiUpdateState.localBackend,
        management: "external",
        configured: true,
        currentVersion: "0.8.0",
        currentBuild: "remote-build",
      },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    expect(screen.getByTestId("settings-frontend-updates")).toHaveTextContent(
      "Frontend"
    );
    expect(screen.getByTestId("settings-frontend-current")).toHaveTextContent(
      "0.2.0"
    );
    expect(screen.getByTestId("settings-backend-updates")).toHaveTextContent(
      "Backend"
    );
    expect(screen.getByTestId("settings-backend-current")).toHaveTextContent(
      "0.8.0"
    );
    expect(screen.getByTestId("settings-backend-external")).toHaveTextContent(
      "Backend updates are not available because the backend is not managed by the app."
    );
  });

  it("renders ordered apply progress and offers only a deferred relaunch", async () => {
    const user = userEvent.setup();
    const result = {
      transaction_id: null,
      state: "deferred_relaunch" as const,
      channel: "release",
      version: "0.2.0",
      build: "abc1234",
      progress: [
        {
          component: "cli",
          state: "health_checked" as const,
          message: "ready",
        },
        {
          component: "daemon",
          state: "health_checked" as const,
          message: "ready",
        },
        {
          component: "gate",
          state: "health_checked" as const,
          message: "ready",
        },
        {
          component: "gui",
          state: "pending_relaunch" as const,
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
    };
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      apply: { status: "success", result },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    expect(screen.getByTestId("settings-update-result")).toHaveTextContent(
      "Update complete"
    );
    expect(screen.getByTestId("settings-update-progress")).toHaveTextContent(
      "daemon"
    );
    expect(screen.getByTestId("settings-update-relaunch")).toBeVisible();
  });

  it("supports missing notes and safe current or failed states", async () => {
    const user = userEvent.setup();
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      available: { ...availableUpdate, releaseNotes: null, notes: null },
      currentVersion: availableUpdate.currentVersion,
      status: "available",
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    await user.click(screen.getByTestId("settings-nav-updates"));
    expect(
      screen.getByText("No release notes were provided for this release.")
    ).toBeVisible();

    await act(async () => {
      resetGuiUpdateState();
      useGuiUpdateStore.setState({
        ...initialGuiUpdateState,
        status: "current",
        currentVersion: "0.2.0",
      });
    });
    expect(
      screen.queryByTestId("settings-nav-updates-badge")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-updates-current")).toBeVisible();

    await act(async () => {
      useGuiUpdateStore.setState({
        ...initialGuiUpdateState,
        status: "error",
        error: "network unavailable",
      });
    });
    expect(screen.getByTestId("settings-updates-failed")).toBeVisible();
    expect(screen.getByTestId("settings-updates-failed")).toHaveTextContent(
      "The update check failed."
    );
  });

  it("renders loading, unavailable, and stale states without unsafe actions", async () => {
    const user = userEvent.setup();
    const onApproveUpdate = vi.fn();
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      checking: true,
      status: "checking",
    });

    render(
      <MemoryRouter>
        <SettingsPage onApproveUpdate={onApproveUpdate} />
      </MemoryRouter>
    );
    await user.click(screen.getByTestId("settings-nav-updates"));
    expect(screen.getByTestId("settings-updates-loading")).toBeVisible();

    await act(async () => {
      useGuiUpdateStore.setState({
        ...initialGuiUpdateState,
        status: "unavailable",
      });
    });
    expect(screen.getByTestId("settings-updates-unavailable")).toBeVisible();
    expect(
      screen.queryByTestId("settings-nav-updates-badge")
    ).not.toBeInTheDocument();

    await act(async () => {
      useGuiUpdateStore.setState({
        ...initialGuiUpdateState,
        available: availableUpdate,
        currentVersion: availableUpdate.currentVersion,
        error: "network unavailable",
        status: "stale",
      });
    });
    expect(screen.getByTestId("settings-updates-stale")).toBeVisible();
    expect(screen.getByTestId("settings-nav-updates-badge")).toHaveTextContent(
      "1"
    );

    await user.click(screen.getByTestId("settings-review-update"));
    expect(screen.getByTestId("settings-review-stale")).toBeVisible();
    await user.click(screen.getByTestId("settings-review-update-cancel"));
    expect(onApproveUpdate).not.toHaveBeenCalled();
  });

  it("disables a channel when its signed release metadata is unavailable", async () => {
    const user = userEvent.setup();
    const masterUpdate = { ...availableUpdate, channel: "master" };
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      channels: {
        master: {
          available: true,
          currentVersion: masterUpdate.currentVersion,
          latestVersion: masterUpdate.version,
          update: masterUpdate,
          error: null,
        },
        release: {
          available: false,
          currentVersion: null,
          latestVersion: null,
          update: null,
          error: "Could not fetch a valid release JSON from the remote",
        },
      },
      selectedChannel: "release",
      status: "unavailable",
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    const channelSelect = screen.getByTestId("settings-update-channel");
    expect(
      screen.getByRole("option", {
        name: "release (stable) (unavailable)",
      })
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "master (edge)" })
    ).not.toBeDisabled();
    expect(
      screen.getByTestId("settings-update-channel-unavailable")
    ).toHaveTextContent("release (stable) is unavailable");

    await user.selectOptions(channelSelect, "master");
    expect(channelSelect).toHaveValue("master");
    expect(screen.getByText("Vertebrae 0.2.0")).toBeVisible();
  });

  it("renders one defaults card per reported harness", async () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(await screen.findByTestId("harness-defaults-claude")).toBeVisible();
    expect(screen.getByTestId("harness-defaults-codex")).toBeVisible();
    expect(screen.getByTestId("settings-nav-chat")).toHaveTextContent("Chat");
    expect(screen.getByTestId("settings-nav-appearance")).toHaveTextContent(
      "Appearance"
    );
    expect(screen.getByTestId("default-harness")).toHaveValue("claude");
    expect(screen.getByTestId("codex-default-reasoning-effort")).toBeVisible();
    expect(screen.queryByTestId("settings-theme")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved on this device")).not.toBeInTheDocument();
  });

  it("saves model and permission changes", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    await screen.findByTestId("harness-defaults-claude");
    await screen.findByRole("option", { name: "Visual Studio Code" });

    await user.selectOptions(
      screen.getByTestId("claude-default-model"),
      "opus"
    );
    await user.selectOptions(
      screen.getByTestId("claude-default-permission"),
      "plan"
    );
    await user.selectOptions(screen.getByTestId("default-harness"), "codex");
    await user.selectOptions(
      screen.getByTestId("settings-external-editor"),
      "app:/Applications/Visual Studio Code.app"
    );
    await user.click(screen.getByTestId("settings-nav-appearance"));
    expect(screen.getByTestId("settings-theme")).toHaveValue("system");
    expect(
      screen.queryByTestId("settings-external-editor")
    ).not.toBeInTheDocument();
    await user.selectOptions(screen.getByTestId("settings-theme"), "dark");
    await user.click(screen.getByTestId("settings-nav-chat"));
    await user.selectOptions(
      screen.getByTestId("codex-default-reasoning-effort"),
      "high"
    );

    await waitFor(() => {
      expect(useLocalChatDefaultsStore.getState().defaults).toEqual({
        claude: { modelId: "opus", permissionMode: "plan" },
        codex: { reasoningEffort: "high" },
      });
      expect(useLocalChatDefaultsStore.getState().defaultHarness).toBe("codex");
      expect(useUIStore.getState().theme).toBe("dark");
      expect(useUIStore.getState().externalEditor).toBe(
        "app:/Applications/Visual Studio Code.app"
      );
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(
          "vertebrae.local-chat-harness-defaults.v1"
        ) ?? "{}"
      )
    ).toEqual({
      defaultHarness: "codex",
      harnesses: {
        claude: { modelId: "opus", permissionMode: "plan" },
        codex: { reasoningEffort: "high" },
      },
    });
  });
});
