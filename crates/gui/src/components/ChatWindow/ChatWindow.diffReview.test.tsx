import { useDocumentStore } from "./workspace/documentStore";
import { firePaneControl } from "../../test/paneControls";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  createElement,
  forwardRef,
  useImperativeHandle,
  type ReactNode,
} from "react";
import { ChatWindow } from "./ChatWindow";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { usePendingCommentsStore } from "../../stores/pendingCommentsStore";
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
  evidence: null as {
    items: Array<{ id: string; type: string }>;
    selectedLines: unknown;
  } | null,
  file: null as { name: string; selectedLines: unknown } | null,
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
    // Rows carry Pierre's line numbers so reveals can find them.
    File: (props: {
      file: { name: string; contents: string };
      selectedLines?: unknown;
    }) => {
      seen.file = {
        name: props.file.name,
        selectedLines: props.selectedLines ?? null,
      };
      return createElement(
        "diffs-container",
        { "data-testid": "document-file" },
        props.file.contents.split("\n").map((text, index) => (
          <div key={index} data-line={index + 1}>
            {text}
          </div>
        ))
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
        className?: string;
        selectedLines?: unknown;
      },
      ref
    ) {
      useImperativeHandle(ref, () => ({
        scrollTo: seen.scroll,
        getInstance: () => undefined,
      }));
      if (props.className === "changes-code-view" && !props.renderCustomHeader)
        seen.evidence = {
          items: props.items as unknown as Array<{ id: string; type: string }>,
          selectedLines: props.selectedLines,
        };

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
      worktreeFileExists: vi
        .fn()
        .mockResolvedValue({ status: "ok", data: true }),
      readChatHistoryFile: vi.fn().mockResolvedValue({
        status: "ok",
        data: { kind: "text", contents: "Captured flow source", revision: "turn" },
      }),
      readWorktreeFile: vi
        .fn()
        .mockImplementation(async (_root: string, path: string) => ({
          status: "ok",
          data:
            path === "missing.ts"
              ? { kind: "missing" }
              : {
                  kind: "text",
                  contents: WITH_X.join("\n") + "\n",
                  revision: "r1",
                },
        })),
      readWorktreeBaselineFile: vi
        .fn()
        .mockImplementation(
          async (_root: string, _path: string, commit: string) => ({
            status: "ok",
            data:
              commit === "gone"
                ? { kind: "missing" }
                : {
                    kind: "text",
                    contents:
                      (commit === "head-sha" ? WITH_X : BASE).join("\n") + "\n",
                    revision: commit,
                  },
          })
        ),
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

/** Opens a flow location, which goes straight to the Changes panel. */
async function openReference(location: string) {
  fireEvent.click(screen.getByRole("button", { name: location }));
  const panel = await screen.findByRole("complementary", {
    name: "Changes panel",
  });
  expect(
    screen.queryByRole("complementary", { name: "Evidence panel" })
  ).toBeNull();
  return panel;
}

const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView);

/** The `data-line` of every element a reveal scrolled into view. */
const revealedLines = () =>
  scrollIntoView.mock.contexts
    .map((element) => (element as Element).getAttribute?.("data-line"))
    .filter((line): line is string => line != null)
    .map(Number);

function flowSession(
  attachments: unknown[],
  overrides: Partial<ChatSession> = {}
) {
  const spec = {
    version: 1,
    parts: [{ id: "client", kind: "client", label: "Client", attachments }],
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
        ...overrides,
      }),
    },
    activeSessionId: "test-session",
    panelOpen: true,
  });
}

