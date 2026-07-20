import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatComposer } from "./ChatComposer";
import type { ChatSession } from "../../stores/chatStore";
import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
} from "../../bindings";

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

const CATALOG: LocalChatHarnessCatalog = {
  default_harness: "claude",
  harnesses: [CLAUDE_INFO, CODEX_INFO],
};

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    session: createSession(),
    inputValue: "",
    setInputValue: vi.fn(),
    inputRef: { current: null },
    harnessCatalog: CATALOG,
    visibleHarness: CLAUDE_INFO,
    providerOptions: [{ info: CLAUDE_INFO }],
    supportedModelIds: new Set(["sonnet", "opus"]),
    supportedReasoningEffortIds: new Set<string>(),
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
    onPermissionModeChange: vi.fn(),
    ...overrides,
  };
}

describe("ChatComposer", () => {
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
    const picker = screen.getByTestId("local-chat-provider-picker");
    expect(picker).toBeInTheDocument();
    expect(
      Array.from((picker as HTMLSelectElement).options).map(
        (option) => option.textContent
      )
    ).toEqual(["Claude"]);
  });

  it("fires onHarnessChange when provider is changed", () => {
    const onHarnessChange = vi.fn();
    render(<ChatComposer {...defaultProps({ onHarnessChange })} />);

    fireEvent.change(screen.getByTestId("local-chat-provider-picker"), {
      target: { value: "codex" },
    });
    expect(onHarnessChange).toHaveBeenCalledOnce();
  });

  it("disables provider picker when busy", () => {
    render(<ChatComposer {...defaultProps({ isBusy: true })} />);
    expect(screen.getByTestId("local-chat-provider-picker")).toBeDisabled();
  });

  it("disables provider picker when active", () => {
    render(<ChatComposer {...defaultProps({ isActive: true })} />);
    expect(screen.getByTestId("local-chat-provider-picker")).toBeDisabled();
  });

  it("disables provider picker when harness is locked", () => {
    render(<ChatComposer {...defaultProps({ lockedHarness: true })} />);
    expect(screen.getByTestId("local-chat-provider-picker")).toBeDisabled();
  });

  it("does not render the provider picker when no catalog", () => {
    render(<ChatComposer {...defaultProps({ harnessCatalog: null })} />);
    expect(
      screen.queryByTestId("local-chat-provider-picker")
    ).not.toBeInTheDocument();
  });

  // --- Permission mode picker ---

  it("renders the Claude permission mode picker with all supported options", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = screen.getByTestId(
      "local-chat-permission-mode-picker"
    ) as HTMLSelectElement;
    expect(picker).toBeInTheDocument();
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
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
    const picker = screen.getByTestId(
      "local-chat-permission-mode-picker"
    ) as HTMLSelectElement;
    expect(
      Array.from(picker.options).map((option) => [option.text, option.value])
    ).toEqual([
      ["Ask for approval", "default"],
      ["Approve for me", "auto"],
      ["Full access", "bypass_permissions"],
    ]);
  });

  it("fires onPermissionModeChange when changed", () => {
    const onPermissionModeChange = vi.fn();
    render(<ChatComposer {...defaultProps({ onPermissionModeChange })} />);

    fireEvent.change(screen.getByTestId("local-chat-permission-mode-picker"), {
      target: { value: "plan" },
    });
    expect(onPermissionModeChange).toHaveBeenCalledOnce();
  });

  it("disables permission picker when busy", () => {
    render(<ChatComposer {...defaultProps({ isBusy: true })} />);
    expect(
      screen.getByTestId("local-chat-permission-mode-picker")
    ).toBeDisabled();
  });

  // --- Model picker ---

  it("renders the model picker with model options", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = screen.getByTestId(
      "local-chat-model-picker"
    ) as HTMLSelectElement;
    expect(picker).toBeInTheDocument();
    const optionTexts = Array.from(picker.options).map((o) => o.textContent);
    // sonnet is the default so it gets the suffix
    expect(optionTexts).toContain("Sonnet (default)");
    expect(optionTexts).toContain("Opus");
  });

  it("marks the default model with (default)", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = screen.getByTestId(
      "local-chat-model-picker"
    ) as HTMLSelectElement;
    const optionTexts = Array.from(picker.options).map((o) => o.textContent);
    expect(optionTexts).toContain("Sonnet (default)");
  });

  it("fires onModelChange when model is changed", () => {
    const onModelChange = vi.fn();
    render(<ChatComposer {...defaultProps({ onModelChange })} />);

    fireEvent.change(screen.getByTestId("local-chat-model-picker"), {
      target: { value: "opus" },
    });
    expect(onModelChange).toHaveBeenCalledOnce();
  });

  it("disables model picker when busy", () => {
    render(<ChatComposer {...defaultProps({ isBusy: true })} />);
    expect(screen.getByTestId("local-chat-model-picker")).toBeDisabled();
  });

  it("disables model picker when active", () => {
    render(<ChatComposer {...defaultProps({ isActive: true })} />);
    expect(screen.getByTestId("local-chat-model-picker")).toBeDisabled();
  });

  it("disables model picker when locked", () => {
    render(<ChatComposer {...defaultProps({ lockedHarness: true })} />);
    expect(screen.getByTestId("local-chat-model-picker")).toBeDisabled();
  });

  it("shows 'Default model' label when harness has a default model and not resuming", () => {
    render(<ChatComposer {...defaultProps()} />);
    const picker = screen.getByTestId(
      "local-chat-model-picker"
    ) as HTMLSelectElement;
    expect(picker.options[0].textContent).toBe("Default model");
  });

  it("shows 'Original model' label when session has providerResumeId", () => {
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({ providerResumeId: "resume-1" }),
        })}
      />
    );
    const picker = screen.getByTestId(
      "local-chat-model-picker"
    ) as HTMLSelectElement;
    expect(picker.options[0].textContent).toBe("Original model");
  });

  it("shows unsupported model entry when selected model is not in the catalog", () => {
    render(
      <ChatComposer
        {...defaultProps({
          session: createSession({ selectedModelId: "unknown-model" }),
        })}
      />
    );
    expect(screen.getByText("Unsupported: unknown-model")).toBeInTheDocument();
  });

  it("does not render model picker when visibleHarness is null", () => {
    render(
      <ChatComposer
        {...defaultProps({ visibleHarness: null, harnessCatalog: null })}
      />
    );
    expect(
      screen.queryByTestId("local-chat-model-picker")
    ).not.toBeInTheDocument();
  });

  // --- Effort picker ---

  it("does not render effort picker when harness has no reasoning efforts", () => {
    render(<ChatComposer {...defaultProps()} />);
    expect(
      screen.queryByTestId("local-chat-effort-picker")
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
    const picker = screen.getByTestId(
      "local-chat-effort-picker"
    ) as HTMLSelectElement;
    expect(picker).toBeInTheDocument();
    const optionTexts = Array.from(picker.options).map((o) => o.textContent);
    // Low is the default so it gets the suffix
    expect(optionTexts).toContain("Low (default)");
    expect(optionTexts).toContain("High");
  });

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

    const picker = screen.getByTestId(
      "local-chat-effort-picker"
    ) as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      "",
      "low",
      "high",
    ]);
  });

  it("disables effort picker when harness is locked", () => {
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
    expect(screen.getByTestId("local-chat-effort-picker")).toBeDisabled();
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
    expect(screen.getByTestId("local-chat-model-picker")).toBeDisabled();
  });

  it("disables model picker when harness is unavailable", () => {
    render(
      <ChatComposer
        {...defaultProps({
          visibleHarness: CODEX_INFO,
          providerOptions: [{ info: CODEX_INFO }],
        })}
      />
    );
    expect(screen.getByTestId("local-chat-model-picker")).toBeDisabled();
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
          providerOptions: [{ info: CLAUDE_INFO }],
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
    expect(screen.getByTestId("local-chat-provider-picker")).toBeDisabled();
    expect(screen.getByTestId("local-chat-composer")).toBeDisabled();
  });

  it("disables effort picker when resuming", () => {
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
    expect(screen.getByTestId("local-chat-effort-picker")).toBeDisabled();
  });

  it("shows 'CLI default' when harness has no default model id and not resuming", () => {
    const noDefaultHarness: LocalChatHarnessInfo = {
      ...CLAUDE_INFO,
      default_model_id: null,
    };
    render(
      <ChatComposer {...defaultProps({ visibleHarness: noDefaultHarness })} />
    );
    const picker = screen.getByTestId(
      "local-chat-model-picker"
    ) as HTMLSelectElement;
    expect(picker.options[0].textContent).toBe("CLI default");
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
    const picker = screen.getByTestId(
      "local-chat-effort-picker"
    ) as HTMLSelectElement;
    expect(picker.options[0].textContent).toBe("Provider default");
  });

  it("shows 'Original effort' label when session has resume id", () => {
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
    const picker = screen.getByTestId(
      "local-chat-effort-picker"
    ) as HTMLSelectElement;
    expect(picker.options[0].textContent).toBe("Original effort");
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
    const picker = screen.getByTestId(
      "local-chat-permission-mode-picker"
    ) as HTMLSelectElement;
    expect(picker.value).toBe("plan");
  });
});
