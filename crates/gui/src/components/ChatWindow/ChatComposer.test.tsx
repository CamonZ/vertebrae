import { withBuiltinProviders } from "../../test/localChatCatalog";
import {
  getComposerPicker,
  queryComposerPicker,
  openModelSettings,
} from "../../test/composerControls";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ChatComposer } from "./ChatComposer";
import type { ChatSession } from "../../stores/chatStore";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
} from "../../bindings";
import type {
  PendingDiffComment,
  PendingTextComment,
} from "./assistantTextComments";
import {
  chooseDropdownValue,
  dropdownOptions,
  dropdownOptionValues,
  getDropdownOption,
} from "../../test/dropdown";

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "test-session",
    label: "Test Chat",
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    permissionMode: "default",
    selectedModelId: null,
    selectedReasoningEffort: null,
    ...overrides,
  };
}

const CLAUDE_INFO: LocalChatHarnessInfo = {
  harness: "claude",
  label: "Claude",
  available: true,
  unavailable_reason: null,
  default_model_id: "sonnet",
  default_reasoning_effort: null,
  reasoning_efforts: [],
  supports_resume: true,
  models: [
    { id: "sonnet", label: "Sonnet", supported_reasoning_effort_ids: null },
    { id: "opus", label: "Opus", supported_reasoning_effort_ids: null },
  ],
};

const CODEX_INFO: LocalChatHarnessInfo = {
  harness: "codex",
  label: "Codex",
  available: false,
  unavailable_reason: "Not installed",
  default_model_id: null,
  default_reasoning_effort: null,
  reasoning_efforts: [],
  supports_resume: true,
  models: [],
};

const CATALOG: LocalChatHarnessCatalog = withBuiltinProviders({
  default_harness: "claude",
  harnesses: [CLAUDE_INFO, CODEX_INFO],
});

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    session: createSession(),
    inputValue: "",
    setInputValue: vi.fn(),
    inputRef: { current: null },
    harnessCatalog: CATALOG,
    visibleHarness: CLAUDE_INFO,
    providerOptions: [{ provider: CATALOG.providers[0], info: CLAUDE_INFO }],
    selectedProviderId: "anthropic",
    supportedModelIds: new Set(["sonnet", "opus"]),
    supportedReasoningEffortIds: new Set<string>(),
    speedTiers: [],
    supportedSpeedTierIds: new Set<string>(),
    isBusy: false,
    isActive: false,
    lockedHarness: false,
    hasResume: false,
    hasAvailableHarness: true,
    canUseComposer: true,
    canSendMessage: false,
    shouldStartOrResume: true,
    submitLabel: "Start session",
    composerPlaceholder: "Type a message...",
    ctxPct: 0,
    ctxColor: "var(--color-ok)",
    usage: null,
    onSend: vi.fn(),
    onStartSession: vi.fn(),
    onHarnessChange: vi.fn(),
    onModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    onSpeedTierChange: vi.fn(),
    onPermissionModeChange: vi.fn(),
    ...overrides,
  };
}

