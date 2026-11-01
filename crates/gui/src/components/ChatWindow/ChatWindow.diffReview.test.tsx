import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import { ChatWindow } from "./ChatWindow";
import { useChatStore } from "../../stores/chatStore";
import type { ChatSession } from "../../stores/chatStore";
import { commands } from "../../bindings";
import {
  filePatch,
  numbered,
} from "../thread/toolChange/diffPatchBuilder.test.helpers";

Element.prototype.scrollIntoView = vi.fn();
const mockedCommands = vi.mocked(commands);

const BASE = numbered("l", 20);
const WITH_X = [...BASE.slice(0, 5), "X", ...BASE.slice(5)];
const TOOL_PATCH = filePatch({ path: "f.ts", before: BASE, after: WITH_X });
const ALL = TOOL_PATCH;

interface Annotated {
  side: string;
  lineNumber: number;
  metadata: unknown;
}
const seen = vi.hoisted(() => ({
  fileDiff: null as Record<string, unknown> | null,
  items: [] as Array<{ id: string; annotations?: Annotated[] }>,
}));

// Pierre needs real layout; these stand-ins record props and draw annotations.
vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    ...original,
    FileDiff: (props: {
      fileDiff: { name: string };
      options?: {
        onGutterUtilityClick?: (range: unknown) => void;
      };
      lineAnnotations?: Annotated[];
      renderAnnotation?: (...args: unknown[]) => ReactNode;
    }) => {
      seen.fileDiff = props as unknown as Record<string, unknown>;
      return (
        <div data-testid="file-diff">
          <button
            type="button"
            onClick={() =>
              props.options?.onGutterUtilityClick?.({
                start: 6,
                end: 6,
                side: "additions",
              })
            }
          >
            gutter file diff
          </button>
          {props.lineAnnotations?.map((annotation) => (
            <div key={annotation.lineNumber}>
              {props.renderAnnotation?.(annotation, props.fileDiff)}
            </div>
          ))}
        </div>
      );
    },
    CodeView: forwardRef(function CodeView(
      props: {
        items: Array<{
          id: string;
          fileDiff: unknown;
          annotations?: Annotated[];
        }>;
        options?: {
          onGutterUtilityClick?: (range: unknown, context: unknown) => void;
        };
        renderAnnotation?: (...args: unknown[]) => ReactNode;
        renderHeaderMetadata(item: unknown): ReactNode;
      },
      ref
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: vi.fn() }));
      seen.items = props.items;
      return (
        <div data-testid="code-view">
          {props.items.map((item) => (
            <div key={item.id}>
              <button
                type="button"
                onClick={() =>
                  props.options?.onGutterUtilityClick?.(
                    { start: 6, end: 6, side: "additions" },
                    { item }
                  )
                }
              >
                gutter code view
              </button>
              {item.annotations?.map((annotation) => (
                <div key={annotation.lineNumber}>
                  {props.renderAnnotation?.(annotation, item.fileDiff, item)}
                </div>
              ))}
            </div>
          ))}
        </div>
      );
    }),
  };
});

