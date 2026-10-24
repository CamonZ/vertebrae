import { useProviderSettingsStore } from "../../stores/providerSettingsStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, Link } from "react-router-dom";
import {
  SharedConfigSettings,
  type ConfigSection,
} from "./SharedConfigSettings";
import { SettingsPage } from "../../pages/SettingsPage";
import { commands, type SharedSettings } from "../../bindings";

vi.mock("../../bindings", () => ({
  commands: {
    getSharedSettings: vi.fn(),
    saveSharedSettings: vi.fn(),
    getSupportedLocalChatHarnesses: vi.fn().mockResolvedValue({
      status: "error",
      error: { message: "Harness discovery unavailable" },
    }),
    getLocalFileEditors: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
  },
  events: { localBackendProgressEvent: { listen: async () => () => {} } },
}));
const settings: SharedSettings = {
  revision: "revision-1",
  path: "/test/config.toml",
  connection_url: "https://backend.example",
  has_connection_token: true,
  effective_connection_url: "https://override.example",
  connection_url_override: true,
  connection_token_override: false,
  typesafe_url: "",
  has_typesafe_key: true,
  typesafe_key_storage: "config",
  credential_warning: null,
  typesafe_endpoint_hidden: false,
  typesafe_key_override: false,
  typesafe_url_override: false,
  providers: [
    {
      id: "custom",
      harness: "codex",
      endpoint_hidden: false,
      endpoint: "http://localhost:8000",
      models: ["model-a"],
      default_model: "model-a",
      api_key_env: "CUSTOM_KEY",
      has_api_key: true,
      key_storage: "config",
      credential_override: true,
      environment_names: ["PRIVATE_KEY"],
      wire_api: "responses",
    },
  ],
  observability: {
    enabled: false,
    endpoint: "http://localhost:4318",
    protocol: "http/protobuf",
    signals: [],
    subsystems: [],
    level: "info",
    capture_message_content: false,
  },
};
const onDirty = vi.fn();
const onBusy = vi.fn();
function mount(section: ConfigSection) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <SharedConfigSettings
            section={section}
            onDirty={onDirty}
            onBusy={onBusy}
          />
          <Link to="/away">Leave settings</Link>
        </>
      ),
    },
    { path: "/away", element: <p>Away</p> },
  ]);
  render(<RouterProvider router={router} />);
  return router;
}
beforeEach(() => {
  useProviderSettingsStore.setState({ revision: 0 });
  vi.clearAllMocks();
  vi.mocked(commands.getSharedSettings).mockResolvedValue({
    status: "ok",
    data: structuredClone(settings),
  });
  vi.mocked(commands.saveSharedSettings).mockResolvedValue({
    status: "ok",
    data: { ...structuredClone(settings), revision: "revision-2" },
  });
});
describe("shared configuration forms", () => {
  it.each(["providers", "connection", "observability"] as const)(
    "renders only the %s pane and restores preferences when returning to Chat",
    async (section) => {
      const user = userEvent.setup();
      render(
        <RouterProvider
          router={createMemoryRouter([
            { path: "/", element: <SettingsPage /> },
          ])}
        />
      );
      expect(screen.getByLabelText("Thinking indicator")).toBeVisible();
      await user.click(screen.getByTestId(`settings-nav-${section}`));
      expect(
        await screen.findByTestId(`shared-settings-${section}`)
      ).toBeVisible();
      expect(
        screen.queryByLabelText("Thinking indicator")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("settings-external-editor")
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("settings-error")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Reload" })).toBeEnabled()
      );
      await user.click(screen.getByTestId("settings-nav-chat"));
      expect(await screen.findByLabelText("Thinking indicator")).toBeVisible();
      expect(
        screen.queryByTestId(`shared-settings-${section}`)
      ).not.toBeInTheDocument();
    }
  );

  it("saves a revisioned connection patch while keeping stored credentials", async () => {
    const user = userEvent.setup();
    mount("connection");
    const url = await screen.findByLabelText("Backend URL");
    expect(screen.getByText(/VTB_URL overrides/)).toHaveTextContent(
      "https://override.example"
    );
    await user.clear(url);
    await user.type(url, "https://new.example");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(commands.saveSharedSettings).toHaveBeenCalledWith("revision-1", {
        section: "connection",
        url: "https://new.example",
        token: { action: "keep" },
      })
    );
    expect(await screen.findByText(/Settings saved/)).toBeVisible();
    expect(
      screen.queryByLabelText("New backend token")
    ).not.toBeInTheDocument();
  });
  it("retains drafts after conflicts and confirms reload", async () => {
    vi.mocked(commands.saveSharedSettings).mockResolvedValue({
      status: "error",
      error: { message: "Configuration changed on disk. Reload." },
    });
    const user = userEvent.setup();
    mount("connection");
    const url = await screen.findByLabelText("Backend URL");
    await user.clear(url);
    await user.type(url, "https://draft.example");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "changed on disk"
    );
    expect(url).toHaveValue("https://draft.example");
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(commands.getSharedSettings).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(url).toHaveValue("https://draft.example");
  });
  it("blocks route navigation until a draft is discarded", async () => {
    const user = userEvent.setup();
    const router = mount("connection");
    await user.type(await screen.findByLabelText("Backend URL"), "/changed");
    await user.click(screen.getByRole("link", { name: "Leave settings" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Unsaved settings"
    );
    expect(router.state.location.pathname).toBe("/");
    await user.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByText("Away")).toBeVisible();
  });
  it("validates models and clears replacement secrets after a successful save", async () => {
    const user = userEvent.setup();
    mount("providers");
    await user.click(await screen.findByRole("button", { name: "custom" }));
    expect(screen.getByLabelText("Provider ID")).toBeDisabled();
    await user.clear(screen.getByLabelText("Model IDs"));
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "model IDs cannot be blank"
    );
    expect(screen.getByLabelText("Model IDs")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.selectOptions(
      screen.getByLabelText("Provider API key"),
      "replace"
    );
    await user.type(
      screen.getByLabelText("New provider api key"),
      "new-secret"
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(commands.saveSharedSettings).toHaveBeenCalledWith(
        "revision-1",
        expect.objectContaining({
          section: "provider",
          key: { action: "replace", value: "new-secret" },
        })
      )
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("New provider api key")
      ).not.toBeInTheDocument()
    );
  });
  it("saves explicit telemetry and message capture selections", async () => {
    const user = userEvent.setup();
    mount("observability");
    await user.click(await screen.findByLabelText("Enable telemetry"));
    await user.click(screen.getByLabelText("Include message content"));
    await user.click(screen.getByLabelText("traces"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(commands.saveSharedSettings).toHaveBeenCalledWith(
        "revision-1",
        expect.objectContaining({
          section: "observability",
          settings: expect.objectContaining({
            enabled: true,
            capture_message_content: true,
            signals: ["traces"],
          }),
        })
      )
    );
  });
  it("offers recovery from read errors without overwriting malformed files", async () => {
    vi.mocked(commands.getSharedSettings).mockResolvedValue({
      status: "error",
      error: { message: "Check config.toml syntax." },
    });
    const user = userEvent.setup();
    mount("connection");
    expect(await screen.findByRole("alert")).toHaveTextContent("syntax");
    expect(
      screen.queryByRole("button", { name: "Save changes" })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload" }));
    expect(commands.getSharedSettings).toHaveBeenCalledTimes(2);
  });
  it("allows keyboard submission and coordinates duplicate saves", async () => {
    let finish!: (
      value: Awaited<ReturnType<typeof commands.saveSharedSettings>>
    ) => void;
    vi.mocked(commands.saveSharedSettings).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const user = userEvent.setup();
    mount("connection");
    const url = await screen.findByLabelText("Backend URL");
    await user.type(url, "/changed{enter}");
    await waitFor(() =>
      expect(commands.saveSharedSettings).toHaveBeenCalledTimes(1)
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    finish({ status: "ok", data: structuredClone(settings) });
    expect(await screen.findByText(/Settings saved/)).toBeVisible();
  });
  it("keeps new sections usable when harness discovery fails and protects section changes", async () => {
    const user = userEvent.setup();
    render(
      <RouterProvider
        router={createMemoryRouter([{ path: "/", element: <SettingsPage /> }])}
      />
    );
    await user.click(screen.getByTestId("settings-nav-connection"));
    const url = await screen.findByLabelText("Backend URL");
    await user.type(url, "/draft");
    await user.click(screen.getByTestId("settings-nav-appearance"));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Unsaved settings"
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(url).toHaveValue("https://backend.example/draft");
    await user.click(screen.getByTestId("settings-nav-appearance"));
    await user.click(
      screen.getByRole("button", { name: "Discard and switch" })
    );
    expect(
      await screen.findByRole("heading", { name: "Appearance", level: 1 })
    ).toBeVisible();
  });
  it("requires explicit replacement of a hidden endpoint rather than silently clearing it", async () => {
    vi.mocked(commands.getSharedSettings).mockResolvedValue({
      status: "ok",
      data: { ...structuredClone(settings), typesafe_endpoint_hidden: true },
    });
    const user = userEvent.setup();
    mount("providers");
    await user.selectOptions(
      await screen.findByLabelText("TypeSafe API key"),
      "clear"
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "safe replacement endpoint"
    );
    await user.type(
      screen.getByLabelText("System One endpoint"),
      "https://api.example/systemone"
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
  it("offers direct API-key entry and stores the replacement without reading it back", async () => {
    const empty = {
      ...structuredClone(settings),
      has_typesafe_key: false,
      typesafe_key_storage: "none",
    };
    vi.mocked(commands.getSharedSettings).mockResolvedValue({
      status: "ok",
      data: empty,
    });
    vi.mocked(commands.saveSharedSettings).mockResolvedValue({
      status: "ok",
      data: {
        ...empty,
        revision: "new",
        has_typesafe_key: true,
        typesafe_key_storage: "os",
      },
    });
    const user = userEvent.setup();
    mount("providers");
    const key = await screen.findByLabelText("New typesafe api key");
    expect(key).toHaveAttribute("type", "password");
    await user.type(key, "test-api-key");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(commands.saveSharedSettings).toHaveBeenCalledWith("revision-1", {
        section: "typesafe",
        url: "",
        key: { action: "replace", value: "test-api-key" },
      })
    );
    expect(
      await screen.findByText(/Uses the OS credential store/)
    ).toBeVisible();
    expect(
      screen.queryByLabelText("New typesafe api key")
    ).not.toBeInTheDocument();
  });
  it("moves legacy keys to the OS store without exposing them in the form", async () => {
    const user = userEvent.setup();
    mount("providers");
    await user.selectOptions(
      await screen.findByLabelText("TypeSafe API key"),
      "migrate"
    );
    expect(
      screen.queryByLabelText("New typesafe api key")
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(commands.saveSharedSettings).toHaveBeenCalledWith("revision-1", {
        section: "typesafe",
        url: "",
        key: { action: "migrate" },
      })
    );
  });
  it("retains entered keys when the OS store is locked and displays cleanup warnings after saving", async () => {
    const user = userEvent.setup();
    mount("providers");
    await user.selectOptions(
      await screen.findByLabelText("TypeSafe API key"),
      "replace"
    );
    await user.type(screen.getByLabelText("New typesafe api key"), "retry-key");
    vi.mocked(commands.saveSharedSettings).mockResolvedValueOnce({
      status: "error",
      error: { message: "OS credential store is locked. Unlock it and retry." },
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("locked");
    expect(screen.getByRole("alert")).not.toHaveTextContent("retry-key");
    expect(screen.getByLabelText("New typesafe api key")).toHaveValue(
      "retry-key"
    );
    vi.mocked(commands.saveSharedSettings).mockResolvedValueOnce({
      status: "ok",
      data: {
        ...structuredClone(settings),
        credential_warning: "Previous OS credential could not be removed.",
      },
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Previous OS credential could not be removed.")
    ).toBeVisible();
  });
  it("refreshes provider pickers only after a confirmed save and shows live-apply feedback", async () => {
    const user = userEvent.setup();
    mount("providers");
    await user.selectOptions(
      await screen.findByLabelText("TypeSafe API key"),
      "replace"
    );
    await user.type(screen.getByLabelText("New typesafe api key"), "new-key");
    vi.mocked(commands.saveSharedSettings).mockResolvedValueOnce({
      status: "error",
      error: { message: "Save failed" },
    });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(useProviderSettingsStore.getState().revision).toBe(0);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(
        "Settings saved. Applies to new sessions and requests."
      )
    ).toBeVisible();
    expect(useProviderSettingsStore.getState().revision).toBe(1);
    expect(
      screen.queryByText(/Saved provider changes take effect after restarting/)
    ).not.toBeInTheDocument();
  });
});
