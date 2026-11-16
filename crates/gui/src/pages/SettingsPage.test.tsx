import { inlineDiscussionCatalog } from "../test/inlineDiscussionCatalog";
import { withBuiltinProviders } from "../test/localChatCatalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "./SettingsPage";
import { useLocalChatDefaultsStore } from "../utils/localChatDefaults";
import { useUIStore } from "../stores/uiStore";
import {
  DEFAULT_DIFF_PREFERENCES,
  codeThemesFor,
} from "../utils/codeAppearance";
import {
  initialGuiUpdateState,
  resetGuiUpdateState,
  useGuiUpdateStore,
  type GuiUpdateInfo,
} from "../stores/guiUpdateStore";
import {
  chooseDropdownValue,
  dropdownOptions,
  dropdownOptionValues,
  getDropdownOption,
} from "../test/dropdown";

const mockGetSupportedLocalChatHarnesses = vi.fn();
const mockGetLocalFileEditors = vi.fn();
const mockLocalBackendProgressListen = vi.fn();
const invokeMock = vi.mocked(invoke);

vi.mock("../components/thread/toolChange/PatchFiles", () => ({
  default: ({ patch }: { patch: string }) => (
    <div data-testid="preview-patch-files">{patch}</div>
  ),
}));

vi.mock("../components/shared/CodeSnippet", () => ({
  default: ({ source }: { source: string }) => (
    <div data-testid="preview-code-snippet">{source}</div>
  ),
}));

vi.mock("../bindings", () => ({
  commands: {
    getSupportedLocalChatHarnesses: (...args: unknown[]) =>
      mockGetSupportedLocalChatHarnesses(...args),
    getLocalFileEditors: (...args: unknown[]) =>
      mockGetLocalFileEditors(...args),
    adoptLocalBackend: (confirmed: boolean) =>
      invoke("adopt_local_backend", { confirmed }).then((data) => ({
        status: "ok",
        data,
      })),
    checkLocalBackendUpdate: () =>
      invoke("check_local_backend_update").then((data) => ({
        status: "ok",
        data,
      })),
  },
  events: {
    localBackendProgressEvent: {
      listen: (...args: unknown[]) => mockLocalBackendProgressListen(...args),
    },
  },
}));

const catalog = withBuiltinProviders({
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
          supported_speed_tier_ids: ["default", "fast"],
        },
      ],
      default_reasoning_effort: "medium",
      reasoning_efforts: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      speed_tiers: [
        { id: "default", label: "Standard", is_default: true },
        { id: "fast", label: "Fast", is_default: false },
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
});