describe("ChatComposer", () => {
  const pendingComment: PendingTextComment = {
    kind: "text",
    id: "comment-1",
    responseId: "response-1",
    itemId: "item-1",
    quote: "Please update this parser.",
    contextBefore: "First, ",
    contextAfter: " Then rerun tests.",
    body: "Explain which parser.",
  };

  it("renders curated intelligence order with a single Codex default choice", () => {
    const ids = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"];
    const info = {
      ...CODEX_INFO,
      available: true,
      default_model_id: "default",
      models: [
        { id: "default", label: "Codex default" },
        ...ids.map((id) => ({ id, label: id })),
      ],
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: info,
          selectedProviderId: "openai",
          session: createSession({ harness: "codex" }),
        })}
      />
    );
    const picker = getComposerPicker("local-chat-model-picker");
    expect(dropdownOptionValues(picker)).toEqual([
      "",
      ...ids,
    ]);
  });

  it("keeps a custom provider's default-named model and list order", () => {
    const info = {
      ...CODEX_INFO,
      available: true,
      models: [
        { id: "default", label: "Custom default" },
        { id: "sol", label: "Custom sol" },
      ],
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: info,
          selectedProviderId: "custom",
          session: createSession({ harness: "codex", providerId: "custom" }),
        })}
      />
    );
    const picker = getComposerPicker("local-chat-model-picker");
    expect(dropdownOptionValues(picker)).toEqual([
      "",
      "default",
      "sol",
    ]);
  });

  // --- Context bar ---

  it("renders the context fill bar with width and color", () => {
    render(
      <ChatComposer
        {...defaultProps({ ctxPct: 42, ctxColor: "var(--color-warn)" })}
      />
    );
    const fill = screen.getByTestId("chat-context-fill");
    expect(fill).toHaveStyle({ width: "42%", background: "var(--color-warn)" });
  });

  it("renders the context footer meta with percentage when usage exists", () => {
    render(
      <ChatComposer
        {...defaultProps({
          ctxPct: 50,
          usage: { used: 100, max: 200 },
          threadTotalTokens: 900,
        })}
      />
    );
    expect(screen.getByText(/context/)).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText(/thread 900/)).toBeInTheDocument();
  });

  it("renders non-breaking space when usage is null", () => {
    const { container } = render(<ChatComposer {...defaultProps()} />);
    const meta = container.querySelector(".hc-foot-meta");
    expect(meta).toBeInTheDocument();
    // The aria-hidden attribute should be true when no usage
    expect(meta?.getAttribute("aria-hidden")).toBe("true");
  });

  it("includes model name in the context meta when session has a model", () => {
    render(
      <ChatComposer
        {...defaultProps({
          ctxPct: 30,
          usage: { used: 30, max: 100 },
          session: createSession({ model: "claude-sonnet-4-20250514" }),
        })}
      />
    );
    const ctxLbl = document.querySelector(".ctx-lbl");
    expect(ctxLbl?.textContent).toContain("context");
    expect(ctxLbl?.textContent).toContain("sonnet-4-20250514");
  });

  // --- Provider picker ---

  it("renders only available harnesses in the provider picker", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = getComposerPicker("local-chat-provider-picker");
    expect(picker).toBeInTheDocument();
    expect(
      dropdownOptions(picker).map(
        (option) => option.label
      )
    ).toEqual(["Anthropic"]);
  });

  it("fires onHarnessChange when provider is changed", () => {
    const onHarnessChange = vi.fn();
    const second = CATALOG.providers[1];
    render(
      <ChatComposer
        {...defaultProps({
          onHarnessChange,
          providerOptions: [
            { provider: CATALOG.providers[0], info: CLAUDE_INFO },
            { provider: second, info: { ...CODEX_INFO, available: true } },
          ],
        })}
      />
    );

    chooseDropdownValue(getComposerPicker("local-chat-provider-picker"), second.id);
    expect(onHarnessChange).toHaveBeenCalledOnce();
    expect(onHarnessChange.mock.calls[0][0].target.value).toBe(second.id);
  });

  it("disables provider picker when busy", () => {
    render(<ChatComposer {...defaultProps({ isBusy: true })} />);
    expect(getComposerPicker("local-chat-provider-picker")).toBeDisabled();
  });

  it("disables provider picker when active", () => {
    render(<ChatComposer {...defaultProps({ isActive: true })} />);
    expect(getComposerPicker("local-chat-provider-picker")).toBeDisabled();
  });

  it("disables provider picker when harness is locked", () => {
    render(<ChatComposer {...defaultProps({ lockedHarness: true })} />);
    expect(getComposerPicker("local-chat-provider-picker")).toBeDisabled();
  });

  it("does not render the provider picker when no catalog", () => {
    render(<ChatComposer {...defaultProps({ harnessCatalog: null })} />);
    expect(
      queryComposerPicker("local-chat-provider-picker")
    ).not.toBeInTheDocument();
  });

  // --- Permission mode picker ---

  it("renders the Claude permission mode picker with all supported options", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = screen.getByTestId("local-chat-permission-mode-picker");
    expect(picker).toBeInTheDocument();
    expect(dropdownOptionValues(picker)).toEqual([
      "default",
      "accept_edits",
      "plan",
      "auto",
      "dont_ask",
      "bypass_permissions",
    ]);
  });

  it("renders only Codex permission profiles for Codex sessions", () => {
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({ harness: "codex" }),
          visibleHarness: {
            ...CODEX_INFO,
            available: true,
            unavailable_reason: null,
          },
        })}
      />
    );
    const picker = screen.getByTestId("local-chat-permission-mode-picker");
    expect(
      dropdownOptions(picker).map((option) => [option.label, option.value])
    ).toEqual([
      ["Ask for approval", "default"],
      ["Approve for me", "auto"],
      ["Full access", "bypass_permissions"],
    ]);
  });

  it("fires onPermissionModeChange when changed", () => {
    const onPermissionModeChange = vi.fn();
    render(<ChatComposer {...defaultProps({ onPermissionModeChange })} />);

    chooseDropdownValue(
      screen.getByTestId("local-chat-permission-mode-picker"),
      "plan"
    );
    expect(onPermissionModeChange).toHaveBeenCalledOnce();
    expect(onPermissionModeChange).toHaveBeenCalledWith("plan");
  });

  it("summarises provider, model and effort on the collapsed model chip", () => {
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({ selectedModelId: "unknown-model" }),
        })}
      />
    );
    const chip = screen.getByTestId("local-chat-model-settings");
    expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Model settings" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog", { name: "Model settings" })).toBeNull();
    expect(chip).toHaveFocus();
  });

  it("keeps picker controls accessible without visible text labels", () => {
    const harnessWithEfforts: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      reasoning_efforts: [{ id: "low", label: "Low" }],
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: harnessWithEfforts,
          supportedReasoningEffortIds: new Set(["low"]),
        })}
      />
    );

    // Collapsed footer: no visible field labels, just the chips.
    for (const label of ["Provider", "Permission", "Model", "Effort"]) {
      expect(
        screen.queryByText(label, { exact: true })
      ).not.toBeInTheDocument();
    }
    expect(
      screen.getByLabelText("Local chat permission mode")
    ).toBeInTheDocument();
    // The model settings popover labels each picker.
    openModelSettings();
    const popover = screen.getByRole("dialog", { name: "Model settings" });
    for (const label of ["Provider", "Model", "Effort"]) {
      expect(within(popover).getByText(label, { exact: true })).toBeVisible();
    }
    expect(screen.getByLabelText("Local chat provider")).toBeInTheDocument();
    expect(screen.getByLabelText("Claude model")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Claude reasoning effort")
    ).toBeInTheDocument();
  });

  it("keeps the permission picker enabled during a running turn", () => {
    render(
      <ChatComposer {...defaultProps({ isBusy: true, isActive: true })} />
    );
    expect(
      screen.getByTestId("local-chat-permission-mode-picker")
    ).toBeEnabled();
  });

  // --- Model picker ---

  it("renders the model picker with model options", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = getComposerPicker("local-chat-model-picker");
    expect(picker).toBeInTheDocument();
    const optionTexts = dropdownOptions(picker).map((o) => o.label);
    // sonnet is the default so it gets the suffix
    expect(optionTexts).toContain("Sonnet (default)");
    expect(optionTexts).toContain("Opus");
  });

  it("marks the default model with (default)", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = getComposerPicker("local-chat-model-picker");
    const optionTexts = dropdownOptions(picker).map((o) => o.label);
    expect(optionTexts).toContain("Sonnet (default)");
  });

  it("fires onModelChange when model is changed", () => {
    const onModelChange = vi.fn();
    render(<ChatComposer {...defaultProps({ onModelChange })} />);

    chooseDropdownValue(getComposerPicker("local-chat-model-picker"), "opus");
    expect(onModelChange).toHaveBeenCalledOnce();
  });

  it.each([
    ["busy", { isBusy: true }],
    ["active", { isActive: true }],
    ["locked to a resumed harness", { lockedHarness: true }],
  ])("keeps the model picker enabled when %s", (_state, props) => {
    render(<ChatComposer {...defaultProps(props)} />);
    expect(getComposerPicker("local-chat-model-picker")).toBeEnabled();
  });

  it("disables the model picker when the harness is unavailable", () => {
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: { ...CLAUDE_INFO, available: false },
        })}
      />
    );
    expect(getComposerPicker("local-chat-model-picker")).toBeDisabled();
  });

  it("shows 'Default model' label when harness has a default model and not resuming", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = getComposerPicker("local-chat-model-picker");
    expect(dropdownOptions(picker)[0].label).toBe("Default model");
  });

  it("shows 'Current model' label when session has providerResumeId", () => {
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({ providerResumeId: "resume-1" }),
        })}
      />
    );
    const picker = getComposerPicker("local-chat-model-picker");
    expect(dropdownOptions(picker)[0].label).toBe("Current model");
  });

  it("shows unsupported model entry when selected model is not in the catalog", () => {
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({ selectedModelId: "unknown-model" }),
        })}
      />
    );
    // The collapsed chip flags the stale choice; the popover lists it.
    expect(screen.getByTestId("local-chat-model-settings")).toHaveClass(
      "attention"
    );
    openModelSettings();
    expect(screen.getByText("Unsupported: unknown-model")).toBeInTheDocument();
  });

  it("does not render model picker when visibleHarness is null", () => {
    render(
      <ChatComposer
        {...defaultProps({ visibleHarness: null, harnessCatalog: null })}
      />
    );
    expect(
      queryComposerPicker("local-chat-model-picker")
    ).not.toBeInTheDocument();
  });

  // --- Effort picker ---

  it("does not render effort picker when harness has no reasoning efforts", () => {
    render(<ChatComposer {...defaultProps()} />);
    expect(
      queryComposerPicker("local-chat-effort-picker")
    ).not.toBeInTheDocument();
  });

  it("renders effort picker when harness has reasoning efforts", () => {
    const harnessWithEfforts: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      reasoning_efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      default_reasoning_effort: "low",
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: harnessWithEfforts,
          supportedReasoningEffortIds: new Set(["low", "high"]),
        })}
      />
    );
    const picker = getComposerPicker("local-chat-effort-picker");
    expect(picker).toBeInTheDocument();
    const optionTexts = dropdownOptions(picker).map((o) => o.label);
    // Low is the default so it gets the suffix
    expect(optionTexts).toContain("Low (default)");
    expect(optionTexts).toContain("High");
  });

  it("renders speed tiers advertised by the selected model", () => {
    const speedHarness: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      default_model_id: "opus",
      models: [
        {
          id: "opus",
          label: "Opus",
          supported_speed_tier_ids: ["default", "fast"],
        },
      ],
      speed_tiers: [
        { id: "default", label: "Standard", is_default: true },
        { id: "fast", label: "Fast", is_default: false },
      ],
    };
    const onSpeedTierChange = vi.fn();
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: speedHarness,
          session: createSession({ selectedModelId: "opus" }),
          speedTiers: speedHarness.speed_tiers,
          supportedSpeedTierIds: new Set(["default", "fast"]),
          onSpeedTierChange,
        })}
      />
    );

    const picker = getComposerPicker("local-chat-speed-tier-picker");
    expect(dropdownOptions(picker).map((option) => option.value)).toEqual([
      "default",
      "fast",
    ]);
    expect(
      dropdownOptions(picker).map((option) => option.label)
    ).toEqual(["Standard", "Fast"]);
    expect(picker).toHaveAttribute("data-value", "default");
    chooseDropdownValue(picker, "fast");
    expect(onSpeedTierChange).toHaveBeenCalledOnce();
  });

  it("hides speed tiers when the selected model has no fast capability", () => {
    render(
      <ChatComposer
        {...defaultProps({
          speedTiers: [{ id: "default", label: "Standard", is_default: true }],
          supportedSpeedTierIds: new Set(["default"]),
        })}
      />
    );
    expect(
      queryComposerPicker("local-chat-speed-tier-picker")
    ).not.toBeInTheDocument();
  });

  it.each(["active", "resuming", "busy"])(
    "keeps the provider fixed and turn settings editable when %s",
    (state) => {
      const speedHarness: LocalChatHarnessInfo = {
        ...CLAUDE_INFO,
        reasoning_efforts: [{ id: "high", label: "High" }],
        speed_tiers: [
          { id: "default", label: "Standard", is_default: true },
          { id: "fast", label: "Fast", is_default: false },
        ],
      };
      render(
        <ChatComposer
          {...defaultProps({
            visibleHarness: speedHarness,
            speedTiers: speedHarness.speed_tiers,
            supportedSpeedTierIds: new Set(["default", "fast"]),
            hasResume: state === "resuming",
            isActive: state === "active",
            isBusy: state === "busy",
            lockedHarness: true,
            supportedReasoningEffortIds: new Set(["high"]),
            session: createSession({ providerResumeId: "resume-1" }),
          })}
        />
      );
      const picker = getComposerPicker("local-chat-speed-tier-picker");
      expect(picker).toBeEnabled();
      expect(picker).toHaveAttribute("data-value", "");
      expect(getDropdownOption(picker, "Current tier")).not.toBeNull();
      expect(getComposerPicker("local-chat-model-picker")).toBeEnabled();
      expect(getComposerPicker("local-chat-effort-picker")).toBeEnabled();
      expect(
        screen.getByTestId("local-chat-permission-mode-picker")
      ).toBeEnabled();
      expect(getComposerPicker("local-chat-provider-picker")).toBeDisabled();
    }
  );

  it("renders only the selected model's supported effort options", () => {
    const harnessWithModelSpecificEfforts: LocalChatHarnessInfo = {
      ...CODEX_INFO,
      available: true,
      reasoning_efforts: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
      ],
      models: [
        {
          id: "model-with-limited-effort",
          label: "Limited model",
          supported_reasoning_effort_ids: ["low", "high"],
        },
      ],
    };
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({
            harness: "codex",
            selectedModelId: "model-with-limited-effort",
          }),
          visibleHarness: harnessWithModelSpecificEfforts,
          reasoningEfforts: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          supportedReasoningEffortIds: new Set(["low", "high"]),
        })}
      />
    );

    const picker = getComposerPicker("local-chat-effort-picker");
    expect(dropdownOptions(picker).map((option) => option.value)).toEqual([
      "",
      "low",
      "high",
    ]);
  });

  it("keeps the effort picker enabled when the harness is locked", () => {
    const harnessWithEfforts: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      reasoning_efforts: [{ id: "low", label: "Low" }],
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: harnessWithEfforts,
          lockedHarness: true,
          supportedReasoningEffortIds: new Set(["low"]),
        })}
      />
    );
    expect(getComposerPicker("local-chat-effort-picker")).toBeEnabled();
  });

  // --- Composer input ---

  it("renders the textarea with placeholder", () => {
    render(<ChatComposer {...defaultProps()} />);
    const textarea = screen.getByTestId("local-chat-composer");
    expect(textarea).toHaveAttribute("placeholder", "Type a message...");
  });

  it("disables the textarea when canUseComposer is false", () => {
    render(<ChatComposer {...defaultProps({ canUseComposer: false })} />);
    expect(screen.getByTestId("local-chat-composer")).toBeDisabled();
  });

  // --- Mutation-killing tests ---

  it("disables submit when input is only whitespace", () => {
    render(
      <ChatComposer
        {...defaultProps({
          inputValue: "   ",
          canSendMessage: false,
          shouldStartOrResume: true,
        })}
      />
    );
    const submitBtn = screen.getByRole("button", { name: "Start session" });
    expect(submitBtn).toBeDisabled();
  });

  it("disables submit when canUseComposer is false even with input", () => {
    render(
      <ChatComposer
        {...defaultProps({
          inputValue: "hello",
          canUseComposer: false,
          canSendMessage: false,
          shouldStartOrResume: true,
        })}
      />
    );
    const submitBtn = screen.getByRole("button", { name: "Start session" });
    expect(submitBtn).toBeDisabled();
  });

  it("disables submit when neither canSendMessage nor shouldStartOrResume", () => {
    render(
      <ChatComposer
        {...defaultProps({
          inputValue: "hello",
          canSendMessage: false,
          shouldStartOrResume: false,
        })}
      />
    );
    const submitBtn = screen.getByRole("button", { name: "Start session" });
    expect(submitBtn).toBeDisabled();
  });

  it("enables submit when canSendMessage is true and input is non-empty", () => {
    render(
      <ChatComposer
        {...defaultProps({
          inputValue: "hello",
          canSendMessage: true,
          shouldStartOrResume: false,
          submitLabel: "Send message",
        })}
      />
    );
    const submitBtn = screen.getByRole("button", { name: "Send message" });
    expect(submitBtn).not.toBeDisabled();
  });

  it("disables model picker when harness has no models", () => {
    const noModelHarness: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      models: [],
      default_model_id: null,
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: noModelHarness,
          supportedModelIds: new Set<string>(),
        })}
      />
    );
    expect(getComposerPicker("local-chat-model-picker")).toBeDisabled();
  });

  it("disables model picker when harness is unavailable", () => {
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: CODEX_INFO,
          providerOptions: [
            { provider: CATALOG.providers[1], info: CODEX_INFO },
          ],
        })}
      />
    );
    expect(getComposerPicker("local-chat-model-picker")).toBeDisabled();
  });

  it("shows the neither-installed message and disables the composer", () => {
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: CODEX_INFO,
          providerOptions: [],
          hasAvailableHarness: false,
          canUseComposer: false,
          shouldStartOrResume: false,
        })}
      />
    );

    expect(
      screen.getByTestId("local-chat-provider-unavailable")
    ).toHaveTextContent(
      "Local chat unavailable because neither Claude nor Codex was found."
    );
    expect(screen.getByTestId("local-chat-composer")).toBeDisabled();
  });

  it("keeps a locked unavailable harness from being resumed or replaced", () => {
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({
            harness: "codex",
            providerResumeId: "codex-resume-1",
          }),
          visibleHarness: CODEX_INFO,
          providerOptions: [
            { provider: CATALOG.providers[0], info: CLAUDE_INFO },
          ],
          lockedHarness: true,
          hasResume: true,
          canUseComposer: false,
          shouldStartOrResume: false,
        })}
      />
    );

    expect(
      screen.getByTestId("local-chat-provider-unavailable")
    ).toHaveTextContent("This chat session's harness is no longer available.");
    expect(getComposerPicker("local-chat-provider-picker")).toBeDisabled();
    expect(screen.getByTestId("local-chat-composer")).toBeDisabled();
  });

  it("keeps the effort picker enabled when resuming", () => {
    const harnessWithEfforts: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      reasoning_efforts: [{ id: "low", label: "Low" }],
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: harnessWithEfforts,
          hasResume: true,
          supportedReasoningEffortIds: new Set(["low"]),
        })}
      />
    );
    expect(getComposerPicker("local-chat-effort-picker")).toBeEnabled();
  });

  it("shows 'CLI default' when harness has no default model id and not resuming", () => {
    const noDefaultHarness: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      default_model_id: null,
    };
    render(
      <ChatComposer {...defaultProps({ visibleHarness: noDefaultHarness })} />
    );
    const picker = getComposerPicker("local-chat-model-picker");
    expect(dropdownOptions(picker)[0].label).toBe("CLI default");
  });

  it("shows 'Provider default' for effort when harness has no default reasoning effort", () => {
    const harnessWithEfforts: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      reasoning_efforts: [{ id: "low", label: "Low" }],
      default_reasoning_effort: null,
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: harnessWithEfforts,
          supportedReasoningEffortIds: new Set(["low"]),
        })}
      />
    );
    const picker = getComposerPicker("local-chat-effort-picker");
    expect(dropdownOptions(picker)[0].label).toBe("Provider default");
  });

  it("shows 'Current effort' label when session has resume id", () => {
    const harnessWithEfforts: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      reasoning_efforts: [{ id: "low", label: "Low" }],
      default_reasoning_effort: "low",
    };
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: harnessWithEfforts,
          session: createSession({ providerResumeId: "resume-1" }),
          hasResume: true,
          supportedReasoningEffortIds: new Set(["low"]),
        })}
      />
    );
    const picker = getComposerPicker("local-chat-effort-picker");
    expect(dropdownOptions(picker)[0].label).toBe("Current effort");
  });

  it("strips claude- prefix from model name in context meta", () => {
    render(
      <ChatComposer
        {...defaultProps({
          ctxPct: 30,
          usage: { used: 30, max: 100 },
          session: createSession({ model: "claude-opus-4" }),
        })}
      />
    );
    const ctxLbl = document.querySelector(".ctx-lbl");
    expect(ctxLbl?.textContent).toContain("opus-4");
    expect(ctxLbl?.textContent).not.toContain("claude-opus");
  });

  it("renders permission mode picker with session's current permission mode", () => {
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({ permissionMode: "plan" }),
        })}
      />
    );
    const picker = screen.getByTestId("local-chat-permission-mode-picker");
    expect(picker).toHaveAttribute("data-value", "plan");
  });

  it("shows queued comment details on hover and lets the user edit or remove them", () => {
    const onUpdateComment = vi.fn();
    const onRemoveComment = vi.fn();
    render(
      <ChatComposer
        {...defaultProps({
          pendingComments: [pendingComment],
          onUpdateComment,
          onRemoveComment,
        })}
      />
    );

    expect(
      screen.getByTestId("local-chat-pending-comments")
    ).toBeInTheDocument();
    const commentIcon = screen.getByTestId("local-chat-comment-icon-1");
    expect(commentIcon).toBeInTheDocument();
    expect(screen.getByTestId("chat-input-shell")).toContainElement(
      commentIcon
    );
    expect(screen.queryByText(pendingComment.quote)).toBeNull();
    expect(screen.queryByTestId("local-chat-comment-popover")).toBeNull();

    fireEvent.mouseEnter(screen.getByTestId("local-chat-pending-comment"));
    expect(screen.getByTestId("local-chat-comment-popover")).toHaveTextContent(
      "First, Please update this parser. Then rerun tests."
    );
    expect(screen.getByTestId("local-chat-comment-popover")).toHaveTextContent(
      "Explain which parser."
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit comment 1" }));
    fireEvent.change(screen.getByTestId("local-chat-comment-editor"), {
      target: { value: "Please identify the parser." },
    });
    fireEvent.click(screen.getByTestId("local-chat-save-edited-comment"));
    expect(onUpdateComment).toHaveBeenCalledWith(
      "comment-1",
      "Please identify the parser."
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove comment 1" }));
    expect(onRemoveComment).toHaveBeenCalledWith("comment-1");
  });

  it("keeps a clicked comment open after the pointer leaves and closes it outside", () => {
    render(
      <ChatComposer {...defaultProps({ pendingComments: [pendingComment] })} />
    );

    const commentIcon = screen.getByTestId("local-chat-comment-icon-1");
    fireEvent.click(commentIcon);
    expect(commentIcon).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("local-chat-comment-popover")).toHaveClass(
      "w-96"
    );
    expect(
      screen.getByTestId("local-chat-comment-popover")
    ).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByTestId("local-chat-pending-comment"));
    expect(
      screen.getByTestId("local-chat-comment-popover")
    ).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("local-chat-comment-popover")).toBeNull();
  });

  it("sends queued comments by themselves as a quoted plain-text reply", () => {
    const onSend = vi.fn(() => true);
    render(
      <ChatComposer
        {...defaultProps({
          pendingComments: [pendingComment],
          canSendMessage: true,
          isActive: true,
          submitLabel: "Send message",
          onSend,
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith(
      "Comments on the previous response:\n\n" +
        "1. Selected text:\n> Please update this parser.\n" +
        "Nearby context: First, ⟦selection⟧ Then rerun tests.\n" +
        "Comment: Explain which parser."
    );
  });

  it("includes freeform follow-up text with queued comments", () => {
    const onSend = vi.fn(() => true);
    render(
      <ChatComposer
        {...defaultProps({
          pendingComments: [pendingComment],
          canSendMessage: true,
          isActive: true,
          submitLabel: "Send message",
          inputValue: "Also check the new tests.",
          onSend,
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith(
      expect.stringContaining("Follow-up:\nAlso check the new tests.")
    );
  });

  describe("diff comments", () => {
    const diffComment: PendingDiffComment = {
      kind: "diff",
      id: "diff-1",
      body: "Why was this removed?",
      home: { kind: "tool_call", toolUseId: "tool-1", toolName: "Edit" },
      path: "src/a.ts",
      side: "old",
      startLine: 4,
      endLine: 5,
      hunk: "@@ -3,3 +3,1 @@\n ctx\n-a\n-b",
      outdated: true,
    };

    it("lists a diff comment chip with its location, hunk and outdated marker", () => {
      render(
        <ChatComposer
          {...defaultProps({ pendingComments: [pendingComment, diffComment] })}
        />
      );
      expect(screen.getAllByTestId("local-chat-pending-comment")).toHaveLength(
        2
      );
      fireEvent.mouseEnter(
        screen.getAllByTestId("local-chat-pending-comment")[1]
      );
      const popover = screen.getByTestId("local-chat-comment-popover");
      expect(popover).toHaveTextContent(
        "Tool call Edit src/a.ts · src/a.ts:4-5 (old) · outdated"
      );
      expect(screen.getByTestId("local-chat-comment-hunk")).toHaveTextContent(
        "@@ -3,3 +3,1 @@ ctx -a -b"
      );
      expect(popover).toHaveTextContent("Why was this removed?");
    });

    it("edits and removes a diff comment from its chip", () => {
      const onUpdateComment = vi.fn();
      const onRemoveComment = vi.fn();
      render(
        <ChatComposer
          {...defaultProps({
            pendingComments: [diffComment],
            onUpdateComment,
            onRemoveComment,
          })}
        />
      );
      fireEvent.mouseEnter(screen.getByTestId("local-chat-pending-comment"));
      fireEvent.click(screen.getByRole("button", { name: "Edit comment 1" }));
      fireEvent.change(screen.getByTestId("local-chat-comment-editor"), {
        target: { value: "Explain the removal." },
      });
      fireEvent.click(screen.getByTestId("local-chat-save-edited-comment"));
      expect(onUpdateComment).toHaveBeenCalledWith(
        "diff-1",
        "Explain the removal."
      );
      fireEvent.click(screen.getByRole("button", { name: "Remove comment 1" }));
      expect(onRemoveComment).toHaveBeenCalledWith("diff-1");
    });

    it("navigates to a diff comment when its chip is clicked, but not a text comment", () => {
      const onNavigateComment = vi.fn();
      render(
        <ChatComposer
          {...defaultProps({
            pendingComments: [pendingComment, diffComment],
            onNavigateComment,
          })}
        />
      );
      fireEvent.click(screen.getByTestId("local-chat-comment-icon-1"));
      expect(onNavigateComment).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("local-chat-comment-icon-2"));
      expect(onNavigateComment).toHaveBeenCalledExactlyOnceWith("diff-1");
    });

    it("sends diff comments in the review message format", () => {
      const onSend = vi.fn(() => true);
      render(
        <ChatComposer
          {...defaultProps({
            pendingComments: [diffComment],
            canSendMessage: true,
            isActive: true,
            submitLabel: "Send message",
            onSend,
          })}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      expect(onSend).toHaveBeenCalledWith(
        [
          "Review comments on the worktree changes:",
          "",
          "1. Tool call Edit src/a.ts · src/a.ts:4-5 (old) [outdated]",
          "   ```diff",
          "   @@ -3,3 +3,1 @@",
          "    ctx",
          "   -a",
          "   -b",
          "   ```",
          "   Comment: Why was this removed?",
        ].join("\n")
      );
    });
  });
});
