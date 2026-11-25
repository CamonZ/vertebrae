import { EMPTY_WORKSPACE } from "../../stores/chatWorkspace";
import { useUIStore } from "../../stores/uiStore";
import {
  getComposerPicker,
  findComposerPicker,
} from "../../test/composerControls";
import {
  clickPaneControl,
  firePaneControl,
  getPaneControl,
  hasPaneControl,
} from "../../test/paneControls";
import { useProviderSettingsStore } from "../../stores/providerSettingsStore";
import { useLocalChatDefaultsStore } from "../../utils/localChatDefaults";
import { withBuiltinProviders } from "../../test/localChatCatalog";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { ChatWindow } from "./ChatWindow";
import { useChatStore } from "../../stores/chatStore";
import { useComposerDraftStore } from "../../stores/composerDraftStore";
import type { ChatSession } from "../../stores/chatStore";
import {
  applyBackgroundUpdate,
  EMPTY_BACKGROUND_WORK,
} from "../../stores/backgroundWork";
import { commands, type WorktreePrAssociation } from "../../bindings";
import { resetWorktreePrChecksStore } from "../../stores/worktreePrChecksStore";
import { resetWorktreePrStore } from "../../stores/worktreePrStore";
import { useDocumentStore } from "./workspace/documentStore";
import { loadPersistedLocalChatSession } from "../../utils/localChatPersistence";
import {
  routeLocalChatSessionEndEvent,
  routeLocalChatSessionErrorEvent,
  routeLocalChatTextEvent,
  routeLocalChatToolCallEvent,
  routeLocalChatToolResultEvent,
  routeLocalChatTurnStartedEvent,
  routeLocalChatSteeringInputEvent,
  routePermissionRequestEvent,
} from "../../hooks/useLocalChatEventRouter";
import {
  chooseDropdownValue,
  dropdownOptions,
  dropdownOptionValues,
} from "../../test/dropdown";

vi.mock("./workspace/SourceEvidenceCode", () => ({
  default: ({
    source,
    line,
    endLine,
  }: {
    source: { contents: string };
    line?: number;
    endLine?: number;
  }) => (
    <pre data-line={line} data-end-line={endLine}>
      {source.contents}
    </pre>
  ),
}));

// Mock scrollIntoView
Element.prototype.scrollIntoView = vi.fn();
const mockedCommands = vi.mocked(commands);

// Mock the bindings
vi.mock("../../bindings", async () => {
  const { withBuiltinProviders } = await import("../../test/localChatCatalog");
  return {
    commands: {
      worktreeFileExists: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: true }),
      readChatHistoryFile: vi.fn().mockResolvedValue({
        status: "ok",
        data: { kind: "text", contents: "recorded file", revision: "old" },
      }),
      readWorktreeFile: vi.fn().mockResolvedValue({
        status: "ok",
        data: { kind: "text", contents: "file", revision: "r" },
      }),
      listComparisonChoices: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: [] }),
      loadWorktreeChanges: vi.fn().mockResolvedValue({
        status: "ok",
        data: {
          base_branch: null,
          base_unavailable: "No base",
          files: [],
          comparison: {
            base_commit: "base",
            selected_base_commit: "base",
            target_commit: "head",
            working_tree: true,
            merge_base: true,
          },
          totals: { additions: 0, deletions: 0, binary_files: 0 },
        },
      }),
      getWorktreePrAssociation: vi.fn(),
      getWorktreePrChecks: vi.fn(),
      rerunWorktreePrCheck: vi.fn(),
      getWorktreePublishedHead: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: null }),
      listWorktreeDirectory: vi.fn().mockResolvedValue({
        status: "ok",
        data: { path: "", entries: [], truncated: false },
      }),
      getCurrentProjectPath: vi.fn().mockResolvedValue({
        status: "ok",
        data: "/test/project",
      }),
      getSupportedLocalChatHarnesses: vi.fn().mockResolvedValue({
        status: "ok",
        data: withBuiltinProviders({
          default_harness: "claude",
          harnesses: [
            {
              harness: "claude",
              label: "Claude",
              available: true,
              unavailable_reason: null,
              default_model_id: "sonnet",
              default_reasoning_effort: null,
              reasoning_efforts: [],
              supports_resume: true,
              models: [
                { id: "sonnet", label: "Sonnet" },
                { id: "opus", label: "Opus" },
                { id: "haiku", label: "Haiku" },
                { id: "fable", label: "Fable" },
              ],
            },
            {
              harness: "codex",
              label: "Codex",
              available: false,
              unavailable_reason: "Codex app-server is not installed",
              default_model_id: null,
              default_reasoning_effort: null,
              reasoning_efforts: [],
              supports_resume: true,
              models: [],
            },
          ],
        }),
      }),
      createLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
      getLocalFileRoots: vi.fn().mockResolvedValue({
        status: "ok",
        data: ["/test/project"],
      }),
      inferLocalChatSessionTitle: vi.fn().mockResolvedValue({
        status: "ok",
        data: {
          title: "Inferred Title",
          confidence: 0.91,
          sufficient_signal: true,
        },
      }),
      steerLocalChatTurn: vi.fn(),
      sendLocalChatMessage: vi.fn().mockResolvedValue({ status: "ok" }),
      closeLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
      interruptLocalChatTurn: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: null }),
      resolvePermissionRequest: vi.fn().mockResolvedValue({ status: "ok" }),
      getTask: vi.fn().mockResolvedValue({ status: "ok", data: null }),
      getStep: vi.fn().mockResolvedValue({ status: "ok", data: null }),
      getWorkflowWithTasks: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: null }),
      getCurrentProject: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: "test-project" }),
      getTaskExecutions: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    },
    events: {
      localChatSessionInitEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
      localChatSessionUsageEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
      localChatTextEvent: { listen: vi.fn(() => Promise.resolve(() => {})) },
      localChatAnnotationEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
      localChatToolCallEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
      localChatToolResultEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
      permissionRequestEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
      localChatSessionEndEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
      localChatSessionErrorEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
      localChatSessionWarningEvent: {
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
    },
  };
});

function createSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "test-session",
    label: "Test Task",
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    ...overrides,
  };
}

function mockAvailableCodexHarness() {
  mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
    status: "ok",
    data: withBuiltinProviders({
      default_harness: "codex",
      harnesses: [
        {
          harness: "codex",
          label: "Codex",
          available: true,
          unavailable_reason: null,
          default_model_id: "default",
          default_reasoning_effort: "medium",
          reasoning_efforts: [{ id: "medium", label: "Medium" }],
          supports_resume: true,
          models: [{ id: "default", label: "Default" }],
        },
      ],
    }),
  });
}

