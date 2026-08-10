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

vi.mock("../bindings", () => ({
  commands: {
    getSupportedLocalChatHarnesses: (...args: unknown[]) =>
      mockGetSupportedLocalChatHarnesses(...args),
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
    useUIStore.setState({ theme: "system" });
    mockGetSupportedLocalChatHarnesses.mockResolvedValue({
      status: "ok",
      data: catalog,
    });
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

    await user.selectOptions(
      screen.getByTestId("claude-default-model"),
      "opus"
    );
    await user.selectOptions(
      screen.getByTestId("claude-default-permission"),
      "plan"
    );
    await user.selectOptions(screen.getByTestId("default-harness"), "codex");
    await user.click(screen.getByTestId("settings-nav-appearance"));
    expect(screen.getByTestId("settings-theme")).toHaveValue("system");
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