async function inspectClient() {
  const player = await screen.findByTestId("flow-player");
  if (!screen.queryByTestId("flow-part-inspector"))
    fireEvent.keyDown(player.querySelector("g[data-part-id='client']")!, {
      key: "Enter",
    });
}

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
    seen.evidence = null;
    seen.file = null;
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
    });
  });

  it("opens a changed flow ref directly in Changes with the explorer collapsed", async () => {
    flowSession([{ kind: "ref", path: "f.ts", line: 6, endLine: 8 }]);
    render(<ChatWindow sessionId="test-session" />);
    await inspectClient();
    const panel = await openReference("f.ts:6–8");
    await waitFor(() =>
      expect(seen.scroll).toHaveBeenCalledExactlyOnceWith({
        type: "line",
        id: "f.ts",
        lineNumber: 6,
        side: "additions",
        align: "center",
      })
    );
    expect(
      within(panel).queryByRole("button", { name: "Open in Changes" })
    ).toBeNull();
    expect(within(panel).queryByText(/has no diff/)).toBeNull();
    expect(
      useDocumentStore.getState().workspaces["/worktree"]?.active ?? null
    ).toBeNull();

    // The explorer starts collapsed and can still be expanded by hand.
    const toggle = within(panel).getByRole("button", { name: "Show files" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(panel).queryByRole("navigation", { name: "Changed files" })
    ).toBeNull();
    fireEvent.click(toggle);
    expect(
      within(panel).getByRole("navigation", { name: "Changed files" })
    ).toBeVisible();

    // A repeated click reveals the lines again and collapses the explorer.
    fireEvent.click(screen.getByRole("button", { name: "f.ts:6–8" }));
    await waitFor(() => expect(seen.scroll).toHaveBeenCalledTimes(2));
    expect(
      within(panel).getByRole("button", { name: "Show files" })
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("opens unchanged code as the full file at the referenced lines", async () => {
    const priorDocuments = useDocumentStore.getState().workspaces;
    flowSession([
      { kind: "ref", path: "g.ts", line: 2, endLine: 3 },
      // f.ts changes only at new line 6 (old 6 is where X was inserted).
      { kind: "ref", path: "f.ts", line: 12, endLine: 13 },
      {
        kind: "diff",
        path: "f.ts",
        patch: ALL,
        line: 9,
        endLine: 10,
        side: "old",
      },
      { kind: "ref", path: "f.ts", line: 6, endLine: 8 },
    ]);
    const view = render(<ChatWindow sessionId="test-session" />);
    const active = () =>
      useDocumentStore.getState().workspaces["/worktree"]?.active ?? null;
    const documentView = (path: string) =>
      useDocumentStore.getState().workspaces["/worktree"]?.documents[path]
        ?.view;
    try {
      await inspectClient();

      // An unchanged file: full-file mode, no missing-diff message.
      let panel = await openReference("g.ts:2–3");
      await waitFor(() => expect(active()).toBe("g.ts"));
      expect(await within(panel).findByTestId("document-file")).toBeVisible();
      expect(seen.file).toEqual({
        name: "g.ts",
        selectedLines: { start: 2, end: 3 },
      });
      await waitFor(() => expect(revealedLines()).toEqual([2]));
      expect(within(panel).queryByText(/has no diff/)).toBeNull();
      expect(seen.scroll).not.toHaveBeenCalled();
      expect(
        within(panel).getByRole("button", { name: "Show files" })
      ).toHaveAttribute("aria-expanded", "false");

      // An unchanged range of a file changed elsewhere: its full file.
      fireEvent.click(screen.getByRole("button", { name: "f.ts:12–13" }));
      await waitFor(() => expect(active()).toBe("f.ts"));
      expect(documentView("f.ts")).toBe("file");
      await waitFor(() =>
        expect(seen.file).toEqual({
          name: "f.ts",
          selectedLines: { start: 12, end: 13 },
        })
      );
      await waitFor(() => expect(revealedLines()).toEqual([2, 12]));
      expect(seen.scroll).not.toHaveBeenCalled();

      // Old-side lines are renumbered past the inserted line.
      fireEvent.click(screen.getByRole("button", { name: "f.ts:9–10" }));
      await waitFor(() =>
        expect(seen.file?.selectedLines).toEqual({ start: 10, end: 11 })
      );
      await waitFor(() => expect(revealedLines()).toEqual([2, 12, 10]));

      // An unsaved draft survives revisiting it from a reference.
      act(() =>
        useDocumentStore.setState((state) => {
          const workspace = state.workspaces["/worktree"];
          return {
            workspaces: {
              ...state.workspaces,
              "/worktree": {
                ...workspace,
                documents: {
                  ...workspace.documents,
                  "g.ts": { ...workspace.documents["g.ts"], draft: "edited" },
                },
              },
            },
          };
        })
      );
      fireEvent.click(screen.getByRole("button", { name: "g.ts:2–3" }));
      await waitFor(() => expect(active()).toBe("g.ts"));
      expect(
        useDocumentStore.getState().workspaces["/worktree"].documents["g.ts"]
          .draft
      ).toBe("edited");
      expect(screen.getByText("Unsaved")).toBeVisible();

      // A changed range switches back to All Changes at its diff.
      panel = screen.getByRole("complementary", { name: "Changes panel" });
      fireEvent.click(screen.getByRole("button", { name: "f.ts:6–8" }));
      await waitFor(() =>
        expect(seen.scroll).toHaveBeenCalledExactlyOnceWith({
          type: "line",
          id: "f.ts",
          lineNumber: 6,
          side: "additions",
          align: "center",
        })
      );
      expect(active()).toBeNull();
      expect(within(panel).getByTitle("g.ts")).toHaveTextContent("(unsaved)");
    } finally {
      view.unmount();
      useDocumentStore.setState({ workspaces: priorDocuments });
    }
  });

  it("keeps explicit revision evidence read-only in its own worktree", async () => {
    flowSession([
      {
        kind: "diff",
        path: "f.ts",
        base: "base-sha",
        head: "head-sha",
        line: 4,
        endLine: 5,
        side: "old",
      },
    ]);
    render(<ChatWindow sessionId="test-session" />);
    await inspectClient();
    fireEvent.click(screen.getByRole("button", { name: "f.ts:4–5" }));
    const panel = await screen.findByRole("complementary", {
      name: "Evidence panel",
    });
    expect(await within(panel).findByText("base-sha → head-sha")).toBeVisible();
    expect(
      within(panel).queryByRole("button", { name: "Open in Changes" })
    ).toBeNull();
    expect(
      screen.queryByRole("complementary", { name: "Changes panel" })
    ).toBeNull();
    expect(mockedCommands.readWorktreeBaselineFile).toHaveBeenCalledWith(
      "/worktree",
      "f.ts",
      "head-sha"
    );
  });

  it("opens every kind of code evidence in a project chat without a worktree", async () => {
    const spec = {
      version: 1,
      parts: [
        {
          id: "client",
          kind: "client",
          attachments: [
            { kind: "ref", path: "f.ts", line: 6, endLine: 8 },
            { kind: "ref", path: "g.ts", line: 2, endLine: 3 },
            { kind: "ref", path: "missing.ts", line: 1 },
            {
              kind: "diff",
              path: "f.ts",
              base: "base-sha",
              head: "head-sha",
              line: 4,
              endLine: 5,
              side: "old",
            },
            { kind: "diff", path: "new.ts", base: "gone", head: "head-sha" },
            { kind: "diff", path: "old.ts", base: "gone", head: "gone" },
          ],
        },
      ],
    };
    useChatStore.setState({
      sessions: {
        p: createSession({
          id: "p",
          projectPath: "/project",
          association: { ...association, worktreePath: null },
          messages: [
            {
              kind: "assistant",
              text: "```flow\n" + JSON.stringify(spec) + "\n```",
              timestamp: "2024-01-01T12:00:00Z",
            },
          ],
        }),
      },
      activeSessionId: "p",
      panelOpen: true,
    });
    render(<ChatWindow sessionId="p" />);
    const player = await screen.findByTestId("flow-player");
    fireEvent.keyDown(player.querySelector("g[data-part-id='client']")!, {
      key: "Enter",
    });
    expect(screen.queryByText(/conversation with a worktree/)).toBeNull();
    // Working-copy links use the main checkout's diff and file views.
    let panel = await openReference("f.ts:6–8");
    await waitFor(() =>
      expect(seen.scroll).toHaveBeenLastCalledWith({
        type: "line",
        id: "f.ts",
        lineNumber: 6,
        side: "additions",
        align: "center",
      })
    );
    expect(within(panel).queryByText(/has no diff/)).toBeNull();
    expect(mockedCommands.loadWorktreeChanges).toHaveBeenCalledWith(
      "/project",
      { base: null, target: { kind: "working_tree" }, merge_base: true }
    );

    const scrolled = seen.scroll.mock.calls.length;
    await openReference("f.ts:6–8");
    await waitFor(() => expect(seen.scroll).toHaveBeenCalledTimes(scrolled + 1));

    panel = await openReference("g.ts:2–3");
    expect(await within(panel).findByTestId("document-file")).toBeVisible();
    expect(seen.file).toEqual({
      name: "g.ts",
      selectedLines: { start: 2, end: 3 },
    });
    expect(mockedCommands.readWorktreeFile).toHaveBeenCalledWith("/project", "g.ts");

    const openRevision = async (location: string) => {
      fireEvent.click(screen.getByRole("button", { name: location }));
      return screen.findByRole("complementary", { name: "Evidence panel" });
    };

    // A revision range reads both sides; the lines number the old side.
    panel = await openRevision("f.ts:4–5");
    expect(await within(panel).findByText("base-sha → head-sha")).toBeVisible();
    expect(mockedCommands.readWorktreeBaselineFile).toHaveBeenCalledWith(
      "/project",
      "f.ts",
      "base-sha"
    );
    expect(mockedCommands.readWorktreeBaselineFile).toHaveBeenCalledWith(
      "/project",
      "f.ts",
      "head-sha"
    );
    await waitFor(() =>
      expect(seen.scroll).toHaveBeenLastCalledWith({
        type: "line",
        id: "f.ts",
        lineNumber: 4,
        side: "deletions",
        align: "center",
      })
    );

    panel = await openRevision("new.ts");
    expect(await within(panel).findByText("added")).toBeVisible();

    // Missing paths are reported in place.
    panel = await openRevision("old.ts");
    expect(
      await within(panel).findByText("old.ts does not exist at gone or gone.")
    ).toBeVisible();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Close evidence" })
    );
    expect(
      screen.queryByRole("complementary", { name: "Evidence panel" })
    ).toBeNull();

    panel = await openReference("missing.ts:1");
    expect(await within(panel).findByText("This file no longer exists.")).toBeVisible();
  });

  it("reveals a recorded flow range in a main-checkout conversation", async () => {
    const flow = {
      version: 1,
      parts: [{
        id: "client",
        kind: "client",
        attachments: [{ kind: "ref", path: "f.ts", line: 6, endLine: 8 }],
      }],
    };
    flowSession([], {
      projectPath: "/project",
      association: { ...association, worktreePath: null },
      messages: [{
        kind: "assistant",
        itemId: "reply",
        turnId: "recorded",
        text: "```flow\n" + JSON.stringify(flow) + "\n```",
        timestamp: "2024-01-01T12:00:00Z",
      }],
      toolAnnotations: {
        '["turn","recorded"]': {
          worktree_origin: {
            session_id: "test-session",
            tool_id: "",
            subject: { kind: "turn", id: "recorded" },
            kind: "worktree_origin",
            recorded_at: "2024-01-01T12:00:00Z",
            payload: { worktree: "/project", epoch: "fixture" },
          },
        },
      },
    });
    render(<ChatWindow sessionId="test-session" />);
    await inspectClient();

    const panel = await openReference("f.ts:6–8");
    expect(await within(panel).findByText("Recorded turn contents · Read-only")).toBeVisible();
    expect(mockedCommands.readChatHistoryFile).toHaveBeenCalledExactlyOnceWith(
      "test-session", "recorded", "f.ts"
    );
    expect(mockedCommands.readWorktreeFile).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(seen.evidence?.selectedLines).toEqual({
        id: "f.ts",
        range: { start: 6, end: 8 },
      })
    );
    expect(seen.evidence?.items[0].type).toBe("file");
    expect(screen.getByRole("button", { name: "f.ts:6–8" })).toBeVisible();
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
                    // Spans the old-side position where X was inserted.
                    line: 5,
                    endLine: 6,
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
          const line = action === "ref" ? 6 : 5;
          openOwner = session;
          request = { session, worktree, line };
          // Changes opens directly and scrolls once.
          expectedScrollCount++;
          const player = await screen.findByTestId("flow-player");
          if (!screen.queryByTestId("flow-part-inspector"))
            fireEvent.keyDown(
              player.querySelector("g[data-part-id='client']")!,
              { key: "Enter" }
            );
          await openReference(action === "ref" ? "f.ts:6–8" : "f.ts:5–6");
        } else if (action === "toggle") {
          const opening: boolean = openOwner !== session;
          openOwner = opening ? session : null;
          if (
            opening &&
            request?.session === session &&
            request.worktree === worktree
          )
            expectedScrollCount++;
          firePaneControl("Changes");
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
        }
        // The evidence belongs to the retired scope and is no longer shown.
        expect(
          screen.queryByRole("complementary", { name: "Evidence panel" })
        ).toBeNull();
        // Resolve the retired load only after the new scope has mounted.
        await act(async () => finish(result));
        expect(seen.scroll).not.toHaveBeenCalled();
        expect(
          screen.queryByRole("complementary", { name: "Evidence panel" })
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

  it("returns focus to the chat input after adding and editing a comment", async () => {
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
    const composer = screen.getByTestId("local-chat-composer");
    await waitFor(() => expect(composer).toHaveFocus());

    fireEvent.mouseEnter(screen.getByTestId("local-chat-pending-comment"));
    fireEvent.click(screen.getByRole("button", { name: "Edit comment 1" }));
    const editor = screen.getByTestId("local-chat-comment-editor");
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: "Why X here?" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });

    await waitFor(() => expect(composer).toHaveFocus());
    fireEvent.mouseEnter(screen.getByTestId("local-chat-pending-comment"));
    expect(screen.getByTestId("local-chat-comment-body")).toHaveTextContent(
      "Why X here?"
    );
  });

  it.each(["selection", "focused control"])(
    "respects newer %s intent before restoring composer focus after a comment edit",
    (intent) => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
      const selection = window.getSelection()!;
      try {
        useChatStore.setState({
          sessions: {
            "test-session": createSession({
              association,
              messages: [
                {
                  kind: "assistant",
                  itemId: "a1",
                  text: "First paragraph has a key phrase. It also explains the result.",
                  timestamp: "2024-01-01T12:00:00Z",
                },
              ],
            }),
          },
          activeSessionId: "test-session",
          panelOpen: true,
        });
        usePendingCommentsStore.setState({
          byScope: {
            "test-session:/worktree": [
              {
                kind: "text",
                id: "c1",
                responseId: "a1",
                itemId: "a1",
                quote: "key phrase",
                contextBefore: "",
                contextAfter: "",
                body: "Explain this wording.",
              },
            ],
          },
        });
        const view = render(
          <>
            <ChatWindow sessionId="test-session" />
            <input aria-label="Another control" />
          </>
        );
        fireEvent.mouseEnter(screen.getByTestId("local-chat-pending-comment"));
        fireEvent.click(screen.getByRole("button", { name: "Edit comment 1" }));
        fireEvent.change(screen.getByTestId("local-chat-comment-editor"), {
          target: { value: "Please explain the key phrase." },
        });
        fireEvent.click(screen.getByTestId("local-chat-save-edited-comment"));

        // New user intent can arrive before the edit's deferred focus callback.
        const paragraph = view.container.querySelector(
          "[data-local-chat-assistant-response-id] p"
        )!;
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selectParagraph = () => {
          selection.removeAllRanges();
          selection.addRange(range);
          fireEvent(document, new Event("selectionchange"));
        };
        if (intent === "selection") selectParagraph();
        else screen.getByRole("textbox", { name: "Another control" }).focus();
        act(() => vi.runOnlyPendingTimers());

        expect(screen.getByTestId("local-chat-composer")).not.toHaveFocus();
        if (intent === "focused control") {
          expect(
            screen.getByRole("textbox", { name: "Another control" })
          ).toHaveFocus();
          selectParagraph();
        }
        const trigger = screen.getByRole("button", { name: "Add comment" });
        const shortcut = trigger.querySelector("kbd")!.textContent;
        expect(trigger).toHaveAttribute(
          "title",
          `Comment on the selected text (${shortcut})`
        );
        if (intent === "focused control") {
          fireEvent.keyDown(
            screen.getByRole("textbox", { name: "Another control" }),
            {
              key: "Enter",
              ctrlKey: true,
            }
          );
          expect(screen.queryByTestId("local-chat-comment-draft")).toBeNull();
          fireEvent.click(trigger);
        } else {
          fireEvent.keyDown(document.body, { key: "Tab" });
          expect(trigger).toHaveFocus();
          selection.removeAllRanges();
          fireEvent(document, new Event("selectionchange"));
          expect(trigger).toHaveFocus();
          fireEvent.keyDown(trigger, { key: "Enter", metaKey: true });
        }
        const draft = screen.getByTestId("local-chat-comment-draft");
        expect(draft).toHaveFocus();
        fireEvent.change(draft, {
          target: { value: "Clarify the whole paragraph." },
        });
        fireEvent.click(screen.getByTestId("local-chat-save-comment"));
        expect(
          usePendingCommentsStore.getState().byScope["test-session:/worktree"]
        ).toEqual([
          expect.objectContaining({
            id: "c1",
            body: "Please explain the key phrase.",
          }),
          expect.objectContaining({
            quote: paragraph.textContent,
            body: "Clarify the whole paragraph.",
          }),
        ]);
      } finally {
        selection.removeAllRanges();
        vi.useRealTimers();
      }
    }
  );

  it("keeps staged comments when the chat window is closed and reopened", async () => {
    seedSession();
    const view = render(<ChatWindow sessionId="test-session" />);
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
    expect(screen.getAllByTestId("local-chat-pending-comment")).toHaveLength(1);

    view.unmount();
    render(<ChatWindow sessionId="test-session" />);
    expect(screen.getAllByTestId("local-chat-pending-comment")).toHaveLength(1);
  });

  /*
   * Staged comments belong to a conversation and worktree, not to the chat
   * window (ticket 3845ab6b). Model: a list per session. Closing, reopening
   * and switching windows never change it; only an accepted send clears the
   * sending session's list, and only that one.
   */
  it("keeps staged comments per conversation through close, reopen and switch until sent", async () => {
    const SESSIONS = ["s1", "s2"];
    const scope = (id: string) => `${id}:/worktree`;
    await hegel.testAsync(
      async (tc) => {
        useChatStore.setState({
          sessions: Object.fromEntries(
            SESSIONS.map((id) => [id, createSession({ id, association })])
          ),
          activeSessionId: "s1",
          panelOpen: true,
        });
        usePendingCommentsStore.setState({ byScope: {} });
        const model = new Map(SESSIONS.map((id) => [id, [] as string[]]));
        let next = 0;
        type Open = { id: string; view: ReturnType<typeof render> };
        let open = null as Open | null;
        const show = (id: string) => {
          open?.view.unmount();
          open = { id, view: render(<ChatWindow sessionId={id} />) };
        };
        const chips = () =>
          screen
            .queryAllByTestId("local-chat-pending-comment")
            .map((chip) => chip.textContent ?? "");
        const check = () => {
          for (const id of SESSIONS)
            expect(
              (usePendingCommentsStore.getState().byScope[scope(id)] ?? []).map(
                (comment) => comment.id
              )
            ).toEqual(model.get(id));
          if (!open) return expect(chips()).toEqual([]);
          const staged = model.get(open.id)!;
          expect(chips()).toHaveLength(staged.length);
          staged.forEach((id, index) => expect(chips()[index]).toContain(id));
        };

        try {
          const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
          for (let step = 0; step < steps; step++) {
            const action = tc.draw(
              gs.sampledFrom(["stage", "open", "close", "remove"])
            );
            const session = tc.draw(gs.sampledFrom(SESSIONS));
            if (action === "stage") {
              // As "Send to main chat" or another pane would stage it.
              const id = `q${next++}`;
              act(() =>
                usePendingCommentsStore
                  .getState()
                  .update(scope(session), (c) => [
                    ...c,
                    {
                      kind: "text",
                      id,
                      responseId: "r",
                      itemId: null,
                      quote: id,
                      contextBefore: "",
                      contextAfter: "",
                      body: `about ${id}`,
                    },
                  ])
              );
              model.get(session)!.push(id);
            }
            if (action === "open") act(() => show(session));
            if (action === "close" && open) {
              act(() => open!.view.unmount());
              open = null;
            }
            if (action === "remove" && open && model.get(open.id)!.length) {
              const staged = model.get(open.id)!;
              const at = tc.draw(
                gs.integers({ minValue: 0, maxValue: staged.length - 1 })
              );
              fireEvent.mouseEnter(
                screen.getAllByTestId("local-chat-pending-comment")[at]
              );
              fireEvent.click(
                screen.getByRole("button", { name: `Remove comment ${at + 1}` })
              );
              staged.splice(at, 1);
            }
            check();
          }

          // Sending from one conversation clears only its comments.
          const sender = tc.draw(gs.sampledFrom(SESSIONS));
          tc.assume(model.get(sender)!.length > 0);
          act(() => show(sender));
          fireEvent.click(screen.getByTitle("Start session"));
          await waitFor(() => expect(chips()).toEqual([]));
          model.set(sender, []);
          check();
        } finally {
          open?.view.unmount();
        }
      },
      { testCases: 25 }
    );
  }, 120_000);

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

    firePaneControl("Changes");
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

    firePaneControl("Changes");
    fireEvent.click(screen.getByTitle("Start session"));
    await waitFor(() =>
      expect(mockedCommands.createLocalChatSession).toHaveBeenCalledWith(
        expect.objectContaining({
          initial_prompt: expect.stringContaining(
            "1. Tool call Edit f.ts · f.ts:6 (new)\n   ```diff\n   @@ -3,3 +3,4 @@\n    l3\n    l4\n    l5\n   +X\n   ```\n\n   Why X?"
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
    firePaneControl("Changes");
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

    firePaneControl("Changes");
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
    // Changes is closed, so its toggle sits in the overflow menu.
    expect(screen.queryByTestId("local-chat-view-changes")).toBeNull();
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
    firePaneControl("Changes");
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
    firePaneControl("Changes");
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
    firePaneControl("Changes");
    await waitFor(() => expect(seen.items).toHaveLength(1));
    fireEvent.click(
      await screen.findByRole("button", { name: "gutter code view" })
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "New diff comment" }),
      { target: { value: "Rename X" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send to main chat" }));
    firePaneControl("Changes");

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

  it("toggles the main checkout's Changes through the shortcut without changes of its own", async () => {
    seedSession();
    // A chat on the main checkout: its worktree is the project itself.
    act(() => {
      useChatStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          "test-session": {
            ...state.sessions["test-session"],
            projectPath: "/worktree",
          },
        },
      }));
    });

    let toggle: (() => void) | null = null;
    render(
      <ChatWindow
        sessionId="test-session"
        registerChangesToggle={(next) => {
          toggle = next;
        }}
      />
    );
    await waitFor(() => expect(toggle).not.toBeNull());
    mockedCommands.loadWorktreeChanges.mockClear();

    act(() => toggle?.());
    // Opened at once: there Changes compares other refs too.
    expect(
      screen.getByRole("complementary", { name: "Changes panel" })
    ).toBeVisible();
    act(() => toggle?.());
    expect(
      screen.queryByRole("complementary", { name: "Changes panel" })
    ).toBeNull();
  });

  it("does not register the Changes shortcut for an inactive pane or unassociated conversation", async () => {
    seedSession();

    const register = vi.fn();
    const view = render(
      <ChatWindow
        sessionId="test-session"
        isForegroundPane={false}
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
        isForegroundPane={false}
        registerChangesToggle={register}
      />
    );
    await act(async () => finish(changed));

    expect(
      screen.queryByRole("complementary", { name: "Changes panel" })
    ).toBeNull();
  });
});