describe("ChatWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useLocalChatDefaultsStore.setState({ defaults: {}, defaultProvider: null });
    useUIStore.setState({ inlineDiscussionPreference: { mode: "follow" } });
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { ...EMPTY_WORKSPACE, order: [], activeId: null },
      panelOpen: false,
    });
  });

  it.each([
    { name: "main checkout", original: "/test/project", current: null },
    {
      name: "association worktree",
      original: "/saved-feature",
      current: "/current",
    },
  ])(
    "opens recorded files in Changes for a $name",
    async ({ original, current }) => {
      const association = {
        ticketId: null,
        ticketTitle: null,
        worktreePath: current,
        branch: null,
        lastProcessedAt: null,
        processedAtCount: 0,
        awaitingWorktree: null,
        recentWorktrees: [],
      };
      useChatStore.setState({
        sessions: {
          "test-session": createSession({
            projectPath: "/test/project",
            ...(current ? { association } : {}),
            toolAnnotations: {
              '["turn","saved-turn"]': {
                worktree_origin: {
                  session_id: "test-session",
                  tool_id: "",
                  subject: { kind: "turn", id: "saved-turn" },
                  kind: "worktree_origin",
                  recorded_at: "2026-11-16T00:00:00Z",
                  payload: { worktree: original, epoch: "original" },
                },
              },
            },
            messages: [
              {
                kind: "assistant",
                turnId: "saved-turn",
                itemId: "saved-source",
                text: "[source](src/a.ts:12:3)",
                timestamp: "2026-11-16T00:00:00Z",
              },
            ],
          }),
        },
      });
      render(<ChatWindow sessionId="test-session" />);
      await userEvent.click(screen.getByTestId("local-file-reference-link"));

      const changes = () =>
        within(screen.getByRole("complementary", { name: "Side column" }));
      const file = () =>
        within(changes().getByRole("region", { name: "File src/a.ts" }));
      expect(await file().findByText("recorded file")).toHaveAttribute(
        "data-line",
        "12"
      );
      expect(commands.readChatHistoryFile).toHaveBeenCalledExactlyOnceWith(
        "test-session",
        "saved-turn",
        "src/a.ts"
      );
      expect(commands.readWorktreeFile).not.toHaveBeenCalled();
      expect(
        useDocumentStore.getState().workspaces[original]?.documents["src/a.ts"]
      ).toBeUndefined();

      act(() =>
        useChatStore.getState().setSessionAssociation("test-session", {
          ...association,
          worktreePath: "/replacement",
        })
      );
      await userEvent.click(file().getByRole("radio", { name: "Latest file" }));
      expect(await file().findByText("file")).toHaveAttribute(
        "data-line",
        "12"
      );
      expect(commands.readWorktreeFile).toHaveBeenCalledExactlyOnceWith(
        original,
        "src/a.ts"
      );

      await userEvent.click(
        file().getByRole("button", { name: "Close file reference" })
      );
      expect(
        changes().queryByRole("region", { name: "File src/a.ts" })
      ).not.toBeInTheDocument();
    }
  );

  it("keeps a missing capture explicit and a dismissed reference closed", async () => {
    mockedCommands.readChatHistoryFile.mockResolvedValueOnce({
      status: "ok",
      data: {
        error: {
          kind: "not_captured",
          message: "Capture pending",
          retryable: true,
        },
      },
    });
    useChatStore.setState({
      sessions: {
        "test-session": createSession({
          projectPath: "/test/project",
          messages: [
            {
              kind: "assistant",
              turnId: "pending-turn",
              itemId: "reply",
              text: "[source](src/pending.ts:12)",
              timestamp: "2026-11-16T00:00:00Z",
            },
          ],
        }),
      },
    });
    render(<ChatWindow sessionId="test-session" />);
    await userEvent.click(screen.getByTestId("local-file-reference-link"));

    const changes = within(
      screen.getByRole("complementary", { name: "Side column" })
    );
    expect(await changes.findByText("Capture pending")).toBeVisible();
    expect(mockedCommands.readWorktreeFile).not.toHaveBeenCalled();
    await userEvent.click(
      changes.getByRole("button", { name: "Close file reference" })
    );

    act(() =>
      useChatStore.getState().applyToolAnnotation("test-session", {
        session_id: "test-session",
        tool_id: "",
        subject: { kind: "turn", id: "pending-turn" },
        kind: "worktree_origin",
        recorded_at: "2026-11-16T00:00:00Z",
        payload: { worktree: "/original", epoch: "pending" },
      })
    );
    expect(
      screen.getByRole("complementary", { name: "Side column" })
    ).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "File src/pending.ts" })
    ).toBeNull();
    expect(mockedCommands.readChatHistoryFile).toHaveBeenCalledTimes(1);
  });

  it("keeps Changes resizable after a worktree association replaces its container", async () => {
    const observations: {
      node?: Element;
      notify: (width: number) => void;
      disconnect: () => void;
    }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        record: (typeof observations)[number];
        constructor(callback: ResizeObserverCallback) {
          this.record = {
            notify: (width) =>
              callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver
              ),
            disconnect: vi.fn(),
          };
          observations.push(this.record);
        }
        observe(node: Element) {
          this.record.node = node;
        }
        disconnect() {
          this.record.disconnect();
        }
      }
    );
    try {
      useChatStore.setState({ sessions: { "test-session": createSession() } });
      const { container } = render(<ChatWindow sessionId="test-session" />);
      const original = container.querySelector(".chat-with-changes")!;
      const retired = observations.find((o) => o.node === original)!;
      act(() => retired.notify(320));
      act(() =>
        useChatStore.getState().setSessionAssociation("test-session", {
          ticketId: null,
          ticketTitle: null,
          worktreePath: "/worktree",
          branch: "feature",
          lastProcessedAt: null,
          processedAtCount: 0,
          awaitingWorktree: null,
          recentWorktrees: [],
        })
      );
      const replacement = container.querySelector(".chat-with-changes")!;
      expect(replacement).not.toBe(original);
      expect(retired.disconnect).toHaveBeenCalledOnce();
      const current = observations.find((o) => o.node === replacement)!;
      expect(current).toBeDefined();
      act(() => current.notify(1400));
      act(() => retired.notify(0));
      firePaneControl("Changes");
      let handle = await screen.findByRole("separator", {
        name: "Resize side column",
      });
      expect(handle).toHaveAttribute("aria-valuenow", "560");
      fireEvent.keyDown(handle, { key: "End" });
      expect(handle).toHaveAttribute("aria-valuenow", "1218");
      firePaneControl("Changes");
      expect(
        screen.queryByRole("separator", { name: "Resize side column" })
      ).toBeNull();
      firePaneControl("Changes");
      handle = await screen.findByRole("separator", {
        name: "Resize side column",
      });
      expect(handle).toHaveAttribute("aria-valuenow", "1218");
      act(() => current.notify(1150));
      expect(handle).toHaveAttribute("aria-valuenow", "968");
      // Changes never replaces the transcript: narrower than 1100px it stays
      // beside the conversation (the chat expands for it).
      act(() => current.notify(900));
      expect(container.querySelector(".chat-with-changes")).toHaveAttribute(
        "data-side-placement",
        "beside"
      );
      expect(
        screen.getByRole("separator", { name: "Resize side column" })
      ).toBeInTheDocument();
      act(() => current.notify(1600));
      handle = screen.getByRole("separator", { name: "Resize side column" });
      expect(handle).toHaveAttribute("aria-valuenow", "1218");
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(handle).toHaveAttribute("aria-valuenow", "1228");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps main requests on their selected model when inline discussions have a dedicated provider", async () => {
    const uiState = useUIStore.getState();
    const dedicatedPreference = {
      mode: "dedicated" as const,
      providerId: "custom",
      modelId: "dedicated",
    };
    const mainSession = createSession({
      providerId: "anthropic",
      selectedModelId: "opus",
    });

    uiState.setInlineDiscussionPreference(dedicatedPreference);
    useChatStore.setState({ sessions: { "test-session": mainSession } });
    render(<ChatWindow sessionId="test-session" />);

    await waitFor(() => {
      const modelPicker = getComposerPicker("local-chat-model-picker");

      expect(modelPicker).toHaveAttribute("data-value", "opus");
    });

    const composer = screen.getByTestId("local-chat-composer");
    const startButton = screen.getByTitle("Start session");

    fireEvent.change(composer, { target: { value: "Main question" } });
    fireEvent.click(startButton);

    const mainRequest = expect.objectContaining({
      harness: "claude",
      model_id: "opus",
      initial_prompt: "Main question",
    });

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        mainRequest
      );
    });

    const currentSession = useChatStore.getState().sessions["test-session"];
    const currentPreference = useUIStore.getState().inlineDiscussionPreference;

    expect(currentSession.providerId).toBe("anthropic");
    expect(currentPreference).toEqual(dedicatedPreference);
  });

  it("opens changes on demand and preserves the composer and transcript nodes", async () => {
    const association = {
      ticketId: null,
      ticketTitle: null,
      worktreePath: "/worktree",
      branch: "feature",
      lastProcessedAt: null,
      processedAtCount: 0,
      awaitingWorktree: null,
      recentWorktrees: [],
    };
    useChatStore.setState({
      sessions: { "test-session": createSession({ association }) },
    });
    const { container } = render(<ChatWindow sessionId="test-session" />);
    expect(mockedCommands.loadWorktreeChanges).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Chat view" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull();

    const composer = screen.getByTestId("local-chat-composer");

    fireEvent.change(composer, { target: { value: "keep this draft" } });
    const conversation = screen.getByTestId("chat-messages-scroll");

    Object.defineProperties(conversation, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 500 },
    });

    // Establish the bottom before deliberately scrolling into earlier history.
    conversation.scrollTop = 500;
    fireEvent.scroll(conversation);

    fireEvent.wheel(conversation, { deltaY: -100 });
    conversation.scrollTop = 123;
    fireEvent.scroll(conversation);

    firePaneControl("Changes");
    await screen.findByText("No changes against this baseline.");

    const changes = screen.getByRole("region", { name: "Worktree changes" });
    composer.focus();
    expect(fireEvent.keyDown(composer, { key: "b" })).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(changes).toHaveAttribute("data-chat-area", "changes");

    expect(composer).toBeVisible();
    expect(container.querySelector(".selection-discussions")).toBeNull();

    firePaneControl("Changes");

    expect(screen.getByTestId("local-chat-composer")).toBe(composer);
    expect(composer).toHaveValue("keep this draft");
    expect(conversation.scrollTop).toBe(123);
    expect(container.contains(conversation)).toBe(true);
    act(() =>
      useChatStore.getState().setSessionAssociation("test-session", {
        ...association,
        worktreePath: "/new-worktree",
      })
    );
    firePaneControl("Changes");
    await waitFor(() =>
      expect(mockedCommands.loadWorktreeChanges).toHaveBeenLastCalledWith(
        "/new-worktree",
        { base: null, target: { kind: "working_tree" }, merge_base: true }
      )
    );
  });

  it("asks before leaving Changes with unsaved documents", async () => {
    const association = {
      ticketId: null,
      ticketTitle: null,
      worktreePath: "/dirty-worktree",
      branch: "feature",
      lastProcessedAt: null,
      processedAtCount: 0,
      awaitingWorktree: null,
      recentWorktrees: [],
    };
    useChatStore.setState({
      sessions: { "test-session": createSession({ association }) },
    });
    render(<ChatWindow sessionId="test-session" />);
    firePaneControl("Changes");
    await screen.findByText("No changes against this baseline.");
    act(() =>
      useDocumentStore.setState({
        workspaces: {
          "/dirty-worktree": {
            order: ["a.txt"],
            active: "a.txt",
            documents: {
              "a.txt": {
                path: "a.txt",
                disk: { kind: "text", contents: "disk", revision: "r1" },
                draft: "draft",
                seed: 0,
                view: "file",
                baseline: null,
                conflict: null,
                saving: false,
                saveError: null,
                loadToken: 1,
              },
            },
          },
        },
      })
    );
    firePaneControl("Changes");

    const dialog = await screen.findByRole("dialog", {
      name: "Unsaved changes",
    });

    expect(dialog).toHaveTextContent("a.txt has unsaved changes.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    firePaneControl("Changes");
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));

    // Closed Changes returns to the overflow menu.
    expect(screen.queryByTestId("local-chat-view-changes")).toBeNull();
    expect(
      useDocumentStore.getState().workspaces["/dirty-worktree"]?.documents[
        "a.txt"
      ]
    ).toBeUndefined();
  });

  it("hides the changes toggle without an associated worktree", () => {
    useChatStore.setState({ sessions: { "test-session": createSession() } });
    render(<ChatWindow sessionId="test-session" />);

    expect(hasPaneControl("Changes")).toBe(false);
  });

  it("opens running background tasks in the side panel in place of Changes", async () => {
    const backgroundWork = applyBackgroundUpdate(
      EMPTY_BACKGROUND_WORK,
      {
        eventId: "e1",
        workId: "dev",
        generation: 0,
        kind: "command",
        providerKind: null,
        status: "running",
        description: "npm run dev",
        progress: null,
        launchToolId: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        observedAt: "2026-11-13T12:00:00Z",
        turnId: null,
        threadId: null,
      },
      { live: true }
    ).state;
    const association = {
      ticketId: null,
      ticketTitle: null,
      worktreePath: "/worktree",
      branch: "feature",
      lastProcessedAt: null,
      processedAtCount: 0,
      awaitingWorktree: null,
      recentWorktrees: [],
    };
    useChatStore.setState({
      sessions: {
        "test-session": createSession({ association, backgroundWork }),
      },
    });

    render(<ChatWindow sessionId="test-session" />);
    const toggle = screen.getByRole("button", {
      name: "Background tasks, 1 running",
    });

    expect(
      screen.queryByRole("complementary", { name: "Side column" })
    ).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const column = screen.getByRole("complementary", { name: "Side column" });
    expect(
      within(column).getByRole("tab", { name: /Background tasks/ })
    ).toHaveAttribute("aria-selected", "true");
    expect(column).toHaveTextContent("npm run dev");
    expect(screen.getByTestId("local-chat-composer")).toBeVisible();

    // One column per chat: Changes takes the same slot.
    firePaneControl("Changes");
    await screen.findByText("No changes against this baseline.");
    expect(
      within(
        screen.getByRole("complementary", { name: "Side column" })
      ).getByRole("tab", { name: /Changes/ })
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("npm run dev")).toBeNull();
    // With the column open the switcher carries the other sections; the
    // header keeps two to three actions.
    expect(toggle).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Background tasks/ }));

    expect(
      screen.getByRole("complementary", { name: "Side column" })
    ).toHaveTextContent("npm run dev");
    expect(screen.queryByText("No changes against this baseline.")).toBeNull();
  });

  it("hides the background toggle when no background work was reported", () => {
    useChatStore.setState({ sessions: { "test-session": createSession() } });
    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByTestId("local-chat-view-background")).toBeNull();
  });

  it("returns null when session does not exist", () => {
    const { container } = render(<ChatWindow sessionId="non-existent" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the session label as the header title without entity copy", () => {
    const session = createSession({ label: "My Task" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("My Task")).toBeInTheDocument();
    expect(screen.queryByText("local to")).not.toBeInTheDocument();
    expect(screen.queryByText("this task")).not.toBeInTheDocument();
  });

  it("exposes the active session project path for GUI acceptance assertions", () => {
    const session = createSession({ projectPath: "/selected/project" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTestId("local-chat-window")).toHaveAttribute(
      "data-project-path",
      "/selected/project"
    );
  });

  it("renders the project label from the session's captured path", () => {
    const session = createSession({
      label: "Captured project chat",
      projectPath: "/persisted/project-alpha",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" showProjectContext />);

    expect(screen.getByTestId("local-chat-project-context")).toHaveTextContent(
      "project-alpha"
    );
    expect(
      screen.getByRole("button", { name: /Rename chat/ })
    ).toBeInTheDocument();
  });

  it("renders the inferred session title in the header", () => {
    const session = createSession({
      label: "New Chat",
      title: "Simple PR Review",
      titleStatus: "generated",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Simple PR Review")).toBeInTheDocument();
    expect(screen.queryByText("New Chat")).not.toBeInTheDocument();
  });

  it("regenerates the title in the current pane and persists the session index", async () => {
    const user = userEvent.setup();
    const session = createSession({
      title: "Old Generated Title",
      titleStatus: "generated",
      projectPath: "/test/project",
      messages: [
        {
          kind: "user",
          text: "Regenerate this title from the complete conversation",
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          kind: "assistant",
          text: "I will use the shared inference command.",
          timestamp: "2026-01-01T00:00:01Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await clickPaneControl(user, "Regenerate chat title");

    await waitFor(() => {
      expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith({
        harness: "claude",
        initial_prompts: [
          "User: Regenerate this title from the complete conversation",
          "Assistant: I will use the shared inference command.",
        ],
        working_dir: "/test/project",
      });
      expect(useChatStore.getState().sessions["test-session"].title).toBe(
        "Inferred Title"
      );
    });

    expect(screen.getByText("Inferred Title")).toBeInTheDocument();
    expect(loadPersistedLocalChatSession("test-session")).toMatchObject({
      title: "Inferred Title",
      titleStatus: "generated",
      titleConfidence: 0.91,
    });
  });

  it("saves a normalized manual title and protects it from regeneration", async () => {
    const user = userEvent.setup();
    const session = createSession({
      title: "Generated Title",
      titleStatus: "generated",
      messages: [
        {
          kind: "user",
          text: "Keep this conversation title",
          timestamp: "2026-01-01T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.click(
      screen.getByRole("button", { name: "Rename chat: Generated Title" })
    );
    const input = screen.getByRole("textbox", { name: "Chat title" });
    await user.clear(input);
    await user.type(input, "  Manual   conversation title  ");
    await user.click(screen.getByRole("button", { name: "Save chat title" }));

    await waitFor(() => {
      expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
        title: "Manual conversation title",
        titleStatus: "manual",
        titleConfidence: null,
      });
    });
    expect(loadPersistedLocalChatSession("test-session")).toMatchObject({
      title: "Manual conversation title",
      titleStatus: "manual",
    });

    await clickPaneControl(user, "Regenerate chat title");
    expect(mockedCommands.inferLocalChatSessionTitle).not.toHaveBeenCalled();
    expect(screen.getByText("Manual conversation title")).toBeInTheDocument();
  });

  it.each(["claude", "codex"] as const)(
    "supports regenerate, cancel, and rename controls for %s sessions",
    async (harness) => {
      const user = userEvent.setup();
      if (harness === "codex") mockAvailableCodexHarness();
      const session = createSession({
        harness,
        title: `Generated ${harness} title`,
        titleStatus: "generated",
        messages: [
          {
            kind: "user",
            text: `Summarize the ${harness} session`,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
        panelOpen: true,
      });

      render(<ChatWindow sessionId="test-session" />);

      await clickPaneControl(user, "Regenerate chat title");
      await waitFor(() => {
        expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith(
          expect.objectContaining({ harness })
        );
        expect(useChatStore.getState().sessions["test-session"].title).toBe(
          "Inferred Title"
        );
      });

      await user.click(
        screen.getByRole("button", { name: "Rename chat: Inferred Title" })
      );
      const input = screen.getByRole("textbox", { name: "Chat title" });
      await user.clear(input);
      await user.type(input, "Canceled title");
      await user.click(
        screen.getByRole("button", { name: "Cancel chat title edit" })
      );
      expect(screen.getByText("Inferred Title")).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Rename chat: Inferred Title" })
      );
      await user.clear(screen.getByRole("textbox", { name: "Chat title" }));
      await user.type(
        screen.getByRole("textbox", { name: "Chat title" }),
        "Manual title"
      );
      await user.click(screen.getByRole("button", { name: "Save chat title" }));

      await waitFor(() => {
        expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
          title: "Manual title",
          titleStatus: "manual",
        });
      });
      expect(loadPersistedLocalChatSession("test-session")).toMatchObject({
        title: "Manual title",
        titleStatus: "manual",
      });
    }
  );

  it.each(["claude", "codex"] as const)(
    "keeps an existing title after failed or low-confidence %s inference",
    async (harness) => {
      const user = userEvent.setup();
      if (harness === "codex") mockAvailableCodexHarness();
      const session = createSession({
        harness,
        title: "Existing Usable Title",
        titleStatus: "generated",
        messages: [
          {
            kind: "user",
            text: "Keep the existing title if inference fails",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ],
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
        panelOpen: true,
      });

      mockedCommands.inferLocalChatSessionTitle.mockResolvedValueOnce({
        status: "ok",
        data: {
          title: null,
          confidence: 0.2,
          sufficient_signal: false,
        },
      });
      render(<ChatWindow sessionId="test-session" />);
      await clickPaneControl(user, "Regenerate chat title");
      await waitFor(() => {
        expect(mockedCommands.inferLocalChatSessionTitle).toHaveBeenCalledWith(
          expect.objectContaining({ harness })
        );
      });
      expect(screen.getByText("Existing Usable Title")).toBeInTheDocument();
      expect(useChatStore.getState().sessions["test-session"].title).toBe(
        "Existing Usable Title"
      );

      mockedCommands.inferLocalChatSessionTitle.mockResolvedValueOnce({
        status: "error",
        error: { message: "provider unavailable" },
      });
      await clickPaneControl(user, "Regenerate chat title");
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "provider unavailable"
        );
      });
      expect(screen.getByText("Existing Usable Title")).toBeInTheDocument();
    }
  );

  it("does not render old entity copy", () => {
    const session = createSession({
      label: "Deploy Pipeline",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Deploy Pipeline")).toBeInTheDocument();
    expect(screen.queryByText("this workflow")).not.toBeInTheDocument();
    expect(screen.queryByText("wf-1")).not.toBeInTheDocument();
  });

  it("omits the context ring before usage lands", () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByTestId("chat-context-ring")).not.toBeInTheDocument();
  });

  it("keeps workspace controls off the chat header (they live on the tab strip)", async () => {
    const user = userEvent.setup();
    const onClosePanel = vi.fn();
    const session = createSession({ label: "New Chat" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" onClosePanel={onClosePanel} />);

    for (const name of [
      /Widen chat panel/,
      /Collapse chat panel/,
      /Split chat pane/,
      /Keep only this pane/,
      /Close this pane/,
      /Toggle chat history/,
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "Close chat panel" }));
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("shows empty state message when no messages", () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByText("Create, edit, and delete tasks, steps, and workflows")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Or run a task through a workflow")
    ).toBeInTheDocument();
  });

  it("renders user messages from store", () => {
    const session = createSession({
      messages: [
        {
          kind: "user",
          text: "Hello from store",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Hello from store")).toBeInTheDocument();
  });

  it("renders assistant messages from store", () => {
    const session = createSession({
      messages: [
        {
          kind: "assistant",
          text: "I can help with that!",
          timestamp: "2024-01-01T12:00:00Z",
          isPartial: false,
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("I can help with that!")).toBeInTheDocument();
  });

  it("renders error messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "error",
          message: "Connection failed",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Connection failed")).toBeInTheDocument();
  });

  it("renders tool call messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: '{"file_path": "/test.ts"}',
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByRole("button", { name: /1 call for/ })
    ).toBeInTheDocument();
    // Input is hidden until the block is expanded.
    expect(screen.queryByText('{"file_path": "/test.ts"}')).toBeNull();
  });

  it("does not render stored context summaries", () => {
    const session = createSession({});
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByText("Context injected")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Task: My Important Task")
    ).not.toBeInTheDocument();
  });

  it("has clear messages button", () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(getPaneControl("Clear messages")).toBeInTheDocument();
  });

  it("refreshes model choices after provider settings are saved before a session starts", async () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);
    const picker = await findComposerPicker("local-chat-model-picker");

    expect(
      dropdownOptions(picker)
        .map((option) => option.label)
        .join(" ")
    ).toContain("Sonnet");

    const latest = withBuiltinProviders({
      default_harness: "claude",
      harnesses: [
        {
          harness: "claude",
          label: "Claude",
          available: true,
          unavailable_reason: null,
          default_model_id: "new-model",
          default_reasoning_effort: null,
          reasoning_efforts: [],
          supports_resume: true,
          models: [{ id: "new-model", label: "New model" }],
        },
      ],
    });
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: latest,
    });
    act(() => useProviderSettingsStore.getState().changed());
    await waitFor(() =>
      expect(
        dropdownOptions(getComposerPicker("local-chat-model-picker")).map(
          (option) => option.label
        )
      ).toContain("New model (default)")
    );
  });

  it("keeps an active session's model catalog when provider settings change", async () => {
    const session = createSession({
      backendSessionId: "active-backend",
      selectedModelId: "sonnet",
      lifecycle: "idle",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);
    const picker = await findComposerPicker("local-chat-model-picker");
    expect(picker).toHaveTextContent("Sonnet");
    const calls =
      mockedCommands.getSupportedLocalChatHarnesses.mock.calls.length;
    act(() => useProviderSettingsStore.getState().changed());
    expect(mockedCommands.getSupportedLocalChatHarnesses).toHaveBeenCalledTimes(
      calls
    );
    expect(picker).toHaveTextContent("Sonnet");
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBe("sonnet");
  });

  it("renders the Claude model picker without forcing a model for a new session", async () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const picker = await findComposerPicker("local-chat-model-picker");
    expect(picker).toHaveAttribute("data-value", "");
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBeUndefined();
  });

  it("omits unavailable Codex from the provider picker", async () => {
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: withBuiltinProviders({
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              {
                id: "sonnet",
                label: "Sonnet",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: false,
            unavailable_reason: "Codex CLI not found",
            default_model_id: null,
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
        ],
      }),
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const providerPicker = await findComposerPicker(
      "local-chat-provider-picker"
    );

    expect(providerPicker).toHaveAttribute("data-value", "anthropic");
    expect(
      dropdownOptions(providerPicker).map((option) => option.value)
    ).toEqual(["anthropic"]);
  });

  it("falls back to Codex when Claude is unavailable before starting", async () => {
    const user = userEvent.setup();
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: withBuiltinProviders({
        default_harness: "codex",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: false,
            unavailable_reason: "Claude CLI not found",
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
          {
            harness: "codex",
            label: "Codex",
            available: true,
            unavailable_reason: null,
            default_model_id: "default",
            default_reasoning_effort: "medium",
            reasoning_efforts: [{ id: "medium", label: "Medium" }],
            supports_resume: true,
            models: [
              {
                id: "default",
                label: "Default",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
        ],
      }),
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const providerPicker = await findComposerPicker(
      "local-chat-provider-picker"
    );

    await waitFor(() => {
      expect(useChatStore.getState().sessions["test-session"].harness).toBe(
        "codex"
      );
    });
    expect(providerPicker).toHaveAttribute("data-value", "openai");
    expect(
      dropdownOptions(providerPicker).map((option) => option.value)
    ).toEqual(["openai"]);

    await user.type(screen.getByTestId("local-chat-composer"), "Start Codex");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: "codex",
          initial_prompt: "Start Codex",
        })
      );
    });
  });

  it("starts the selected named ACP connection", async () => {
    const user = userEvent.setup();
    const ids = ["local:acp:one", "local:acp:two"];
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: {
        default_harness: "acp",
        default_provider: ids[0],
        harnesses: [{
          harness: "acp",
          label: "ACP agent",
          available: true,
          unavailable_reason: null,
          default_model_id: null,
          default_reasoning_effort: null,
          reasoning_efforts: [],
          supports_resume: false,
          models: [],
          permission_modes: [],
        }],
        providers: ids.map((id, index) => ({
          id,
          label: index === 0 ? "First connection" : "Second connection",
          harness: "acp",
          custom: true,
          available: true,
          unavailable_reason: null,
          models: null,
          default_model_id: null,
          discovered: {
            harness: "acp",
            label: "ACP connection",
            available: true,
            unavailable_reason: null,
            supports_resume: false,
            default_model_id: "native-model",
            models: [{ id: "native-model", label: "Native model" }],
            default_reasoning_effort: "low",
            reasoning_efforts: [{ id: "low", label: "Low" }],
            permission_modes: [],
          },
        })),
      },
    });
    useChatStore.setState({
      sessions: { "test-session": createSession({ harness: "acp", providerId: ids[0] }) },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);
    chooseDropdownValue(await findComposerPicker("local-chat-provider-picker"), ids[1]);
    chooseDropdownValue(await findComposerPicker("local-chat-model-picker"), "native-model");
    chooseDropdownValue(await findComposerPicker("local-chat-effort-picker"), "low");
    await user.type(screen.getByTestId("local-chat-composer"), "Hello{Enter}");
    await waitFor(() =>
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({ harness: "acp", provider_id: ids[1], initial_prompt: "Hello", model_id: "native-model", reasoning_effort: "low" })
      )
    );
  });

  it("selects Codex provider models from the catalog and starts with neutral commands", async () => {
    const user = userEvent.setup();
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: withBuiltinProviders({
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              {
                id: "sonnet",
                label: "Sonnet",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: true,
            unavailable_reason: null,
            default_model_id: "catalog-codex-default",
            default_reasoning_effort: "medium",
            reasoning_efforts: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
            supports_resume: true,
            models: [
              {
                id: "catalog-codex-default",
                label: "Catalog Default",
                supported_reasoning_effort_ids: null,
              },
              {
                id: "catalog-codex-alt",
                label: "Catalog Alt",
                supported_reasoning_effort_ids: ["medium"],
              },
            ],
          },
        ],
      }),
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    chooseDropdownValue(
      await findComposerPicker("local-chat-provider-picker"),
      "openai"
    );

    await waitFor(() => {
      expect(useChatStore.getState().sessions["test-session"].harness).toBe(
        "codex"
      );
    });

    chooseDropdownValue(
      await findComposerPicker("local-chat-effort-picker"),
      "high"
    );
    chooseDropdownValue(
      await findComposerPicker("local-chat-model-picker"),
      "catalog-codex-alt"
    );

    await waitFor(() => {
      expect(
        useChatStore.getState().sessions["test-session"].selectedReasoningEffort
      ).toBeNull();
    });
    expect(
      dropdownOptionValues(getComposerPicker("local-chat-effort-picker"))
    ).toEqual(["", "medium"]);

    chooseDropdownValue(
      getComposerPicker("local-chat-effort-picker"),
      "medium"
    );

    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        chat_session_id: expect.any(String),
        recording_worktree: null,
        recording_branch: null,
        harness: "codex",
        working_dir: "/test/project",
        initial_prompt: "Start",
        provider_resume_id: null,
        model_id: "catalog-codex-alt",
        reasoning_effort: "medium",
        personality: null,
        permission_mode: "default",
      });
    });
  });

  it("starts a custom provider on its configured harness with only its models", async () => {
    const user = userEvent.setup();
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: withBuiltinProviders(
        {
          default_harness: "claude",
          harnesses: [
            {
              harness: "claude",
              label: "Claude",
              available: true,
              unavailable_reason: null,
              default_model_id: "sonnet",
              default_reasoning_effort: null,
              reasoning_efforts: [],
              supports_resume: true,
              models: [
                { id: "sonnet", label: "Sonnet" },
                { id: "opus", label: "Opus" },
              ],
            },
          ],
        },
        [
          {
            id: "openrouter",
            label: "openrouter",
            harness: "claude",
            custom: true,
            available: true,
            unavailable_reason: null,
            models: [
              { id: "moonshotai/kimi-k2", label: "moonshotai/kimi-k2" },
              { id: "z-ai/glm-5", label: "z-ai/glm-5" },
            ],
            default_model_id: "z-ai/glm-5",
          },
        ]
      ),
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    chooseDropdownValue(
      await findComposerPicker("local-chat-provider-picker"),
      "openrouter"
    );

    await waitFor(() => {
      const updated = useChatStore.getState().sessions["test-session"];
      expect(updated.providerId).toBe("openrouter");
      expect(updated.harness).toBe("claude");
    });
    expect(
      dropdownOptionValues(getComposerPicker("local-chat-model-picker"))
    ).toEqual(["", "moonshotai/kimi-k2", "z-ai/glm-5"]);

    chooseDropdownValue(
      getComposerPicker("local-chat-model-picker"),
      "moonshotai/kimi-k2"
    );

    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          harness: "claude",
          provider_id: "openrouter",
          model_id: "moonshotai/kimi-k2",
        })
      );
    });
  });

  it("renders model and permission controls in the composer footer", async () => {
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const modelPicker = await findComposerPicker("local-chat-model-picker");
    const permissionPicker = screen.getByTestId(
      "local-chat-permission-mode-picker"
    );

    expect(modelPicker.closest(".hc-foot")).not.toBeNull();
    expect(permissionPicker.closest(".hc-foot")).not.toBeNull();
    expect(
      (await findComposerPicker("local-chat-provider-picker")).closest(
        ".hc-foot"
      )
    ).not.toBeNull();
    expect(
      document.querySelector(".hc-head [data-testid='local-chat-model-picker']")
    ).toBeNull();
    expect(permissionPicker).toHaveAttribute("data-value", "default");
    expect(
      dropdownOptions(permissionPicker).map((option) => [
        option.label,
        option.value,
      ])
    ).toEqual([
      ["Ask before edits", "default"],
      ["Edit automatically", "accept_edits"],
      ["Plan mode", "plan"],
      ["Auto mode", "auto"],
      ["Don't ask", "dont_ask"],
      ["Bypass permissions", "bypass_permissions"],
    ]);
  });

  it("keeps a locked session on an unavailable Codex harness", async () => {
    const user = userEvent.setup();
    const session = createSession({
      harness: "codex",
      providerResumeId: "codex-resume-1",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      await screen.findByTestId("local-chat-provider-unavailable")
    ).toHaveTextContent("This chat session's harness is no longer available.");
    // Locked to its unavailable harness: the picker keeps that value and
    // cannot be changed.
    const lockedPicker = getComposerPicker("local-chat-provider-picker");
    expect(lockedPicker).toBeDisabled();
    expect(lockedPicker.getAttribute("data-value")).not.toBe("anthropic");
    expect(useChatStore.getState().sessions["test-session"].harness).toBe(
      "codex"
    );
    expect(getComposerPicker("local-chat-model-picker")).toBeDisabled();
    expect(screen.getByTestId("local-chat-composer")).toBeEnabled();

    await user.type(screen.getByTestId("local-chat-composer"), "Start Codex");

    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
  });

  it("blocks local chat and shows the neither-installed message", async () => {
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: withBuiltinProviders({
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: false,
            unavailable_reason: "Claude CLI not found",
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
          {
            harness: "codex",
            label: "Codex",
            available: false,
            unavailable_reason: "Codex CLI not found",
            default_model_id: null,
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
        ],
      }),
    });
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const providerPicker = await findComposerPicker(
      "local-chat-provider-picker"
    );

    expect(dropdownOptions(providerPicker)).toHaveLength(0);
    expect(
      await screen.findByTestId("local-chat-provider-unavailable")
    ).toHaveTextContent(
      "No local chat provider is available. Check Settings → Providers & Models."
    );
    expect(screen.getByTestId("local-chat-composer")).toBeEnabled();
    expect(screen.getByTitle("Start session")).toBeDisabled();
    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
  });

  it("locks the provider of persisted Codex sessions and resumes with the selected model", async () => {
    const user = userEvent.setup();
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: withBuiltinProviders({
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              {
                id: "sonnet",
                label: "Sonnet",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: true,
            unavailable_reason: null,
            default_model_id: "catalog-codex-default",
            default_reasoning_effort: "medium",
            reasoning_efforts: [{ id: "medium", label: "Medium" }],
            supports_resume: true,
            models: [
              {
                id: "catalog-codex-default",
                label: "Catalog Default",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
        ],
      }),
    });
    const session = createSession({
      harness: "codex",
      providerResumeId: "codex-resume-1",
      selectedModelId: "catalog-codex-default",
      selectedReasoningEffort: "medium",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      await findComposerPicker("local-chat-provider-picker")
    ).toBeDisabled();
    expect(getComposerPicker("local-chat-model-picker")).toBeEnabled();

    await user.type(screen.getByTestId("local-chat-composer"), "Resume Codex");
    await user.click(screen.getByTitle("Resume session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        chat_session_id: expect.any(String),
        recording_worktree: null,
        recording_branch: null,
        harness: "codex",
        working_dir: "/test/project",
        initial_prompt: "Resume Codex",
        provider_resume_id: "codex-resume-1",
        model_id: "catalog-codex-default",
        reasoning_effort: "medium",
        personality: null,
        permission_mode: "default",
      });
    });
  });

  it("persists selected model changes and sends the model when starting", async () => {
    const user = userEvent.setup();
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    chooseDropdownValue(
      await findComposerPicker("local-chat-model-picker"),
      "opus"
    );

    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        chat_session_id: expect.any(String),
        recording_worktree: null,
        recording_branch: null,
        harness: "claude",
        working_dir: "/test/project",
        initial_prompt: "Start",
        provider_resume_id: null,
        model_id: "opus",
        reasoning_effort: null,
        personality: null,
        permission_mode: "default",
      });
    });
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBe("opus");
  });

  it("sends the selected permission mode when starting", async () => {
    const user = userEvent.setup();
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    chooseDropdownValue(
      screen.getByTestId("local-chat-permission-mode-picker"),
      "plan"
    );
    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        chat_session_id: expect.any(String),
        recording_worktree: null,
        recording_branch: null,
        harness: "claude",
        working_dir: "/test/project",
        initial_prompt: "Start",
        provider_resume_id: null,
        model_id: null,
        reasoning_effort: null,
        personality: null,
        permission_mode: "plan",
      });
    });
    expect(
      useChatStore.getState().sessions["test-session"].permissionMode
    ).toBe("plan");
  });

  it("keeps model and permission pickers enabled while active or busy", async () => {
    const activeSession = createSession({
      backendSessionId: "claude-active",
    });
    useChatStore.setState({
      sessions: { "test-session": activeSession },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    const { rerender } = render(<ChatWindow sessionId="test-session" />);

    expect(await findComposerPicker("local-chat-model-picker")).toBeEnabled();
    expect(
      screen.getByTestId("local-chat-permission-mode-picker")
    ).toBeEnabled();

    act(() => {
      useChatStore.setState({
        sessions: {
          "test-session": createSession({ lifecycle: "sending" }),
        },
        activeSessionId: "test-session",
        panelOpen: true,
      });
    });
    rerender(<ChatWindow sessionId="test-session" />);

    expect(await findComposerPicker("local-chat-model-picker")).toBeEnabled();
    expect(
      screen.getByTestId("local-chat-permission-mode-picker")
    ).toBeEnabled();
  });

  it("can clear a selected model back to CLI default before starting", async () => {
    const user = userEvent.setup();
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    chooseDropdownValue(
      await findComposerPicker("local-chat-model-picker"),
      "opus"
    );

    expect(localStorage.getItem("local-chat-model:last-used:v1")).toBe("opus");

    chooseDropdownValue(
      await findComposerPicker("local-chat-model-picker"),
      ""
    );

    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));

    await waitFor(() => {
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith({
        backend_session_id: expect.any(String),
        chat_session_id: expect.any(String),
        recording_worktree: null,
        recording_branch: null,
        harness: "claude",
        working_dir: "/test/project",
        initial_prompt: "Start",
        provider_resume_id: null,
        model_id: null,
        reasoning_effort: null,
        personality: null,
        permission_mode: "default",
      });
    });
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBeNull();
    expect(localStorage.getItem("local-chat-model:last-used:v1")).toBeNull();
  });

  it("sends the exact versioned Fable choice to session creation", async () => {
    const ids = [
      "claude-fable-5-2",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ];
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: withBuiltinProviders({
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "claude-sonnet-5-5",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: ids.map((id) => ({ id, label: id })),
          },
        ],
      }),
    });
    useChatStore.setState({
      sessions: { "test-session": createSession() },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    const user = userEvent.setup();
    render(<ChatWindow sessionId="test-session" />);
    const picker = await findComposerPicker("local-chat-model-picker");
    expect(dropdownOptionValues(picker)).toEqual(["", ...ids]);
    chooseDropdownValue(picker, "claude-fable-5-2");
    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    await user.click(screen.getByTitle("Start session"));
    await waitFor(() =>
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({ model_id: "claude-fable-5-2" })
      )
    );
  });

  it("requires an explicit reset of an obsolete saved model for a new chat", async () => {
    useLocalChatDefaultsStore
      .getState()
      .setModelDefault("anthropic", "claude-opus-4-8");
    localStorage.setItem("local-chat-model:last-used:v1", "haiku");
    useChatStore.setState({
      sessions: { "test-session": createSession() },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    const user = userEvent.setup();
    render(<ChatWindow sessionId="test-session" />);
    const picker = await findComposerPicker("local-chat-model-picker");

    await waitFor(() =>
      expect(picker).toHaveAttribute("data-value", "claude-opus-4-8")
    );

    expect(picker).toHaveTextContent("Unsupported: claude-opus-4-8");
    await user.type(screen.getByTestId("local-chat-composer"), "Start");
    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
    expect(screen.getByTitle("Start session")).toBeDisabled();
    chooseDropdownValue(getComposerPicker("local-chat-model-picker"), "opus");
    await user.click(screen.getByTitle("Start session"));
    await waitFor(() =>
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({ model_id: "opus" })
      )
    );
  });

  it("uses the last selected model as the default for a new session", async () => {
    localStorage.setItem("local-chat-model:last-used:v1", "haiku");
    const session = createSession();
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const picker = await findComposerPicker("local-chat-model-picker");
    await waitFor(() => {
      expect(picker).toHaveAttribute("data-value", "haiku");
    });
  });

  it("does not assign a default model to old resumable sessions without a saved choice", async () => {
    const session = createSession({ providerResumeId: "conv-existing" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(await findComposerPicker("local-chat-model-picker")).toHaveAttribute(
      "data-value",
      ""
    );
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBeUndefined();
  });

  it("preserves unsupported saved model ids so backend fallback can warn", async () => {
    const session = createSession({ selectedModelId: "claude-retired" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await findComposerPicker("local-chat-model-picker");
    expect(
      useChatStore.getState().sessions["test-session"].selectedModelId
    ).toBe("claude-retired");
  });

  it("clears saved model override when selected harness has no selectable models", async () => {
    mockedCommands.getSupportedLocalChatHarnesses.mockResolvedValueOnce({
      status: "ok",
      data: withBuiltinProviders({
        default_harness: "claude",
        harnesses: [
          {
            harness: "claude",
            label: "Claude",
            available: true,
            unavailable_reason: null,
            default_model_id: "sonnet",
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [
              {
                id: "sonnet",
                label: "Sonnet",
                supported_reasoning_effort_ids: null,
              },
            ],
          },
          {
            harness: "codex",
            label: "Codex",
            available: true,
            unavailable_reason: null,
            default_model_id: null,
            default_reasoning_effort: null,
            reasoning_efforts: [],
            supports_resume: true,
            models: [],
          },
        ],
      }),
    });
    const session = createSession({
      harness: "codex",
      selectedModelId: "stale-catalog-id",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(await findComposerPicker("local-chat-model-picker")).toBeDisabled();
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions["test-session"].selectedModelId
      ).toBeNull();
    });
  });

  it("clears messages when clear button is clicked", async () => {
    const user = userEvent.setup();
    const session = createSession({
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Hello")).toBeInTheDocument();

    await clickPaneControl(user, "Clear messages");

    expect(
      useChatStore.getState().sessions["test-session"].messages
    ).toHaveLength(0);
  });

  it("closes the backend before clearing an active session", async () => {
    const user = userEvent.setup();
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await clickPaneControl(user, "Clear messages");

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "claude-abc"
      );
      expect(
        useChatStore.getState().sessions["test-session"].messages
      ).toHaveLength(0);
    });
  });

  it("keeps an empty active chat open after clearing its backend session", async () => {
    const user = userEvent.setup();
    const session = createSession({
      backendSessionId: "claude-empty",
      lifecycle: "idle",
      messages: [],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await clickPaneControl(user, "Clear messages");

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "claude-empty"
      );
      expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
        messages: [],
        backendSessionId: null,
        lifecycle: "idle",
      });
      expect(useChatStore.getState().panelOpen).toBe(true);
    });
  });

  it("stops an active backend session without clearing messages", async () => {
    const user = userEvent.setup();
    const session = createSession({
      backendSessionId: "codex-active",
      harness: "codex",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-active",
        turnId: "root-turn-active",
        phase: "active",
      },
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.click(screen.getByTestId("local-chat-stop-generation"));

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "codex-active"
      );
      expect(
        useChatStore.getState().sessions["test-session"].messages
      ).toHaveLength(1);
    });
  });

  it("keeps stopping visible and sends only one close request", async () => {
    let resolveClose!: (result: { status: "ok"; data: null }) => void;
    mockedCommands.closeLocalChatSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        })
    );
    const session = createSession({
      backendSessionId: "codex-stopping",
      harness: "codex",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-stopping",
        turnId: "root-turn-stopping",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    const stop = screen.getByTestId("local-chat-stop-generation");
    fireEvent.click(stop);
    fireEvent.click(stop);

    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledTimes(1);
    expect(
      useChatStore.getState().sessions["test-session"].activeTurn
    ).toMatchObject({
      turnId: "root-turn-stopping",
      phase: "stopping",
    });
    expect(stop).toBeDisabled();
    expect(screen.getByText("Stopping...")).toBeInTheDocument();

    await act(async () => resolveClose({ status: "ok", data: null }));
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions["test-session"].activeTurn
      ).toBeNull();
      expect(
        useChatStore.getState().sessions["test-session"].backendSessionId
      ).toBeNull();
    });
  });

  it("keeps Stop disabled when provider acknowledgement races a local stop", async () => {
    let resolveClose!: (result: { status: "ok"; data: null }) => void;
    mockedCommands.closeLocalChatSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        })
    );
    const session = createSession({
      backendSessionId: "codex-stop-before-ack",
      harness: "codex",
      lifecycle: "sending",
      activeTurn: {
        localId: "local-turn-before-ack",
        turnId: null,
        phase: "starting",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    const stop = screen.getByTestId("local-chat-stop-generation");
    fireEvent.click(stop);
    act(() => {
      expect(
        routeLocalChatTurnStartedEvent({
          backend_session_id: "codex-stop-before-ack",
          harness: "codex",
          turn_id: "provider-turn-before-ack",
          thread_id: "provider-thread-before-ack",
          is_root: true,
        })
      ).toBe(true);
    });

    expect(stop).toBeDisabled();
    expect(useChatStore.getState().sessions["test-session"].activeTurn).toEqual(
      {
        localId: "local-turn-before-ack",
        turnId: "provider-turn-before-ack",
        phase: "stopping",
      }
    );
    fireEvent.click(stop);
    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledTimes(1);

    await act(async () => resolveClose({ status: "ok", data: null }));
  });

  it("keeps the composer closed when End arrives before Stop completes", async () => {
    const user = userEvent.setup();
    let resolveClose!: (result: { status: "ok"; data: null }) => void;
    mockedCommands.closeLocalChatSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        })
    );
    const session = createSession({
      backendSessionId: "claude-stop-end-race",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-stop-end-race",
        turnId: "root-turn-stop-end-race",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    fireEvent.click(screen.getByTestId("local-chat-stop-generation"));
    act(() => {
      expect(
        routeLocalChatSessionEndEvent({
          backend_session_id: "claude-stop-end-race",
          harness: "claude",
          turn_id: "root-turn-stop-end-race",
          thread_id: "root-thread-stop-end-race",
          is_root: true,
          duration_ms: 1,
          cost_usd: 0,
          num_turns: 1,
          result: "interrupted",
          is_error: false,
          context_tokens: 0,
          context_window: 200000,
        })
      ).toBe(true);
    });

    const composer = screen.getByTestId("local-chat-composer");
    expect(useChatStore.getState().sessions["test-session"].lifecycle).toBe(
      "closing"
    );
    expect(composer).toBeEnabled();
    await user.type(composer, "must not send{Enter}");
    // Typing is kept as a draft; Enter does not send while closing.
    expect(composer).toHaveValue("must not send");
    expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();

    await act(async () => resolveClose({ status: "ok", data: null }));
    expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
      lifecycle: "idle",
      backendSessionId: null,
    });
  });

  it("shows recovered queue contents and lets the user discard them", async () => {
    const user = userEvent.setup();
    useChatStore.setState({
      sessions: {
        "test-session": createSession({
          harness: "acp",
          providerResumeId: "acp-conversation",
          providerId: "local:acp:test-connection",
          queuedMessages: ["First unsent prompt", "Second unsent prompt"],
          queuePaused: true,
        }),
      },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);
    await user.click(screen.getByText("2 queued · Paused"));
    expect(screen.getByRole("list", { name: "Queued messages" })).toHaveTextContent(
      "First unsent prompt"
    );
    expect(screen.getByRole("button", { name: "Resume queue" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Discard queue" }));
    expect(screen.queryByText("2 queued · Paused")).not.toBeInTheDocument();
    expect(useChatStore.getState().sessions["test-session"].queuePaused).toBe(false);
  });

  it("stops ACP generation and sends the follow-up to the same backend", async () => {
    const user = userEvent.setup();
    const session = createSession({
      harness: "acp",
      backendSessionId: "acp-stop",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn",
        turnId: "acp-turn",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    await user.click(screen.getByTestId("local-chat-stop-generation"));
    expect(mockedCommands.interruptLocalChatTurn).toHaveBeenCalledWith(
      "acp-stop"
    );
    expect(mockedCommands.closeLocalChatSession).not.toHaveBeenCalled();

    act(() => {
      expect(
        routeLocalChatSessionEndEvent({
          backend_session_id: "acp-stop",
          harness: "acp",
          turn_id: "acp-turn",
          thread_id: "acp-stop",
          is_root: true,
          duration_ms: 1,
          cost_usd: 0,
          num_turns: 1,
          result: "",
          is_error: true,
          completion_status: "interrupted",
          context_tokens: 0,
          context_window: 0,
        })
      ).toBe(true);
    });

    await user.type(
      screen.getByTestId("local-chat-composer"),
      "Follow up{Enter}"
    );
    await waitFor(() =>
      expect(mockedCommands.sendLocalChatMessage).toHaveBeenCalledWith(
        "acp-stop",
        "Follow up",
        expect.anything()
      )
    );
    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
  });

  it("disables Stop while a clear is already closing the session", async () => {
    const user = userEvent.setup();
    let resolveClose!: (result: { status: "ok"; data: null }) => void;
    mockedCommands.closeLocalChatSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClose = resolve;
        })
    );
    const session = createSession({
      backendSessionId: "claude-clear-stop",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-clear",
        turnId: "root-turn-clear",
        phase: "active",
      },
      messages: [
        { kind: "user", text: "Hello", timestamp: "2024-01-01T12:00:00Z" },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    await clickPaneControl(user, "Clear messages");

    // The clear owns the teardown; a second concurrent close must not be sent.
    const stop = screen.getByTestId("local-chat-stop-generation");
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledTimes(1);

    await act(async () => resolveClose({ status: "ok", data: null }));
    await waitFor(() => {
      expect(
        useChatStore.getState().sessions["test-session"].messages
      ).toHaveLength(0);
    });
  });

  it("restores Stop for retry when the close transport fails", async () => {
    const user = userEvent.setup();
    mockedCommands.closeLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "close transport failed" },
    } as never);
    const session = createSession({
      backendSessionId: "claude-stop-retry",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-retry",
        turnId: "provider-turn-retry",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    const stop = screen.getByTestId("local-chat-stop-generation");
    await user.click(stop);

    expect(stop).toBeEnabled();
    expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
      backendSessionId: "claude-stop-retry",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-retry",
        turnId: "provider-turn-retry",
        phase: "active",
      },
    });

    await user.click(stop);
    expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledTimes(2);
  });

  it("hides stop after a persistent turn returns to idle", () => {
    const session = createSession({
      backendSessionId: "codex-idle",
      harness: "codex",
      lifecycle: "idle",
      messages: [
        {
          kind: "assistant",
          text: "Completed answer",
          timestamp: "2026-07-19T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("local-chat-stop-generation")
    ).not.toBeInTheDocument();
  });

  it.each([
    { harness: "claude" as const, backendSessionId: "claude-full-turn" },
    { harness: "codex" as const, backendSessionId: "codex-full-turn" },
  ])(
    "keeps $harness activity and Stop active through the complete turn",
    ({ harness, backendSessionId }) => {
      const turnId = `${harness}-root-turn`;
      const session = createSession({
        backendSessionId,
        harness,
        lifecycle: "sending",
        messages: [
          {
            kind: "user",
            text: "Inspect the project",
            timestamp: "2026-07-26T00:00:00Z",
          },
        ],
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
        panelOpen: true,
      });
      useChatStore.getState().beginActiveTurn("test-session");

      render(<ChatWindow sessionId="test-session" />);

      const stop = screen.getByTestId("local-chat-stop-generation");
      const expectTurnActive = () => {
        expect(stop).toBeEnabled();
        expect(screen.getByText("Thinking...")).toBeInTheDocument();
      };
      expectTurnActive();

      act(() => {
        expect(
          routeLocalChatTurnStartedEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
          })
        ).toBe(true);
      });
      expectTurnActive();

      act(() => {
        expect(
          routeLocalChatTextEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            text: "I found the entry point.",
            is_partial: false,
            parent_tool_use_id: null,
          })
        ).toBe(true);
      });
      expectTurnActive();

      act(() => {
        expect(
          routeLocalChatToolCallEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            tool_name: "Read",
            tool_id: `${harness}-tool`,
            input: '{"path":"src/main.rs"}',
            parent_tool_use_id: null,
          })
        ).toBe(true);
        expect(
          routeLocalChatToolResultEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            tool_id: `${harness}-tool`,
            result: "fn main() {}",
            is_error: false,
            parent_tool_use_id: null,
          })
        ).toBe(true);
      });
      expectTurnActive();

      act(() => {
        expect(
          routePermissionRequestEvent({
            request_id: `${harness}-permission`,
            session_id: backendSessionId,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            tool_name: "Bash",
            tool_use_id: `${harness}-approval-tool`,
            input: { command: "cargo test" },
            message: "Allow running the tests?",
          })
        ).toBe(true);
      });
      expectTurnActive();
      expect(screen.getByText("Permission required")).toBeInTheDocument();

      act(() => {
        expect(
          routeLocalChatSessionEndEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: `${turnId}-child`,
            thread_id: `${harness}-child-thread`,
            is_root: false,
            duration_ms: 1,
            cost_usd: 0,
            num_turns: 1,
            result: "child done",
            is_error: false,
            context_tokens: 10,
            context_window: 200000,
          })
        ).toBe(true);
      });
      expectTurnActive();

      act(() => {
        expect(
          routeLocalChatSessionEndEvent({
            backend_session_id: backendSessionId,
            harness,
            turn_id: turnId,
            thread_id: `${harness}-thread`,
            is_root: true,
            duration_ms: 10,
            cost_usd: 0,
            num_turns: 1,
            result: "done",
            is_error: false,
            context_tokens: 10,
            context_window: 200000,
          })
        ).toBe(true);
      });

      expect(stop).not.toBeInTheDocument();
      expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
      expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
        backendSessionId,
        activeTurn: null,
        lifecycle: "idle",
      });
    }
  );

  it("ends activity for an empty assistant response", () => {
    const backendSessionId = "claude-empty-turn";
    const session = createSession({
      backendSessionId,
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "Respond only if needed",
          timestamp: "2026-07-26T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    useChatStore.getState().beginActiveTurn("test-session");
    routeLocalChatTurnStartedEvent({
      backend_session_id: backendSessionId,
      harness: "claude",
      turn_id: "empty-root-turn",
      thread_id: "empty-root-thread",
      is_root: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    act(() => {
      routeLocalChatSessionEndEvent({
        backend_session_id: backendSessionId,
        harness: "claude",
        turn_id: "empty-root-turn",
        thread_id: "empty-root-thread",
        is_root: true,
        duration_ms: 1,
        cost_usd: 0,
        num_turns: 1,
        result: "",
        is_error: false,
        context_tokens: 0,
        context_window: 200000,
      });
    });

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("local-chat-stop-generation")
    ).not.toBeInTheDocument();
    expect(useChatStore.getState().sessions["test-session"].messages).toEqual([
      expect.objectContaining({ kind: "user", text: "Respond only if needed" }),
      expect.objectContaining({ kind: "session_end", successful: true }),
    ]);
  });

  it("ends activity and hides Stop on a matching terminal error", () => {
    const backendSessionId = "codex-error-turn";
    const session = createSession({
      backendSessionId,
      harness: "codex",
      lifecycle: "streaming",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    useChatStore.getState().beginActiveTurn("test-session");
    routeLocalChatTurnStartedEvent({
      backend_session_id: backendSessionId,
      harness: "codex",
      turn_id: "error-root-turn",
      thread_id: "error-root-thread",
      is_root: true,
    });
    render(<ChatWindow sessionId="test-session" />);

    act(() => {
      expect(
        routeLocalChatSessionErrorEvent({
          backend_session_id: backendSessionId,
          harness: "codex",
          turn_id: "error-root-turn",
          thread_id: "error-root-thread",
          is_root: true,
          error: "Codex stopped unexpectedly",
        })
      ).toBe(true);
    });

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("local-chat-stop-generation")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Codex stopped unexpectedly")).toBeInTheDocument();
    expect(useChatStore.getState().sessions["test-session"]).toMatchObject({
      backendSessionId: null,
      activeTurn: null,
      lifecycle: "error",
      lifecycleError: "Codex stopped unexpectedly",
    });
  });

  it("stops an active backend session with Cmd+period", async () => {
    const session = createSession({
      backendSessionId: "codex-hotkey",
      harness: "codex",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-hotkey",
        turnId: "root-turn-hotkey",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    fireEvent.keyDown(window, { key: ".", metaKey: true });

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "codex-hotkey"
      );
    });
  });

  it("retires a pending user question and enables the composer when stopped", async () => {
    const questions = [
      {
        question: "Proceed?",
        header: "Confirm",
        options: [{ label: "Yes", description: "Continue" }],
        multi_select: false,
      },
    ];
    const session = createSession({
      backendSessionId: "claude-question",
      providerResumeId: "claude-conversation",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-question",
        turnId: "root-turn-question",
        phase: "active",
      },
      messages: [
        {
          kind: "user_question",
          requestId: "req-stop",
          toolUseId: "tool-stop",
          questions,
          originalQuestions: questions,
          status: "pending",
          timestamp: "2026-07-14T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Queue message")).toBeDisabled();
    fireEvent.keyDown(window, { key: ".", metaKey: true });

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "claude-question"
      );
      expect(
        useChatStore.getState().sessions["test-session"].messages[0]
      ).toMatchObject({ kind: "user_question", status: "unavailable" });
    });
  });

  it("keeps messages when backend close fails during clear", async () => {
    mockedCommands.closeLocalChatSession.mockResolvedValueOnce({
      status: "error",
      error: { SendFailed: "pipe closed" },
    } as never);
    const user = userEvent.setup();
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await clickPaneControl(user, "Clear messages");

    await waitFor(() => {
      expect(mockedCommands.closeLocalChatSession).toHaveBeenCalledWith(
        "claude-abc"
      );
      const current = useChatStore.getState().sessions["test-session"];
      expect(current.messages).toHaveLength(1);
      expect(current.backendSessionId).toBe("claude-abc");
      expect(current.lifecycle).toBe("error");
      expect(current.lifecycleError).toBe("pipe closed");
    });
  });

  it("shows placeholder text for idle session", () => {
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByPlaceholderText("Type a message to start...")
    ).toBeInTheDocument();
  });

  it("focuses the composer for a pending focus request, once", () => {
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
      composerFocusRevision: 1,
      composerFocusHandledRevision: 0,
    });

    const { unmount } = render(
      <ChatWindow sessionId="test-session" composerFocusRevision={1} />
    );

    expect(
      screen.getByPlaceholderText("Type a message to start...")
    ).toHaveFocus();
    expect(useChatStore.getState().composerFocusHandledRevision).toBe(1);
    unmount();
  });

  it("does not take focus on mount without a focus request", () => {
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    const other = document.createElement("textarea");
    document.body.append(other);
    other.focus();

    render(<ChatWindow sessionId="test-session" />);

    expect(other).toHaveFocus();
    other.remove();
  });

  it("shows placeholder text for active session", () => {
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByPlaceholderText("Type a message...")
    ).toBeInTheDocument();
  });

  it("shows closed status indicator for closed sessions", () => {
    const session = createSession({ lifecycle: "closed" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    // The chat header shows the hollow closed attention dot.
    screen.getByText("Test Task");
    expect(screen.getByRole("img", { name: "Closed" })).toHaveAttribute(
      "data-attention",
      "closed"
    );
  });

  // --- A) User interaction flow ---

  it("sends message when send button is clicked and clears input", async () => {
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    await user.type(textarea, "Hello world");
    expect(textarea).toHaveValue("Hello world");

    await user.click(screen.getByTitle("Send message"));

    expect(textarea).toHaveValue("");
  });

  it("sends message on Enter key and clears input", async () => {
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    await user.type(textarea, "Test message");
    await user.keyboard("{Enter}");

    expect(textarea).toHaveValue("");
  });

  it("keeps newline input on Shift+Enter and grows the composer", async () => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "scrollHeight"
    );
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.value.includes("\n") ? 88 : 40;
      },
    });
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    try {
      render(<ChatWindow sessionId="test-session" />);

      const textarea = screen.getByTestId("local-chat-composer");
      await user.type(textarea, "Line one");
      expect(textarea).toHaveStyle({ height: "40px" });

      await user.keyboard("{Shift>}{Enter}{/Shift}");
      await user.type(textarea, "Line two");

      expect(textarea).toHaveValue("Line one\nLine two");
      expect(textarea).toHaveStyle({ height: "88px" });
      expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();
    } finally {
      if (original) {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          "scrollHeight",
          original
        );
      }
    }
  });

  it("does not send whitespace-only messages", async () => {
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const textarea = screen.getByPlaceholderText("Type a message...");
    await user.type(textarea, "   ");
    await user.keyboard("{Enter}");

    // Input not cleared because send was blocked by trim() check
    expect(textarea).toHaveValue("   ");
  });

  it("starts session on Enter when not active and input has text", async () => {
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const textarea = screen.getByPlaceholderText("Type a message to start...");
    await user.type(textarea, "Start chat");
    await user.keyboard("{Enter}");

    // Input cleared after starting session
    expect(textarea).toHaveValue("");
  });

  // --- B) Conditional indicators presence AND absence ---

  it("shows partial cursor for streaming assistant messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "assistant",
          text: "Still typing...",
          timestamp: "2024-01-01T12:00:00Z",
          isPartial: true,
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(document.querySelector(".ev-cursor")).toBeInTheDocument();
  });

  it("renders local user chat messages as markdown", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      messages: [
        {
          kind: "user",
          text: "Please read:\n\n- **first**\n- `second`",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    const { container } = render(<ChatWindow sessionId="test-session" />);

    const userRow = container.querySelector(".evrow--user");
    expect(userRow?.querySelector(".markdown-content")).toBeInTheDocument();
    expect(userRow?.querySelector("li strong")).toHaveTextContent("first");
    expect(userRow?.querySelector("li code")).toHaveTextContent("second");
  });

  it("renders the ephemeral streaming assistant overlay", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "Question",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
      streamingAssistant: {
        text: "Overlay answer",
        timestamp: "2024-01-01T12:00:01Z",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Overlay answer")).toBeInTheDocument();
    expect(document.querySelector(".ev-cursor")).toBeInTheDocument();
    expect(
      useChatStore.getState().sessions["test-session"].messages
    ).toHaveLength(1);
  });

  it("does not render the same streamed assistant partial twice", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user",
          text: "Question",
          timestamp: "2024-01-01T12:00:00Z",
        },
        {
          kind: "assistant",
          text: "Overlay answer",
          timestamp: "2024-01-01T12:00:01Z",
          isPartial: true,
        },
      ],
      streamingAssistant: {
        text: "Overlay answer",
        timestamp: "2024-01-01T12:00:01Z",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getAllByText("Overlay answer")).toHaveLength(1);
    expect(document.querySelector(".ev-cursor")).toBeInTheDocument();
  });

  it("does not show partial cursor for complete assistant messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "assistant",
          text: "Done",
          timestamp: "2024-01-01T12:00:00Z",
          isPartial: false,
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(document.querySelector(".ev-cursor")).not.toBeInTheDocument();
  });

  it("shows thinking indicator when waiting for response", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      activeTurn: {
        localId: "local-turn-waiting",
        turnId: null,
        phase: "starting",
      },
      messages: [
        {
          kind: "user",
          text: "What is this?",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("keeps showing thinking while streaming before the first text delta", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-streaming",
        turnId: "root-turn-streaming",
        phase: "active",
      },
      messages: [
        {
          kind: "user",
          text: "What is this?",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("keeps showing activity after an assistant snapshot", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      activeTurn: {
        localId: "local-turn-snapshot",
        turnId: "root-turn-snapshot",
        phase: "active",
      },
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
        {
          kind: "assistant",
          text: "Hi!",
          timestamp: "2024-01-01T12:00:01Z",
          isPartial: false,
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("does not show thinking indicator when session is not active", () => {
    const session = createSession({
      backendSessionId: null,
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("shows the running dot only while the chat is working", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      status: "open",
      lifecycle: "streaming",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByRole("img", { name: "Running" })).toHaveAttribute(
      "data-tone",
      "ok"
    );
  });

  it("does not show a running dot for an idle live runtime", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      status: "open",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByTestId("chat-attention-dot")).toBeNull();
  });

  it("does not show closed dot for open sessions", () => {
    const session = createSession({ status: "open" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.queryByRole("img", { name: "Closed" })).toBeNull();
  });

  it("hides empty state when there are messages", () => {
    const session = createSession({
      messages: [
        {
          kind: "user",
          text: "Hello",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByText(/Create, edit, and delete/)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Or run a task through a workflow")
    ).not.toBeInTheDocument();
  });

  it("hides empty state when session is active with no messages", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      messages: [],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByText(/Create, edit, and delete/)
    ).not.toBeInTheDocument();
  });

  // --- C) Send button disabled state ---

  it("disables send button when input is empty and session not active", () => {
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Start session")).toBeDisabled();
    expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
  });

  it("enables send button when input has text", async () => {
    const user = userEvent.setup();
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.type(
      screen.getByPlaceholderText("Type a message to start..."),
      "Hello"
    );

    expect(screen.getByTitle("Start session")).not.toBeDisabled();
  });

  it("disables send button when session is active with empty input", () => {
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Send message")).toBeDisabled();
  });

  // --- D) Button title attributes ---

  it("shows 'Send message' title when active, not 'Start session'", () => {
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Send message")).toBeInTheDocument();
    expect(screen.queryByTitle("Start session")).not.toBeInTheDocument();
  });

  it("shows 'Start session' title when not active, not 'Send message'", () => {
    const session = createSession({ backendSessionId: null });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByTitle("Start session")).toBeInTheDocument();
    expect(screen.queryByTitle("Send message")).not.toBeInTheDocument();
  });

  it("disables composer while a session is starting", () => {
    const session = createSession({ lifecycle: "starting" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Starting...")).toBeEnabled();
    expect(screen.getByTitle("Start session")).toBeDisabled();
  });

  it("keeps composer available for queued input while sending", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "sending",
      activeTurn: {
        localId: "local-turn-sending",
        turnId: null,
        phase: "starting",
      },
      messages: [
        {
          kind: "user",
          text: "Question",
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Type a message to queue...")
    ).toBeEnabled();
    expect(screen.getByTitle("Queue message")).toBeDisabled();
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("keeps composer available for queued input while streaming", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn-overlay",
        turnId: "root-turn-overlay",
        phase: "active",
      },
      streamingAssistant: {
        text: "Streaming now",
        timestamp: "2024-01-01T12:00:01Z",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Type a message to queue...")
    ).toBeEnabled();
    expect(screen.getByText("Streaming now")).toBeInTheDocument();
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it.each(["Control+click", "Control+Enter"])(
    "steers with %s while Enter queues",
    async (action) => {
      const turnId = "steering-turn";
      const session = createSession({
        backendSessionId: "steer-backend",
        lifecycle: "streaming",
        activeTurn: { localId: "steering-local", turnId, phase: "active" },
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
      });
      type Reply = Awaited<ReturnType<typeof commands.steerLocalChatTurn>>;
      let resolveReply!: (value: Reply) => void;
      const reply = new Promise<Reply>((resolve) => {
        resolveReply = resolve;
      });
      mockedCommands.steerLocalChatTurn.mockReturnValueOnce(reply);
      render(<ChatWindow sessionId="test-session" />);
      const composer = screen.getByTestId("local-chat-composer");
      fireEvent.keyDown(composer, { key: "Control", ctrlKey: true });
      expect(
        screen.getByRole("button", { name: "Queue message" })
      ).toBeDisabled();
      fireEvent.keyUp(composer, { key: "Control" });
      fireEvent.change(composer, { target: { value: "Change course" } });
      const arrow = screen.getByRole("button", { name: "Queue message" });
      const straightPath = arrow.querySelector("path")?.getAttribute("d");
      expect(arrow).toHaveAttribute("aria-keyshortcuts", "Control+Enter");
      fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
      fireEvent.keyDown(composer, { key: "Enter", altKey: true });
      expect(mockedCommands.steerLocalChatTurn).not.toHaveBeenCalled();
      expect(composer).toHaveValue("Change course");
      fireEvent.keyDown(composer, { key: "Control", ctrlKey: true });
      expect(arrow).toHaveAccessibleName("Steer active turn");
      expect(arrow.querySelector("path")).not.toHaveAttribute(
        "d",
        straightPath
      );
      fireEvent.keyUp(composer, { key: "Control" });
      expect(arrow).toHaveAccessibleName("Queue message");
      expect(arrow.querySelector("path")).toHaveAttribute("d", straightPath);
      fireEvent.keyDown(composer, { key: "Control", ctrlKey: true });
      fireEvent.blur(composer);
      expect(arrow).toHaveAccessibleName("Queue message");
      fireEvent.keyDown(composer, { key: "Control", ctrlKey: true });
      if (action === "Control+click") fireEvent.click(arrow, { ctrlKey: true });
      else fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
      expect(mockedCommands.steerLocalChatTurn).toHaveBeenCalledWith(
        "steer-backend",
        turnId,
        "Change course"
      );
      expect(composer).toHaveValue("Change course");
      expect(arrow).toBeDisabled();

      await act(async () => {
        const input = {
          backend_session_id: "steer-backend",
          turn_id: turnId,
          input_id: "steer:input-1",
          content: "Change course",
          observed_at: "2026-01-01T00:00:00Z",
        };
        routeLocalChatSteeringInputEvent(input);
        routeLocalChatSteeringInputEvent(input);
        resolveReply({ status: "ok", data: turnId });
      });
      expect(composer).toHaveValue("");
      expect(screen.getByText("Sent to the active turn")).toBeInTheDocument();
      expect(
        useChatStore
          .getState()
          .sessions[
            "test-session"
          ].messages.filter((message) => message.kind === "user" && message.text === "Change course")
      ).toEqual([
        {
          kind: "user",
          text: "Change course",
          inputId: "steer:input-1",
          turnId,
          timestamp: "2026-01-01T00:00:00Z",
        },
      ]);

      fireEvent.change(composer, { target: { value: "Afterward" } });
      if (action === "Control+click") fireEvent.click(arrow);
      else fireEvent.keyDown(composer, { key: "Enter" });
      await waitFor(() =>
        expect(
          useChatStore.getState().sessions["test-session"].queuedMessages
        ).toEqual(["Afterward"])
      );
      expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();
    }
  );

  it("expires follow-up confirmation without clearing a newer draft", async () => {
    const session = createSession({
      harness: "claude",
      backendSessionId: "steer-backend",
      lifecycle: "streaming",
      activeTurn: {
        localId: "local-turn",
        turnId: "original",
        phase: "active",
      },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
    });
    type Reply = Awaited<ReturnType<typeof commands.steerLocalChatTurn>>;
    let resolveReply!: (value: Reply) => void;
    mockedCommands.steerLocalChatTurn.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReply = resolve;
      })
    );
    render(<ChatWindow sessionId="test-session" />);
    const composer = screen.getByTestId("local-chat-composer");
    fireEvent.change(composer, { target: { value: "Change course" } });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(screen.getByText("Sending steering message…")).toBeVisible();
    fireEvent.change(composer, { target: { value: "A new draft" } });

    vi.useFakeTimers();
    try {
      await act(async () => {
        useChatStore.setState({
          sessions: {
            "test-session": { ...session, lifecycle: "idle", activeTurn: null },
          },
        });
        resolveReply({ status: "ok", data: "follow-up" });
      });
      expect(screen.getByText("Delivered as a follow-up turn")).toBeVisible();
      expect(composer).toHaveValue("A new draft");
      expect(
        screen.getByRole("button", { name: "Send message" })
      ).toBeEnabled();
      act(() => vi.advanceTimersByTime(3000));
      expect(
        screen.queryByText("Delivered as a follow-up turn")
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["transport rejection", "command error", "session close"])(
    "releases steering controls after %s and keeps the unsent draft",
    async (failure) => {
      const session = createSession({
        harness: "claude",
        backendSessionId: "steer-backend",
        hasUserMessage: true,
        lifecycle: "streaming",
        activeTurn: {
          localId: "local-turn",
          turnId: "original",
          phase: "active",
        },
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
      });
      type Reply = Awaited<ReturnType<typeof commands.steerLocalChatTurn>>;
      let resolveReply!: (value: Reply) => void;
      let rejectReply!: (error: Error) => void;
      mockedCommands.steerLocalChatTurn.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          resolveReply = resolve;
          rejectReply = reject;
        })
      );
      render(<ChatWindow sessionId="test-session" />);
      const composer = screen.getByTestId("local-chat-composer");
      fireEvent.change(composer, { target: { value: "Unconfirmed draft" } });
      fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
      expect(screen.getByText("Sending steering message…")).toBeVisible();
      if (failure === "session close") {
        act(() =>
          useChatStore.setState({
            sessions: {
              "test-session": {
                ...session,
                backendSessionId: null,
                lifecycle: "closed",
                activeTurn: null,
              },
            },
          })
        );
        expect(
          screen.queryByText("Sending steering message…")
        ).not.toBeInTheDocument();
      }
      await act(async () => {
        if (failure === "transport rejection") {
          rejectReply(new Error("IPC disconnected"));
        } else {
          resolveReply({
            status: "error",
            error: { SendFailed: "Delivery was not confirmed" },
          });
        }
      });
      expect(
        screen.getByText(
          /Steering.*(IPC disconnected|Delivery was not confirmed)/
        )
      ).toBeVisible();
      expect(
        screen.queryByText("Sending steering message…")
      ).not.toBeInTheDocument();
      expect(composer).toHaveValue("Unconfirmed draft");
      const submit =
        failure === "session close" ? "Resume session" : "Steer active turn";
      expect(screen.getByRole("button", { name: submit })).toBeEnabled();
    }
  );

  it.each(["new project", "rebound turn", "different chat"])(
    "leaves a %s draft alone when a steering reply is late",
    async (replacement) => {
      const projectChanged = replacement === "new project";
      const session = createSession({
        projectPath: "/old",
        backendSessionId: "old-steer-backend",
        lifecycle: "streaming",
        activeTurn: {
          localId: "old-local",
          turnId: "old-turn",
          phase: "active",
        },
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
      });
      type Reply = Awaited<ReturnType<typeof commands.steerLocalChatTurn>>;
      let resolveReply!: (value: Reply) => void;
      const reply = new Promise<Reply>((resolve) => {
        resolveReply = resolve;
      });
      mockedCommands.steerLocalChatTurn.mockReturnValueOnce(reply);
      const { rerender } = render(<ChatWindow sessionId="test-session" />);
      const composer = screen.getByTestId("local-chat-composer");
      fireEvent.change(composer, { target: { value: "Old instruction" } });
      fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });

      if (replacement === "different chat") {
        let otherSessionId!: string;
        act(() => {
          otherSessionId = useChatStore
            .getState()
            .openSession("Other chat", "/other-chat");
          useComposerDraftStore
            .getState()
            .setDraft(otherSessionId, "Other chat draft");
        });
        rerender(<ChatWindow sessionId={otherSessionId} />);
        await act(async () => resolveReply({ status: "ok", data: "old-turn" }));
        expect(screen.getByTestId("local-chat-composer")).toHaveValue(
          "Other chat draft"
        );
        expect(
          screen.queryByText("Sent to the active turn")
        ).not.toBeInTheDocument();
        rerender(<ChatWindow sessionId="test-session" />);
        expect(screen.getByTestId("local-chat-composer")).toHaveValue(
          "Old instruction"
        );
        expect(
          screen.queryByText("Sending steering message…")
        ).not.toBeInTheDocument();
        return;
      }

      await act(async () => {
        useChatStore.setState({
          sessions: {
            "test-session": {
              ...session,
              projectPath: projectChanged
                ? "/replacement"
                : session.projectPath,
              backendSessionId: projectChanged
                ? "replacement"
                : session.backendSessionId,
              activeTurn: {
                localId: "old-local",
                turnId: "new-turn",
                phase: "active",
              },
            },
          },
        });
        if (projectChanged) {
          useComposerDraftStore
            .getState()
            .setDraft("test-session", "New draft");
          resolveReply({
            status: "error",
            error: { SendFailed: "Old turn finished" },
          });
        } else {
          resolveReply({ status: "ok", data: "old-turn" });
        }
      });
      expect(screen.getByTestId("local-chat-composer")).toHaveValue(
        projectChanged ? "New draft" : "Old instruction"
      );
      expect(
        screen.queryByText(/Old turn finished|Sent to the active turn/)
      ).not.toBeInTheDocument();
      expect(
        useChatStore.getState().sessions["test-session"].activeTurn?.turnId
      ).toBe("new-turn");
    }
  );

  it("disables ordinary composer sends while a user question is pending", () => {
    const questions = [
      {
        question: "Proceed?",
        header: "Confirm",
        options: [{ label: "Yes", description: "Continue" }],
        multi_select: false,
      },
    ];
    const session = createSession({
      backendSessionId: "claude-abc",
      lifecycle: "streaming",
      messages: [
        {
          kind: "user_question",
          requestId: "req-1",
          toolUseId: "tool-1",
          questions,
          originalQuestions: questions,
          status: "pending",
          timestamp: "2026-07-14T00:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.getByPlaceholderText(
        "Answer Claude's question above to continue..."
      )
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Submit answers" })
    ).toBeDisabled();
  });

  it.each([false, true])(
    "allows retry after an error with live backend=%s",
    async (liveBackend) => {
      const user = userEvent.setup();
      const session = createSession({
        lifecycle: "error",
        lifecycleError: "Claude failed",
        backendSessionId: liveBackend ? "live-claude-id" : null,
        providerResumeId: "conv-retry",
      });
      useChatStore.setState({
        sessions: { "test-session": session },
        activeSessionId: "test-session",
        panelOpen: true,
      });

      render(<ChatWindow sessionId="test-session" />);

      expect(
        screen.queryByTestId("chat-lifecycle-label")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("chat-lifecycle-error")
      ).not.toBeInTheDocument();
      const textarea = screen.getByPlaceholderText(
        liveBackend ? "Type a message..." : "Type a message to resume..."
      );
      await user.type(textarea, "Retry");
      const submit = screen.getByTitle(
        liveBackend ? "Send message" : "Resume session"
      );
      expect(submit).not.toBeDisabled();
      await user.click(submit);

      await waitFor(() => {
        if (liveBackend) {
          expect(mockedCommands.sendLocalChatMessage).toHaveBeenCalledWith(
            "live-claude-id",
            "Retry",
            expect.any(Object)
          );
          expect(mockedCommands.createLocalChatSession).not.toHaveBeenCalled();
        } else {
          expect(mockedCommands.createLocalChatSession).toHaveBeenCalled();
          expect(mockedCommands.sendLocalChatMessage).not.toHaveBeenCalled();
        }
      });
    }
  );

  it("shows closed resumable state", async () => {
    const user = userEvent.setup();
    const session = createSession({
      lifecycle: "closed",
      providerResumeId: "conv-resume",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByRole("img", { name: "Closed" })).toBeInTheDocument();
    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    const textarea = screen.getByPlaceholderText("Type a message to resume...");
    await user.type(textarea, "Resume");
    expect(screen.getByTitle("Resume session")).not.toBeDisabled();
  });

  it("disables composer while a session is resuming", () => {
    const session = createSession({
      lifecycle: "resuming",
      providerResumeId: "conv-resume",
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(
      screen.queryByTestId("chat-lifecycle-label")
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Resuming...")).toBeEnabled();
    expect(screen.getByTitle("Resume session")).toBeDisabled();
  });

  // --- E) Tool toggling (interactive collapse) ---

  it("merges a tool_call + tool_result into one collapsible tool row", () => {
    const session = createSession({
      messages: [
        {
          kind: "assistant",
          text: "Reading file",
          timestamp: "2024-01-01T12:00:00Z",
          isPartial: false,
        },
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: '{"file_path":"/test.ts"}',
          timestamp: "2024-01-01T12:00:01Z",
        },
        {
          kind: "tool_result",
          toolId: "tool-1",
          result: "RESULT BODY",
          isError: false,
          timestamp: "2024-01-01T12:00:02Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    // The group counts the outer invocation once, including its late result.
    expect(
      screen.getByRole("button", { name: /1 call for/ })
    ).toBeInTheDocument();
    // Collapsed tool bodies are not mounted until requested.
    expect(screen.queryByText("RESULT BODY")).not.toBeInTheDocument();
  });

  it("toggles a tool body when its header is clicked (collapsed by default)", async () => {
    const user = userEvent.setup();
    const session = createSession({
      messages: [
        {
          kind: "tool_call",
          toolName: "Read",
          toolId: "tool-1",
          input: "{}",
          timestamp: "2024-01-01T12:00:01Z",
        },
        {
          kind: "tool_result",
          toolId: "tool-1",
          result: "RESULT BODY",
          isError: false,
          timestamp: "2024-01-01T12:00:02Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.click(screen.getByRole("button", { name: /1 call for/ }));
    const header = screen.getByRole("button", { name: /Raw arguments/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("RESULT BODY")).not.toBeInTheDocument();
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("RESULT BODY")).toBeInTheDocument();
    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("RESULT BODY")).not.toBeInTheDocument();
  });

  // --- F) Permission request (interactive sibling of <Thread>) ---

  it("renders a permission request with approve / deny controls", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      messages: [
        {
          kind: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          message: "Allow running ls?",
          input: '{"command":"ls"}',
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    expect(screen.getByText("Permission required")).toBeInTheDocument();
    expect(screen.getByText("Allow running ls?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("renders permission requests emitted by the neutral permission event", async () => {
    const session = createSession({ backendSessionId: "claude-abc" });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    act(() => {
      routePermissionRequestEvent({
        request_id: "req-event",
        session_id: "claude-abc",
        tool_name: "Bash",
        tool_use_id: "tool-use-1",
        input: { command: "pwd" },
        message: "Allow running pwd?",
      });
    });

    expect(screen.getByText("Permission required")).toBeInTheDocument();
    expect(screen.getByText("Allow running pwd?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("resolves a permission request when Approve is clicked", async () => {
    const user = userEvent.setup();
    const { commands } = await import("../../bindings");
    (
      commands.resolvePermissionRequest as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ status: "ok" });
    const session = createSession({
      backendSessionId: "claude-abc",
      messages: [
        {
          kind: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          message: "Allow running ls?",
          input: '{"command":"ls"}',
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(commands.resolvePermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: "req-1",
        behavior: "allow",
        message: null,
        updated_input: { command: "ls" },
      })
    );
    expect(await screen.findByText(/approved/)).toBeInTheDocument();
  });

  it("rejects non-object updated input before approving a permission request", async () => {
    const user = userEvent.setup();
    const { commands } = await import("../../bindings");
    const session = createSession({
      backendSessionId: "claude-abc",
      messages: [
        {
          kind: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          message: "Allow running ls?",
          input: '{"command":"ls"}',
          timestamp: "2024-01-01T12:00:00Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const input = screen.getByDisplayValue('{"command":"ls"}');
    fireEvent.change(input, { target: { value: "[1,2,3]" } });
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText("Updated input must be a JSON object")
    ).toBeInTheDocument();
    expect(commands.resolvePermissionRequest).not.toHaveBeenCalled();
  });

  it("renders permission requests in chronological message order", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      messages: [
        {
          kind: "assistant",
          text: "Before permission",
          timestamp: "2024-01-01T12:00:00Z",
        },
        {
          kind: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          message: "Allow running ls?",
          input: '{"command":"ls"}',
          timestamp: "2024-01-01T12:00:01Z",
        },
        {
          kind: "assistant",
          text: "After permission",
          timestamp: "2024-01-01T12:00:02Z",
        },
      ],
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    const { container } = render(<ChatWindow sessionId="test-session" />);
    const text = container.textContent ?? "";

    expect(text.indexOf("Before permission")).toBeLessThan(
      text.indexOf("Allow running ls?")
    );
    expect(text.indexOf("Allow running ls?")).toBeLessThan(
      text.indexOf("After permission")
    );
  });

  // --- G) Context fill bar ---

  it("fills the context ring to the input-context utilization percentage", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      model: "claude-sonnet-4.5",
      tokenUsage: { used: 100_050, max: 200_000 },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const fill = screen.getByTestId("chat-context-fill");
    const circumference = 2 * Math.PI * 6;
    expect(Number(fill.style.strokeDashoffset)).toBeCloseTo(circumference / 2);
    fireEvent.click(screen.getByTestId("chat-context-ring"));
    const popover = screen.getByTestId("chat-context-popover");
    expect(popover).toHaveTextContent("Context50%");
    expect(popover).toHaveTextContent("Request100,050 / 200,000");
  });

  it("clamps the context ring at 100% when input context exceeds the max window", () => {
    const session = createSession({
      backendSessionId: "claude-abc",
      model: "claude-sonnet-4.5",
      tokenUsage: { used: 250_000, max: 200_000 },
    });
    useChatStore.setState({
      sessions: { "test-session": session },
      activeSessionId: "test-session",
      panelOpen: true,
    });

    render(<ChatWindow sessionId="test-session" />);

    const fill = screen.getByTestId("chat-context-fill");
    expect(Number(fill.style.strokeDashoffset)).toBeCloseTo(0);
    fireEvent.click(screen.getByTestId("chat-context-ring"));
    const popover = screen.getByTestId("chat-context-popover");
    expect(popover).toHaveTextContent("Context100%");
    expect(popover).toHaveTextContent("Request250,000 / 200,000");
  });
});

describe("ChatWindow composer focus", () => {
  const SESSION = "test-session";
  const OTHER = "other-session";

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useLocalChatDefaultsStore.setState({ defaults: {}, defaultProvider: null });
    useChatStore.setState({
      sessions: {
        [SESSION]: createSession({ backendSessionId: null }),
        [OTHER]: createSession({ id: OTHER, label: "Other" }),
      },
      activeSessionId: SESSION,
      paneLayout: { ...EMPTY_WORKSPACE, order: [], activeId: null },
      panelOpen: true,
      composerFocusRevision: 0,
      composerFocusHandledRevision: 0,
    });
  });

  const composer = () =>
    screen.getByTestId("local-chat-composer") as HTMLTextAreaElement;

  /** A keystroke reaches whatever holds focus, if it accepts text. */
  function press(char: string) {
    const target = document.activeElement;
    if (
      !(target instanceof HTMLTextAreaElement) ||
      target.disabled ||
      target.readOnly
    )
      return;
    fireEvent.change(target, { target: { value: target.value + char } });
  }

  const store = () => useChatStore.getState();
  const events = {
    start: () => store().setSessionLifecycle(SESSION, "starting"),
    bind: () => {
      store().setBackendSessionId(SESSION, "backend-1");
      store().setSessionLifecycle(SESSION, "sending");
    },
    stream: (text: string) => {
      store().setSessionLifecycle(SESSION, "streaming");
      store().updateLastAssistantMessage(SESSION, text);
    },
    finish: () => {
      store().finalizeLastAssistantMessage(SESSION, "done");
      store().settleActiveTurn(SESSION);
      store().setSessionLifecycle(SESSION, "idle");
    },
    lifecycle: (
      lifecycle: "resuming" | "compacting" | "closing" | "idle" | "error"
    ) => store().setSessionLifecycle(SESSION, lifecycle),
    otherSession: (text: string) => {
      store().setSessionLifecycle(OTHER, "streaming");
      store().updateLastAssistantMessage(OTHER, text);
    },
    summaries: () =>
      useChatStore.setState((state) => ({
        localSessionSummaries: { ...state.localSessionSummaries },
        activityRevisions: { ...state.activityRevisions, [OTHER]: Date.now() },
      })),
  };

  it("keeps every keystroke in the composer while a turn starts, streams and finishes", () => {
    render(<ChatWindow sessionId={SESSION} />);
    composer().focus();

    press("a");
    act(events.start);
    press("b");
    act(events.bind);
    press("c");
    act(() => events.stream("Hel"));
    press("d");
    act(() => events.stream("Hello"));
    act(events.finish);
    press("e");

    expect(composer()).toHaveFocus();
    expect(composer()).toHaveValue("abcde");
  });

  it("keeps focus while other sessions stream and summaries refresh", () => {
    render(<ChatWindow sessionId={SESSION} />);
    composer().focus();

    press("x");
    act(() => events.otherSession("elsewhere"));
    act(events.summaries);
    press("y");

    expect(composer()).toHaveFocus();
    expect(composer()).toHaveValue("xy");
  });

  it("does not let a focus request for another pane move focus here", () => {
    render(<ChatWindow sessionId={SESSION} />);
    const elsewhere = document.createElement("textarea");
    document.body.append(elsewhere);
    elsewhere.focus();

    act(() => store().requestComposerFocus());

    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });

  it("refocuses the replacement composer when the pane remounts its chat", async () => {
    const { rerender } = render(
      <div data-pane-id="pane-1">
        <ChatWindow key="a" sessionId={SESSION} />
      </div>
    );
    composer().focus();
    press("q");

    rerender(
      <div data-pane-id="pane-1">
        <ChatWindow key="b" sessionId={SESSION} />
      </div>
    );

    await waitFor(() => expect(composer()).toHaveFocus());
  });

  it("keeps the unsent draft when the pane remounts its chat (split, maximize)", () => {
    const { rerender } = render(<ChatWindow key="a" sessionId={SESSION} />);
    composer().focus();
    press("d");
    press("r");

    rerender(<ChatWindow key="b" sessionId={SESSION} />);

    expect(composer()).toHaveValue("dr");
  });

  describe("property", () => {
    type Model = { typed: string; phase: "idle" | "started" | "bound" };
    const CHARS = ["a", "b", " ", "1", "?"];

    const machine: hegel.stateful.StateMachine<Model> = {
      rules: {
        key: (tc, model) => {
          const char = tc.draw(gs.sampledFrom(CHARS));
          press(char);
          model.typed += char;
        },
        start: (tc, model) => {
          tc.assume(model.phase === "idle");
          act(events.start);
          model.phase = "started";
        },
        bind: (tc, model) => {
          tc.assume(model.phase === "started");
          act(events.bind);
          model.phase = "bound";
        },
        stream: (tc, model) => {
          tc.assume(model.phase === "bound");
          const text = tc.draw(gs.sampledFrom(["H", "He", "Hello"]));
          act(() => events.stream(text));
        },
        finish: (tc, model) => {
          tc.assume(model.phase === "bound");
          act(events.finish);
          model.phase = "idle";
        },
        lifecycle: (tc) => {
          const lifecycle = tc.draw(
            gs.sampledFrom([
              "resuming",
              "compacting",
              "closing",
              "idle",
              "error",
            ] as const)
          );
          act(() => events.lifecycle(lifecycle));
        },
        otherSession: (tc) => {
          const text = tc.draw(gs.sampledFrom(["x", "xy"]));
          act(() => events.otherSession(text));
        },
        summaries: () => act(events.summaries),
      },
      invariants: {
        focusAndText: {
          alwaysCheck: true,
          check: (_tc, model) => {
            expect(document.activeElement).toBe(composer());
            expect(composer().value).toBe(model.typed);
          },
        },
      },
    };

    it("keeps focus and exactly the typed text across any interleaving of app events", () => {
      hegel.test(
        (tc) => {
          useComposerDraftStore.setState({ bySession: {} });
          useChatStore.setState({
            sessions: {
              [SESSION]: createSession({ backendSessionId: null }),
              [OTHER]: createSession({ id: OTHER, label: "Other" }),
            },
          });
          const view = render(<ChatWindow sessionId={SESSION} />);
          try {
            composer().focus();
            hegel.stateful.run(
              tc,
              machine,
              { typed: "", phase: "idle" },
              {
                stepCount: 30,
              }
            );
          } finally {
            view.unmount();
          }
        },
        { testCases: 25 }
      );
    }, 120_000);
  });
});

describe("ChatWindow PR chip", () => {
  const base = {
    ticketId: null,
    ticketTitle: null,
    worktreePath: "/worktree",
    branch: "feature/pinned",
    lastProcessedAt: null,
    processedAtCount: 0,
    awaitingWorktree: null,
    recentWorktrees: [],
  };
  const linked = (branch: string, number: number) => ({
    status: "ok" as const,
    data: {
      status: "linked",
      branch,
      repo: "example/demo-repo",
      pr: {
        owner: "example",
        repo: "demo-repo",
        number,
        title: `PR ${number}`,
        state: "open",
        headRef: branch,
        headRepo: "example/demo-repo",
        baseRef: "main",
        url: `https://github.com/example/demo-repo/pull/${number}`,
        author: null,
        updatedAt: null,
      },
      staleError: null,
    } satisfies WorktreePrAssociation,
  });
  const getAssociation = () => mockedCommands.getWorktreePrAssociation;

  function seed(association: object) {
    useChatStore.setState({
      sessions: { "test-session": createSession({ association }) },
      activeSessionId: "test-session",
      paneLayout: { ...EMPTY_WORKSPACE, order: [], activeId: null },
      panelOpen: true,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Every branch has an open PR; only the pinned one may be asked about.
    getAssociation().mockImplementation(async (_path, branch) =>
      linked(branch, branch === "feature/pinned" ? 482 : 479)
    );
    mockedCommands.getWorktreePrChecks.mockResolvedValue({
      status: "error",
      error: { kind: "other", message: "offline", retryAfterSecs: null },
    });
  });

  afterEach(() => {
    resetWorktreePrChecksStore();
    resetWorktreePrStore();
  });

  it("shows no chip and runs no PR lookup while the chat holds its creation default", async () => {
    seed({
      ...base,
      worktreePath: "/test/project",
      branch: "feature/open-pr",
      defaultWorktree: true,
    });
    render(<ChatWindow sessionId="test-session" />);
    await act(async () => {});

    expect(screen.queryByTestId("chat-header-pr-chip")).toBeNull();
    expect(getAssociation()).not.toHaveBeenCalled();
  });

  it("shows no chip and runs no PR lookup for an association without a branch", async () => {
    seed({ ...base, branch: null });
    render(<ChatWindow sessionId="test-session" />);
    await act(async () => {});

    expect(screen.queryByTestId("chat-header-pr-chip")).toBeNull();
    expect(getAssociation()).not.toHaveBeenCalled();
  });

  it("follows the branch pinned on the association record", async () => {
    seed(base);
    render(<ChatWindow sessionId="test-session" />);

    expect(await screen.findByTestId("chat-header-pr-chip")).toHaveTextContent(
      "#482"
    );
    expect(getAssociation()).toHaveBeenCalledExactlyOnceWith(
      "/worktree",
      "feature/pinned",
      false
    );

    act(() =>
      useChatStore.getState().setSessionAssociation("test-session", {
        ...base,
        branch: "feature/other",
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId("chat-header-pr-chip")).toHaveTextContent(
        "#479"
      )
    );
    expect(getAssociation()).toHaveBeenLastCalledWith(
      "/worktree",
      "feature/other",
      false
    );
  });
});