function openCodeEditorSettings() {
  const navigation = screen.getByTestId("settings-nav-code-editor");

  fireEvent.click(navigation);
}

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
    invokeMock.mockReset();
    window.localStorage.clear();
    resetGuiUpdateState();
    useLocalChatDefaultsStore.setState({
      defaults: {},
      defaultProvider: null,
      storageWarning: null,
    });
    useUIStore.setState({
      inlineDiscussionPreference: { mode: "follow" },
      theme: "system",
      thinkingIndicatorStyle: "classic",
      externalEditor: "",
      codeThemeDark: "pierre-dark",
      codeThemeLight: "pierre-light",
      diffPreferences: DEFAULT_DIFF_PREFERENCES,
      inlineCodeForeground: null,
      inlineCodeBackground: null,
    });
    mockGetSupportedLocalChatHarnesses.mockResolvedValue({
      status: "ok",
      data: catalog,
    });
    mockLocalBackendProgressListen.mockResolvedValue(() => {});
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

  it("selects and restores a dedicated inline model independently of main chat defaults", async () => {
    const settings = (
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    const view = render(settings);

    openCodeEditorSettings();

    await waitFor(() => {
      expect(
        getDropdownOption(
          screen.getByLabelText("Inline discussion mode"),
          "Custom model"
        )?.disabled
      ).toBe(false);
    });

    const modePicker = screen.getByLabelText("Inline discussion mode");

    chooseDropdownValue(modePicker, "dedicated");

    const modelPicker = screen.getByLabelText("Inline discussion model");

    chooseDropdownValue(modelPicker, "opus");

    const preference = useUIStore.getState().inlineDiscussionPreference;
    const mainDefaults = useLocalChatDefaultsStore.getState();

    expect(preference).toEqual({
      mode: "dedicated",
      providerId: "anthropic",
      modelId: "opus",
    });
    expect(mainDefaults.defaults).toEqual({});
    expect(mainDefaults.defaultProvider).toBeNull();

    view.unmount();
    render(settings);
    openCodeEditorSettings();

    await waitFor(() => {
      const restoredModelPicker = screen.getByLabelText(
        "Inline discussion model"
      );

      expect(restoredModelPicker).toHaveAttribute("data-value", "opus");
    });

    const providerPicker = screen.getByLabelText("Inline discussion provider");

    chooseDropdownValue(providerPicker, "openai");

    const updatedModelPicker = screen.getByLabelText("Inline discussion model");

    expect(updatedModelPicker).toHaveAttribute("data-value", "gpt-5.6-luna");

    const restoredModePicker = screen.getByLabelText("Inline discussion mode");

    chooseDropdownValue(restoredModePicker, "follow");

    const inheritedPreference =
      useUIStore.getState().inlineDiscussionPreference;

    expect(inheritedPreference).toEqual({ mode: "follow" });

    const customOptions = screen.queryByRole("group", {
      name: "Custom inline discussion options",
    });

    expect(customOptions).toBeNull();
  });

  it("reports inline preference persistence failure without claiming it was saved", async () => {
    const settings = (
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    render(settings);
    openCodeEditorSettings();

    await waitFor(() => {
      expect(
        getDropdownOption(
          screen.getByLabelText("Inline discussion mode"),
          "Custom model"
        )?.disabled
      ).toBe(false);
    });

    const storage = vi.spyOn(Storage.prototype, "setItem");

    storage.mockImplementation(() => {
      throw new Error("quota");
    });

    try {
      const modePicker = screen.getByLabelText("Inline discussion mode");

      chooseDropdownValue(modePicker, "dedicated");

      const storageError = screen.getByText(
        /Could not save the inline discussion choice/
      );

      expect(storageError).toBeVisible();
    } finally {
      storage.mockRestore();
    }
  });

  it("shows a removed saved inline provider with recovery instead of resetting it", async () => {
    const preference = {
      mode: "dedicated" as const,
      providerId: "removed",
      modelId: "stale",
    };
    const settings = (
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    useUIStore.setState({ inlineDiscussionPreference: preference });
    render(settings);
    openCodeEditorSettings();
    await screen.findByText(/Provider removed is unavailable or removed/);

    const providerPicker = screen.getByLabelText("Inline discussion provider");
    const modelPicker = screen.getByLabelText("Inline discussion model");

    expect(providerPicker).toHaveAttribute("data-value", "removed");
    expect(modelPicker).toHaveAttribute("data-value", "stale");
  });

  it("groups code settings separately from global appearance and filters inline options by model", async () => {
    mockGetSupportedLocalChatHarnesses.mockResolvedValue({
      status: "ok",
      data: inlineDiscussionCatalog,
    });
    const settings = (
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    render(settings);
    openCodeEditorSettings();

    const title = screen.getByRole("heading", { name: "Diffs & code editor" });
    const theme = screen.queryByTestId("settings-theme");

    expect(title).toBeVisible();
    expect(theme).toBeNull();

    await waitFor(() => {
      expect(
        getDropdownOption(
          screen.getByLabelText("Inline discussion mode"),
          "Custom model"
        )?.disabled
      ).toBe(false);
    });

    const mode = screen.getByLabelText("Inline discussion mode");
    const inheritedOptions = screen.queryByRole("group", {
      name: "Custom inline discussion options",
    });

    expect(inheritedOptions).toBeNull();

    chooseDropdownValue(mode, "dedicated");

    const provider = screen.getByLabelText("Inline discussion provider");

    chooseDropdownValue(provider, "custom");

    const effort = screen.getByLabelText("Inline discussion reasoning effort");
    const speed = screen.getByLabelText("Inline discussion speed tier");
    const customOptions = screen.getByRole("group", {
      name: "Custom inline discussion options",
    });
    const dropdowns = customOptions.querySelectorAll('[aria-haspopup="listbox"]');
    const personality = screen.queryByLabelText(
      "Inline discussion personality"
    );

    expect(dropdowns).toHaveLength(4);
    expect(personality).toBeNull();
    const effortChoices = within(effort).queryByRole("option", { name: "Low" });

    expect(effortChoices).toBeNull();

    chooseDropdownValue(effort, "high");
    chooseDropdownValue(speed, "fast");

    const saved = useUIStore.getState().inlineDiscussionPreference;

    expect(saved).toMatchObject({
      reasoningEffort: "high",
      speedTier: "fast",
    });

    const model = screen.getByLabelText("Inline discussion model");

    chooseDropdownValue(model, "plain");

    const reset = useUIStore.getState().inlineDiscussionPreference;

    expect(reset).toEqual({
      mode: "dedicated",
      providerId: "custom",
      modelId: "plain",
    });
    expect(effort).toHaveAttribute("data-value", "");
    expect(speed).toHaveAttribute("data-value", "");
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

    openCodeEditorSettings();

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

    openCodeEditorSettings();

    expect(
      await screen.findByTestId("settings-external-editor-error")
    ).toHaveTextContent("Editor discovery failed");
    expect(screen.getByTestId("settings-external-editor")).toHaveAttribute(
      "data-value",
      "app:/Applications/Visual Studio Code.app"
    );
    expect(
      getDropdownOption(
        screen.getByTestId("settings-external-editor"),
        "Configured editor (unavailable)"
      )
    ).not.toBeNull();
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
      currentImageCreatedAt: "2026-08-20T00:00:00Z",
      version: "0.4.0",
      build: "backend-build",
      imageRef:
        "ghcr.io/camonz/sacrum@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      generatedAt: "2026-08-21T00:00:00Z",
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
    expect(
      screen.getByTestId("settings-local-backend-update-card")
    ).toHaveTextContent("2026-08-20 00:00 UTC");
    expect(
      screen.getByTestId("settings-local-backend-update-card")
    ).toHaveTextContent("2026-08-21 00:00 UTC");
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
      "This backend is managed externally, so the app cannot update it automatically."
    );
  });

  it("offers safe adoption for a compatible legacy backend", async () => {
    const user = userEvent.setup();
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      localBackend: {
        ...initialGuiUpdateState.localBackend,
        management: "adoptable_legacy",
        configured: true,
        adoptionMessage:
          "Confirm adoption to preserve the existing PostgreSQL 17 volume.",
      },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    expect(
      screen.getByTestId("settings-local-backend-adoption")
    ).toHaveTextContent("Adopt this backend in Vertebrae");
    expect(
      screen.queryByTestId("settings-backend-not-configured")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("settings-local-backend-adoption")
    ).toHaveTextContent("PostgreSQL 17 volume");

    await user.click(screen.getByTestId("settings-adopt-local-backend"));
    expect(
      screen.getByRole("dialog", { name: "Confirm local backend adoption" })
    ).toBeVisible();
    await user.click(screen.getByTestId("settings-adopt-local-backend-cancel"));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows adoption progress and a retryable failure after confirmation", async () => {
    const user = userEvent.setup();
    let rejectAdoption!: (reason: unknown) => void;
    const adoption = new Promise<never>((_, reject) => {
      rejectAdoption = reject;
    });
    invokeMock.mockReturnValueOnce(adoption);
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      localBackend: {
        ...initialGuiUpdateState.localBackend,
        management: "adoptable_legacy",
        configured: true,
      },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    await user.click(screen.getByTestId("settings-adopt-local-backend"));
    await user.click(
      screen.getByTestId("settings-adopt-local-backend-confirm")
    );
    expect(
      await screen.findByTestId("settings-local-backend-adoption-progress")
    ).toBeVisible();
    expect(screen.getByTestId("settings-adopt-local-backend")).toBeDisabled();

    rejectAdoption(new Error("Docker is unavailable"));
    expect(
      await screen.findByTestId("settings-local-backend-adoption-error")
    ).toHaveTextContent("Docker is unavailable");
    expect(
      screen.getByTestId("settings-adopt-local-backend")
    ).toHaveTextContent("Retry adoption");
  });

  it("offers a read-only check again action for adoption recovery", async () => {
    const user = userEvent.setup();
    invokeMock.mockResolvedValueOnce({
      management: "adoption_recovery_required",
      configured: true,
      channel: null,
      current_version: null,
      current_build: null,
      current_image_ref: null,
      current_generated_at: null,
      latest: null,
      available: false,
      adoption_message: null,
      diagnostic: {
        code: "legacy_host_port_required",
        retryable: false,
        message: "Provide the prior host port; existing data was preserved.",
      },
    });
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      localBackend: {
        ...initialGuiUpdateState.localBackend,
        management: "adoption_recovery_required",
        configured: true,
        diagnostic: {
          code: "legacy_host_port_required",
          retryable: false,
          message: "Provide the prior host port; existing data was preserved.",
        },
      },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    await user.click(screen.getByTestId("settings-local-backend-check-again"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("check_local_backend_update");
    });
    expect(
      screen.getByTestId("settings-local-backend-adoption-recovery")
    ).toHaveTextContent("Check again");
  });

  it("refreshes the Settings backend branch after successful adoption", async () => {
    const user = userEvent.setup();
    invokeMock
      .mockResolvedValueOnce({
        status: "ready",
        backend_url: "http://127.0.0.1:4400",
        adoption_message: null,
      })
      .mockResolvedValueOnce({
        management: "managed_local",
        configured: true,
        channel: "release",
        current_version: "0.4.0",
        current_build: "backend-build",
        current_image_ref: "current-image",
        current_generated_at: null,
        latest: null,
        available: false,
        adoption_message: null,
        diagnostic: null,
      });
    useGuiUpdateStore.setState({
      ...initialGuiUpdateState,
      localBackend: {
        ...initialGuiUpdateState.localBackend,
        management: "adoptable_legacy",
        configured: true,
      },
    });

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-updates"));
    await user.click(screen.getByTestId("settings-adopt-local-backend"));
    await user.click(
      screen.getByTestId("settings-adopt-local-backend-confirm")
    );

    expect(
      await screen.findByTestId("settings-backend-current-status")
    ).toHaveTextContent("up to date");
    expect(
      screen.getByTestId("settings-local-backend-adoption-result")
    ).toHaveTextContent("preserved");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "adopt_local_backend", {
      confirmed: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "check_local_backend_update");
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
      getDropdownOption(channelSelect, "release (stable) (unavailable)")
        ?.disabled
    ).toBe(true);
    expect(getDropdownOption(channelSelect, "master (edge)")?.disabled).toBe(
      false
    );
    expect(
      screen.getByTestId("settings-update-channel-unavailable")
    ).toHaveTextContent("release (stable) is unavailable");

    chooseDropdownValue(channelSelect, "master");
    expect(channelSelect).toHaveAttribute("data-value", "master");
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
    expect(screen.getByTestId("default-harness")).toHaveAttribute("data-value", "anthropic");
    expect(screen.getByTestId("codex-default-reasoning-effort")).toBeVisible();
    expect(screen.queryByTestId("settings-theme")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved on this device")).not.toBeInTheDocument();
  });

  it("renders a defaults card for a custom provider with only its models", async () => {
    mockGetSupportedLocalChatHarnesses.mockResolvedValue({
      status: "ok",
      data: withBuiltinProviders(catalog, [
        {
          id: "openrouter",
          label: "openrouter",
          harness: "claude",
          custom: true,
          available: true,
          unavailable_reason: null,
          models: [{ id: "moonshotai/kimi-k2", label: "moonshotai/kimi-k2" }],
          default_model_id: "moonshotai/kimi-k2",
        },
      ]),
    });
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    expect(
      await screen.findByTestId("harness-defaults-provider-openrouter")
    ).toBeVisible();
    const modelOptions = dropdownOptions(
      screen.getByTestId("provider-openrouter-default-model")
    ).map((option) => option.value);
    expect(modelOptions).toContain("moonshotai/kimi-k2");
    expect(modelOptions).not.toContain("opus");
    expect(
      dropdownOptions(screen.getByTestId("default-harness")).map(
        (option) => option.value
      )
    ).toEqual(["anthropic", "openai", "openrouter"]);
  });

  it("picks an accent from swatches that each preview their own colour", async () => {
    const user = userEvent.setup();
    useUIStore.setState({ accent: "orchid" });
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    await user.click(screen.getByTestId("settings-nav-appearance"));
    const group = screen.getByRole("radiogroup", { name: "Accent" });
    const swatches = within(group).getAllByRole("radio");
    expect(swatches.map((swatch) => swatch.getAttribute("data-accent"))).toEqual(
      ["orchid", "ember", "jade", "lagoon", "cobalt", "iris"]
    );
    expect(within(group).getByRole("radio", { name: "Orchid" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    await user.click(within(group).getByRole("radio", { name: "Cobalt" }));
    expect(useUIStore.getState().accent).toBe("cobalt");
    expect(within(group).getByRole("radio", { name: "Cobalt" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
  });

  it("groups pages in a tree and expands the current page to its sections", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    const tree = screen.getByRole("navigation", { name: "Settings" });
    expect(within(tree).getByText("General")).toBeInTheDocument();
    expect(within(tree).getByText("Models")).toBeInTheDocument();
    expect(within(tree).getByText("System")).toBeInTheDocument();

    const sections = await within(tree).findByRole("list", {
      name: "Chat sections",
    });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await user.click(
      await within(sections).findByRole("button", { name: "Gate chats" })
    );
    expect(scrollIntoView).toHaveBeenCalled();
    expect(
      within(sections).getByRole("button", { name: "Gate chats" })
    ).toHaveAttribute("aria-current", "location");

    await user.click(screen.getByTestId("settings-nav-appearance"));
    expect(
      await within(tree).findByRole("list", { name: "Appearance sections" })
    ).toBeInTheDocument();
    expect(
      within(tree).queryByRole("list", { name: "Chat sections" })
    ).toBeNull();
  });

  it("exposes and retains the persisted thinking indicator style", async () => {
    const { unmount } = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    const selector = await screen.findByTestId("settings-thinking-indicator");
    expect(selector).toHaveAttribute("data-value", "classic");

    chooseDropdownValue(selector, "futuristic");
    expect(useUIStore.getState().thinkingIndicatorStyle).toBe("futuristic");
    expect(
      JSON.parse(localStorage.getItem("vertebrae-ui-storage") ?? "{}").state
        .thinkingIndicatorStyle
    ).toBe("futuristic");

    unmount();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    expect(
      await screen.findByTestId("settings-thinking-indicator")
    ).toHaveAttribute("data-value", "futuristic");
  });

  it("persists when stalled gate chats are steered", async () => {
    const user = userEvent.setup();
    useUIStore.setState({
      gateSteeringThresholds: { soft: 3, form: 6, escape: 9 },
    });
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    const form = await screen.findByTestId("settings-gate-steering-form");
    expect(form).toHaveValue(6);
    await user.clear(form);
    await user.type(form, "4");

    expect(useUIStore.getState().gateSteeringThresholds).toEqual({
      soft: 3,
      form: 4,
      escape: 9,
    });
    expect(
      JSON.parse(localStorage.getItem("vertebrae-ui-storage") ?? "{}").state
        .gateSteeringThresholds
    ).toEqual({ soft: 3, form: 4, escape: 9 });
  });

  it("saves model and permission changes", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );
    await screen.findByTestId("harness-defaults-claude");

    chooseDropdownValue(screen.getByTestId("claude-default-model"), "opus");
    chooseDropdownValue(screen.getByTestId("claude-default-permission"), "plan");
    chooseDropdownValue(screen.getByTestId("default-harness"), "openai");

    openCodeEditorSettings();
    await waitFor(() =>
      expect(
        getDropdownOption(
          screen.getByTestId("settings-external-editor"),
          "Visual Studio Code"
        )
      ).not.toBeNull()
    );

    chooseDropdownValue(screen.getByTestId("settings-external-editor"), "app:/Applications/Visual Studio Code.app");
    await user.click(screen.getByTestId("settings-nav-appearance"));
    expect(screen.getByTestId("settings-theme")).toHaveAttribute("data-value", "system");
    expect(
      screen.queryByTestId("settings-external-editor")
    ).not.toBeInTheDocument();
    chooseDropdownValue(screen.getByTestId("settings-theme"), "dark");
    await user.click(screen.getByTestId("settings-nav-chat"));
    chooseDropdownValue(screen.getByTestId("codex-default-reasoning-effort"), "high");
    chooseDropdownValue(screen.getByTestId("codex-default-speed-tier"), "fast");

    await waitFor(() => {
      expect(useLocalChatDefaultsStore.getState().defaults).toEqual({
        anthropic: { modelId: "opus", permissionMode: "plan" },
        openai: { reasoningEffort: "high", speedTier: "fast" },
      });
      expect(useLocalChatDefaultsStore.getState().defaultProvider).toEqual({
        id: "openai",
        harness: "codex",
      });
      expect(useUIStore.getState().theme).toBe("dark");
      expect(useUIStore.getState().externalEditor).toBe(
        "app:/Applications/Visual Studio Code.app"
      );
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(
          "vertebrae.local-chat-provider-defaults.v2"
        ) ?? "{}"
      )
    ).toEqual({
      defaultProvider: { id: "openai", harness: "codex" },
      providers: {
        anthropic: { modelId: "opus", permissionMode: "plan" },
        openai: { reasoningEffort: "high", speedTier: "fast" },
      },
    });
  });

  it("configures code themes per appearance and inline code styling", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-code-editor"));

    // System appearance with a light OS (the default matchMedia mock).
    const codeTheme = screen.getByRole("button", { name: "Code theme" });
    expect(codeTheme).toHaveAttribute("data-value", "pierre-light");
    chooseDropdownValue(codeTheme, "github-light");
    expect(useUIStore.getState()).toMatchObject({
      codeThemeLight: "github-light",
      codeThemeDark: "pierre-dark",
    });

    const foreground = screen.getByRole("button", {
      name: "Inline code text",
    });
    const background = screen.getByRole("button", {
      name: "Inline code background",
    });
    const reset = screen.getByTestId("settings-inline-code-reset");
    expect(foreground).toHaveAttribute("data-value", "");
    expect(reset).toBeDisabled();

    chooseDropdownValue(foreground, "info");
    chooseDropdownValue(background, "bg-2");
    expect(useUIStore.getState()).toMatchObject({
      inlineCodeForeground: "info",
      inlineCodeBackground: "bg-2",
    });

    await user.click(reset);
    expect(useUIStore.getState()).toMatchObject({
      inlineCodeForeground: null,
      inlineCodeBackground: null,
      codeThemeLight: "github-light",
    });
    expect(foreground).toHaveAttribute("data-value", "");
    expect(background).toHaveAttribute("data-value", "");
  });

  it("previews inline code, fenced code and a diff", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-code-editor"));

    const preview = screen.getByRole("region", { name: "Code preview" });
    expect(preview.querySelector("code")).toHaveTextContent("npm run build");
    expect(await screen.findByTestId("preview-code-snippet")).toHaveTextContent(
      "export function greet"
    );
    const diffPreview = screen.getByRole("region", { name: "Diff preview" });
    expect(
      await within(diffPreview).findByTestId("preview-patch-files")
    ).toHaveTextContent("diff --git a/src/greet.ts");
  });

  it("falls back to the default selection for unavailable stored values", async () => {
    useUIStore.setState({
      codeThemeLight: "removed-theme",
      inlineCodeForeground: "removed-color",
      diffPreferences: {
        ...DEFAULT_DIFF_PREFERENCES,
        diffStyle: "removed" as "split",
      },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-code-editor"));

    expect(screen.getByRole("button", { name: "Code theme" })).toHaveAttribute("data-value", 
      "pierre-light"
    );
    expect(screen.getByRole("button", { name: "Diff layout" })).toHaveAttribute("data-value", 
      "unified"
    );
    expect(
      screen.getByRole("button", { name: "Inline code text" })
    ).toHaveAttribute("data-value", "");
  });

  it("configures and resets diff options", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    );

    await user.click(screen.getByTestId("settings-nav-code-editor"));
    const reset = screen.getByRole("button", { name: "Reset diff options" });
    expect(reset).toBeDisabled();

    const choose = async (name: string, value: string) =>
      chooseDropdownValue(screen.getByRole("button", { name }), value);
    await choose("Diff layout", "split");
    await choose("Change markers", "classic");
    await choose("Inline changes", "char");
    await choose("Long lines", "wrap");
    await choose("Hunk separators", "metadata");
    await choose("Diff line numbers", "off");
    await choose("Change backgrounds", "off");

    expect(useUIStore.getState().diffPreferences).toEqual({
      diffStyle: "split",
      diffIndicators: "classic",
      lineDiffType: "char",
      overflow: "wrap",
      hunkSeparators: "metadata",
      lineNumbers: false,
      backgrounds: false,
    });
    expect(screen.getByTestId("settings-saved-indicator")).toBeVisible();

    await user.click(reset);
    expect(useUIStore.getState().diffPreferences).toEqual(
      DEFAULT_DIFF_PREFERENCES
    );
    expect(screen.getByRole("button", { name: "Diff layout" })).toHaveAttribute("data-value", 
      "unified"
    );
  });

  describe("contextual code theme", () => {
    const originalMatchMedia = window.matchMedia;
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    function mockOsDark(dark: boolean) {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("dark") ? dark : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
    }

    async function openCodeEditor() {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      );
      await user.click(screen.getByTestId("settings-nav-code-editor"));
      return user;
    }

    const picker = () => screen.getByRole("button", { name: "Code theme" });
    const optionValues = () => dropdownOptionValues(picker());

    it.each([
      ["light", false, "light"],
      ["light", true, "light"],
      ["dark", false, "dark"],
      ["dark", true, "dark"],
      ["system", true, "dark"],
      ["system", false, "light"],
    ] as const)(
      "with %s appearance and OS dark=%s lists only %s themes",
      async (theme, osDark, scheme) => {
        mockOsDark(osDark);
        useUIStore.setState({ theme });
        await openCodeEditor();

        expect(
          screen.getAllByRole("button", { name: "Code theme" })
        ).toHaveLength(1);
        expect(picker()).toHaveAttribute("data-scheme", scheme);
        expect(optionValues()).toEqual(
          codeThemesFor(scheme).map((option) => option.name)
        );
        expect(optionValues()).toHaveLength(scheme === "dark" ? 49 : 26);
      }
    );

    it("swaps the listed themes with the appearance and keeps both choices", async () => {
      mockOsDark(false);
      useUIStore.setState({ theme: "light", codeThemeDark: "tokyo-night" });
      const user = await openCodeEditor();

      chooseDropdownValue(picker(), "one-light");
      expect(optionValues()).not.toContain("tokyo-night");

      const darkAppearanceNavigation = screen.getByTestId(
        "settings-nav-appearance"
      );
      await user.click(darkAppearanceNavigation);
      const darkThemePicker = screen.getByTestId("settings-theme");
      chooseDropdownValue(darkThemePicker, "dark");
      openCodeEditorSettings();
      expect(picker()).toHaveAttribute("data-value", "tokyo-night");
      expect(optionValues()).not.toContain("one-light");
      chooseDropdownValue(picker(), "nord");

      const lightAppearanceNavigation = screen.getByTestId(
        "settings-nav-appearance"
      );
      await user.click(lightAppearanceNavigation);
      const lightThemePicker = screen.getByTestId("settings-theme");
      chooseDropdownValue(lightThemePicker, "light");
      openCodeEditorSettings();
      expect(picker()).toHaveAttribute("data-value", "one-light");
      expect(useUIStore.getState()).toMatchObject({
        codeThemeDark: "nord",
        codeThemeLight: "one-light",
      });
    });

    it("falls back when a stored theme belongs to the other appearance", async () => {
      mockOsDark(false);
      useUIStore.setState({ theme: "dark", codeThemeDark: "github-light" });
      await openCodeEditor();

      expect(picker()).toHaveAttribute("data-value", "pierre-dark");
    });
  });
});