// Mock the bindings
vi.mock("../../bindings", async () => {
  const { withBuiltinProviders } = await import("../../test/localChatCatalog");
  return {
    commands: {
      loadWorktreeChanges: vi.fn().mockImplementation(async () => ({
        status: "ok",
        data: {
          base_branch: null,
          base_unavailable: null,
          files: [
            {
              path: "f.ts",
              old_path: null,
              status: "modified",
              marker: null,
              patch: ALL,
            },
          ],
        },
      })),
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
      sendLocalChatMessage: vi.fn().mockResolvedValue({ status: "ok" }),
      closeLocalChatSession: vi.fn().mockResolvedValue({ status: "ok" }),
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

const TOOL_ANNOTATIONS = {
  t1: {
    worktree_delta: {
      session_id: "test-session",
      tool_id: "t1",
      kind: "worktree_delta",
      recorded_at: "2024-01-01T12:00:01Z",
      payload: {
        patch: TOOL_PATCH,
        files: [{ path: "f.ts", status: "modified" }],
      },
    },
  },
};

function seedSession(withAnnotations = true) {
  useChatStore.setState({
    sessions: {
      "test-session": createSession({
        association,
        messages: [
          {
            kind: "tool_call",
            toolName: "Edit",
            toolId: "t1",
            input: "{}",
            timestamp: "2024-01-01T12:00:00Z",
          },
          {
            kind: "tool_result",
            toolId: "t1",
            result: "ok",
            isError: false,
            timestamp: "2024-01-01T12:00:01Z",
          },
        ],
        toolAnnotations: withAnnotations ? TOOL_ANNOTATIONS : undefined,
      }),
    },
    activeSessionId: "test-session",
    panelOpen: true,
  });
}

describe("ChatWindow diff review comments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    seen.items = [];
    seen.fileDiff = null;
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
    });
  });

  it("shares a tool-call comment with All Changes, then sends and clears it", async () => {
    seedSession();
    render(<ChatWindow sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
    fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));

    fireEvent.click(
      await screen.findByRole("button", { name: "gutter file diff" })
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { target: { value: "Why X?" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(screen.getByTestId("local-chat-pending-comments")).toHaveAttribute(
      "aria-label",
      "1 comments queued for your reply"
    );

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(seen.items).toHaveLength(1));
    expect(seen.items[0].annotations).toEqual([
      {
        side: "additions",
        lineNumber: 6,
        metadata: { commentIds: [expect.any(String)], draft: false },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    fireEvent.click(screen.getByTitle("Start session"));
    await waitFor(() =>
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          initial_prompt: expect.stringContaining(
            "1. Tool call Edit f.ts · f.ts:6 (new)\n   ```diff\n   @@ -3,6 +3,7 @@\n    l3\n    l4\n    l5\n   +X\n   ```\n   Comment: Why X?"
          ),
        })
      )
    );
    await waitFor(() =>
      expect(screen.queryByTestId("local-chat-pending-comments")).toBeNull()
    );
  });

  it("writes a comment in All Changes, shows it inline and navigates back from its chip", async () => {
    seedSession();
    render(<ChatWindow sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
    fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(seen.items).toHaveLength(1));
    expect(seen.items[0].annotations).toEqual([]);

    // Line 6 of All Changes is the added X.
    fireEvent.click(screen.getByRole("button", { name: "gutter code view" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { target: { value: "Rename X" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    expect(seen.items[0].annotations).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    await waitFor(() =>
      expect(
        (seen.fileDiff as unknown as { lineAnnotations: Annotated[] })
          .lineAnnotations
      ).toEqual([
        {
          side: "additions",
          lineNumber: 6,
          metadata: { commentIds: [expect.any(String)], draft: false },
        },
      ])
    );
    expect(screen.getByText("Rename X")).toBeTruthy();

    // The chip leads back to the All Changes comment.
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    fireEvent.click(screen.getByTestId("local-chat-comment-icon-1"));
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("marks an All Changes comment outdated when the patch changes on refresh", async () => {
    seedSession();
    render(<ChatWindow sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
    fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(seen.items).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "gutter code view" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { target: { value: "Rename X" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    // The agent moved things: the same file now has an extra line above X.
    const moved = filePatch({
      path: "f.ts",
      before: BASE,
      after: ["top", ...WITH_X],
    });
    mockedCommands.loadWorktreeChanges.mockImplementationOnce(async () => ({
      status: "ok",
      data: {
        base_branch: null,
        base_unavailable: null,
        files: [
          {
            path: "f.ts",
            old_path: null,
            status: "modified",
            marker: null,
            patch: moved,
          },
        ],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    await waitFor(() =>
      expect(screen.getByText("outdated")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    fireEvent.click(screen.getByTestId("local-chat-comment-icon-1"));
    expect(screen.getByTestId("local-chat-comment-popover")).toHaveTextContent(
      "outdated"
    );
  });

  it("places an All Changes comment on a tool call whose annotation arrives later", async () => {
    seedSession(false);
    render(<ChatWindow sessionId="test-session" />);
    fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
    fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(seen.items).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "gutter code view" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { target: { value: "Rename X" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(seen.fileDiff).toBeNull();

    act(() =>
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          "test-session": {
            ...state.sessions["test-session"],
            toolAnnotations: TOOL_ANNOTATIONS,
          },
        },
      }))
    );
    await waitFor(() =>
      expect(
        (seen.fileDiff as unknown as { lineAnnotations: Annotated[] })
          .lineAnnotations
      ).toEqual([expect.objectContaining({ side: "additions", lineNumber: 6 })])
    );
  });
});
