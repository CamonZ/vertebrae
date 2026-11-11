import { useDocumentStore } from "./workspace/documentStore";
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
  scroll: vi.fn(),
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
        renderCustomHeader?(item: unknown): ReactNode;
      },
      ref
    ) {
      useImperativeHandle(ref, () => ({ scrollTo: seen.scroll }));

      const inline = !props.renderCustomHeader;
      const firstItem = props.items[0];

      if (inline) {
        seen.fileDiff = {
          fileDiff: firstItem?.fileDiff,
          lineAnnotations: firstItem?.annotations,
          options: props.options,
        };
      } else {
        seen.items = props.items;
      }

      return (
        <div data-testid={inline ? "file-diff" : "code-view"}>
          {props.items.map((item) => (
            <div key={item.id}>
              {props.renderCustomHeader?.(item)}
              <button
                type="button"
                onClick={() =>
                  props.options?.onGutterUtilityClick?.(
                    { start: 6, end: 6, side: "additions" },
                    { item }
                  )
                }
              >
                {inline ? "gutter file diff" : "gutter code view"}
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
      listComparisonChoices: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: [] }),
      loadWorktreeChanges: vi.fn().mockImplementation(async () => ({
        status: "ok",
        data: {
          base_branch: null,
          base_unavailable: null,
          comparison: {
            base_commit: "base-sha",
            selected_base_commit: "base-sha",
            target_commit: "head-sha",
            working_tree: true,
            merge_base: true,
          },
          totals: { additions: 2, deletions: 2, binary_files: 0 },
          files: [
            {
              path: "f.ts",
              old_path: null,
              status: "modified",
              marker: null,
              totals: { additions: 1, deletions: 1, binary_files: 0 },
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

  it("opens Changes from a flow evidence ref with its line range", async () => {
    const spec = {
      version: 1,
      parts: [
        {
          id: "client",
          kind: "client",
          label: "Client",
          attachments: [{ kind: "ref", path: "f.ts", line: 6, endLine: 8 }],
        },
      ],
      story: [{ caption: "Evidence", steps: [] }],
    };
    useChatStore.setState({
      sessions: {
        "test-session": createSession({
          association,
          messages: [
            {
              kind: "assistant",
              text: "```flow\n" + JSON.stringify(spec) + "\n```",
              timestamp: "2024-01-01T12:00:00Z",
            },
          ],
        }),
      },
      activeSessionId: "test-session",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="test-session" />);
    const player = await screen.findByTestId("flow-player");
    fireEvent.keyDown(player.querySelector("g[data-part-id='client']")!, {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("button", { name: "f.ts:6–8" }));
    expect(
      await screen.findByRole("complementary", { name: "Changes panel" })
    ).toBeVisible();
    await waitFor(() =>
      expect(seen.scroll).toHaveBeenCalledWith({
        type: "line",
        id: "f.ts",
        lineNumber: 6,
        side: "additions",
        align: "center",
      })
    );
  });

  it("matches the conversation navigation model through scope and document changes", async () => {
    const messages: ChatSession["messages"] = [
      {
        kind: "assistant",
        timestamp: "2024-01-01T12:00:00Z",
        text:
          "```flow\n" +
          JSON.stringify({
            version: 1,
            parts: [
              {
                id: "client",
                kind: "client",
                attachments: [
                  { kind: "ref", path: "f.ts", line: 6, endLine: 8 },
                  {
                    kind: "diff",
                    path: "f.ts",
                    patch: ALL,
                    line: 9,
                    endLine: 10,
                    side: "old",
                  },
                ],
              },
            ],
          }) +
          "\n```",
      },
    ];
    useChatStore.setState({
      sessions: {
        a: createSession({ id: "a", association, messages }),
        b: createSession({
          id: "b",
          association: { ...association, worktreePath: "/other" },
          messages,
        }),
      },
      activeSessionId: "a",
      panelOpen: true,
    });
    const priorDocuments = useDocumentStore.getState().workspaces;
    let session = "a";
    let worktree = "/worktree";
    const worktrees: Record<string, string> = { a: "/worktree", b: "/other" };
    let openOwner: string | null = null;
    let request: { session: string; worktree: string; line: number } | null =
      null;
    let expectedScrollCount = 0;
    const view = render(<ChatWindow sessionId={session} />);
    type Action =
      | "ref"
      | "diff"
      | "fold"
      | "refresh"
      | "toggle"
      | "session"
      | "worktree"
      | "document";
    const actions: Action[] = [
      "ref",
      "fold",
      "refresh",
      "ref",
      "toggle",
      "toggle",
      "session",
      "diff",
      "worktree",
      "refresh",
      "ref",
      "document",
      "diff",
      "session",
      "ref",
      "toggle",
      "session",
      "diff",
    ];
    try {
      for (const action of actions) {
        if (action === "ref" || action === "diff") {
          const line = action === "ref" ? 6 : 9;
          openOwner = session;
          request = { session, worktree, line };
          expectedScrollCount++;
          const player = await screen.findByTestId("flow-player");
          if (!screen.queryByTestId("flow-part-inspector"))
            fireEvent.keyDown(
              player.querySelector("g[data-part-id='client']")!,
              { key: "Enter" }
            );
          fireEvent.click(
            screen.getByRole("button", {
              name: action === "ref" ? "f.ts:6–8" : "f.ts:9–10",
            })
          );
        } else if (action === "toggle") {
          const opening: boolean = openOwner !== session;
          openOwner = opening ? session : null;
          if (
            opening &&
            request?.session === session &&
            request.worktree === worktree
          )
            expectedScrollCount++;
          fireEvent.click(screen.getByRole("button", { name: "Changes" }));
        } else if (action === "session") {
          session = session === "a" ? "b" : "a";
          worktree = worktrees[session];
          view.rerender(<ChatWindow sessionId={session} />);
        } else if (action === "worktree") {
          worktree = "/replacement";
          worktrees[session] = worktree;
          act(() =>
            useChatStore.setState((state) => ({
              sessions: {
                ...state.sessions,
                [session]: {
                  ...state.sessions[session],
                  association: { ...association, worktreePath: worktree },
                },
              },
            }))
          );
        } else if (action === "fold") {
          fireEvent.click(
            await screen.findByRole("button", { name: "Toggle diff for f.ts" })
          );
        } else if (action === "refresh") {
          const count = mockedCommands.loadWorktreeChanges.mock.calls.length;
          fireEvent.click(
            screen.getByRole("button", { name: "Refresh changes" })
          );
          await waitFor(() =>
            expect(
              mockedCommands.loadWorktreeChanges.mock.calls.length
            ).toBeGreaterThan(count)
          );
        } else {
          act(() =>
            useDocumentStore.setState({
              workspaces: {
                [worktree]: {
                  order: ["document.bin"],
                  active: "document.bin",
                  documents: {
                    "document.bin": {
                      path: "document.bin",
                      disk: { kind: "binary" },
                      draft: null,
                      seed: 0,
                      view: "file",
                      baseline: null,
                      conflict: null,
                      saving: false,
                      saveError: null,
                      loadToken: 0,
                    },
                  },
                },
              },
            })
          );
        }
        const open = openOwner === session;
        if (open && action !== "document")
          await screen.findByRole("button", { name: "Refresh changes" });
        await act(async () => {});
        expect(
          screen.queryByRole("complementary", { name: "Changes panel" }) !==
            null,
          action
        ).toBe(open);
        await waitFor(() =>
          expect(seen.scroll, action).toHaveBeenCalledTimes(expectedScrollCount)
        );
        if (action === "ref" || action === "diff") {
          expect(seen.scroll).toHaveBeenLastCalledWith({
            type: "line",
            id: "f.ts",
            lineNumber: request!.line,
            side: action === "ref" ? "additions" : "deletions",
            align: "center",
          });
          expect(
            useDocumentStore.getState().workspaces[worktree]?.active ?? null
          ).toBeNull();
          expect(mockedCommands.loadWorktreeChanges).toHaveBeenCalledWith(
            worktree,
            expect.anything()
          );
        }
      }
    } finally {
      view.unmount();
      useDocumentStore.setState({ workspaces: priorDocuments });
    }
  });

  it.each(["session", "worktree"] as const)(
    "discards a pending evidence load after a %s switch",
    async (scope) => {
      const result = await mockedCommands.loadWorktreeChanges("/worktree", {
        base: null,
        target: { kind: "working_tree" },
        merge_base: true,
      });
      mockedCommands.loadWorktreeChanges.mockClear();
      let finish!: (value: typeof result) => void;
      mockedCommands.loadWorktreeChanges.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const messages: ChatSession["messages"] = [
        {
          kind: "assistant",
          timestamp: "2024-01-01T12:00:00Z",
          text:
            "```flow\n" +
            JSON.stringify({
              version: 1,
              parts: [
                {
                  id: "client",
                  kind: "client",
                  attachments: [
                    { kind: "ref", path: "f.ts", line: 6, endLine: 8 },
                  ],
                },
              ],
            }) +
            "\n```",
        },
      ];
      useChatStore.setState({
        sessions: {
          a: createSession({ id: "a", association, messages }),
          b: createSession({
            id: "b",
            association: { ...association, worktreePath: "/other" },
            messages,
          }),
        },
        activeSessionId: "a",
        panelOpen: true,
      });
      const view = render(<ChatWindow sessionId="a" />);
      const activateRef = async () => {
        const player = await screen.findByTestId("flow-player");
        if (!screen.queryByTestId("flow-part-inspector"))
          fireEvent.keyDown(player.querySelector("g[data-part-id='client']")!, {
            key: "Enter",
          });
        fireEvent.click(screen.getByRole("button", { name: "f.ts:6–8" }));
      };
      try {
        await activateRef();
        await waitFor(() =>
          expect(mockedCommands.loadWorktreeChanges).toHaveBeenCalledTimes(1)
        );
        if (scope === "session") view.rerender(<ChatWindow sessionId="b" />);
        else {
          act(() =>
            useChatStore.setState((state) => ({
              sessions: {
                ...state.sessions,
                a: {
                  ...state.sessions.a,
                  association: { ...association, worktreePath: "/replacement" },
                },
              },
            }))
          );
          await screen.findByRole("button", { name: "Toggle diff for f.ts" });
        }
        // Resolve the retired load only after the new scope has mounted.
        await act(async () => finish(result));
        expect(seen.scroll).not.toHaveBeenCalled();
        if (scope === "session")
          expect(
            screen.queryByRole("complementary", { name: "Changes panel" })
          ).toBeNull();
        await activateRef();
        await waitFor(() =>
          expect(seen.scroll).toHaveBeenCalledExactlyOnceWith({
            type: "line",
            id: "f.ts",
            lineNumber: 6,
            side: "additions",
            align: "center",
          })
        );
        expect(mockedCommands.loadWorktreeChanges).toHaveBeenLastCalledWith(
          scope === "session" ? "/other" : "/replacement",
          expect.anything()
        );
      } finally {
        view.unmount();
      }
    }
  );

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
    fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));

    expect(screen.getByTestId("local-chat-pending-comments")).toHaveAttribute(
      "aria-label",
      "1 comments queued for your reply"
    );

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(seen.items).toHaveLength(1));
    await waitFor(() =>
      expect(seen.items[0].annotations).toEqual([
        {
          side: "additions",
          lineNumber: 6,
          metadata: { commentIds: [expect.any(String)], draft: false },
        },
      ])
    );

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    fireEvent.click(screen.getByTitle("Start session"));
    await waitFor(() =>
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          initial_prompt: expect.stringContaining(
            '1. Tool call Edit f.ts · f.ts:6 (new)\n   ```diff\n   @@ -3,6 +3,7 @@\n    l3\n    l4\n    l5\n   +X\n   ```\n   Selected code snapshot: "X"\n   Comment: Why X?'
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
    fireEvent.click(
      await screen.findByRole("button", { name: "gutter code view" })
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { target: { value: "Rename X" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));

    expect(seen.items[0].annotations).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
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
    fireEvent.click(
      await screen.findByRole("button", { name: "gutter code view" })
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { target: { value: "Rename X" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));

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
        comparison: {
          base_commit: "base-sha",
          selected_base_commit: "base-sha",
          target_commit: "head-sha",
          working_tree: true,
          merge_base: true,
        },
        totals: { additions: 2, deletions: 2, binary_files: 0 },
        files: [
          {
            path: "f.ts",
            old_path: null,
            status: "modified",
            marker: null,
            totals: { additions: 1, deletions: 1, binary_files: 0 },
            patch: moved,
          },
        ],
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    await waitFor(() =>
      expect(screen.getByText("outdated")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
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
    fireEvent.click(
      await screen.findByRole("button", { name: "gutter code view" })
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { target: { value: "Rename X" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));

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

describe("Changes panel shortcut registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("only toggles Changes through the shortcut when its own worktree has changes", async () => {
    seedSession();

    let toggle: (() => void) | null = null;
    const register = (next: (() => void) | null) => {
      toggle = next;
    };
    const view = render(
      <ChatWindow sessionId="test-session" registerChangesToggle={register} />
    );

    await waitFor(() => expect(toggle).not.toBeNull());

    const request = {
      base: null,
      target: { kind: "working_tree" as const },
      merge_base: true,
    };
    const changed = await mockedCommands.loadWorktreeChanges(
      "/worktree",
      request
    );

    if (changed.status !== "ok") throw new Error("expected changed fixture");

    mockedCommands.loadWorktreeChanges.mockClear();
    mockedCommands.loadWorktreeChanges.mockResolvedValueOnce({
      status: "ok",
      data: { ...changed.data, files: [] },
    });
    await act(async () => toggle?.());

    expect(
      screen.queryByRole("complementary", { name: "Changes panel" })
    ).toBeNull();
    expect(mockedCommands.loadWorktreeChanges).toHaveBeenCalledExactlyOnceWith(
      "/worktree",
      request
    );

    await act(async () => toggle?.());
    await waitFor(() =>
      expect(
        screen.getByRole("complementary", { name: "Changes panel" })
      ).toBeVisible()
    );
    await act(async () => toggle?.());

    expect(
      screen.queryByRole("complementary", { name: "Changes panel" })
    ).toBeNull();

    view.unmount();

    expect(toggle).toBeNull();
  });

  it("does not register the Changes shortcut for an inactive pane or unassociated conversation", async () => {
    seedSession();

    const register = vi.fn();
    const view = render(
      <ChatWindow
        sessionId="test-session"
        autoFocusComposer={false}
        registerChangesToggle={register}
      />
    );

    expect(register).not.toHaveBeenCalled();

    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          "test-session": {
            ...state.sessions["test-session"],
            association: { ...association, worktreePath: null },
          },
        },
      }));
    });
    view.rerender(
      <ChatWindow sessionId="test-session" registerChangesToggle={register} />
    );

    expect(register).not.toHaveBeenCalled();
  });

  it("ignores a pending shortcut check after the active pane changes", async () => {
    seedSession();

    let toggle: (() => void) | null = null;
    const register = (next: (() => void) | null) => {
      toggle = next;
    };
    const view = render(
      <ChatWindow sessionId="test-session" registerChangesToggle={register} />
    );
    const changed = await mockedCommands.loadWorktreeChanges("/worktree", {
      base: null,
      target: { kind: "working_tree" },
      merge_base: true,
    });
    let finish!: (value: typeof changed) => void;

    mockedCommands.loadWorktreeChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    act(() => toggle?.());
    view.rerender(
      <ChatWindow
        sessionId="test-session"
        autoFocusComposer={false}
        registerChangesToggle={register}
      />
    );
    await act(async () => finish(changed));

    expect(
      screen.queryByRole("complementary", { name: "Changes panel" })
    ).toBeNull();
  });
});
