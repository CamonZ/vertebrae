import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SettingsPage } from "./SettingsPage";
import { useLocalChatDefaultsStore } from "../utils/localChatDefaults";
import { useUIStore } from "../stores/uiStore";

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
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
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
