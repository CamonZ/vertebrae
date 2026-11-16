import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { beforeEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  act,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatSessionContext } from "../thread/toolChange/ChatSessionContext";
import { FileReferenceNavigationContext } from "./FileReferenceNavigationContext";
import {
  MarkdownContent,
  MarkdownProjectRootProvider,
} from "./MarkdownContent";
import { useChatStore } from "../../stores/chatStore";
import type { LocalChatAnnotation } from "../../bindings";

const navigate = vi.fn();
const capture: LocalChatAnnotation = {
  session_id: "s",
  tool_id: "",
  kind: "worktree_history",
  recorded_at: "2026-11-16T00:00:00Z",
  subject: { kind: "turn", id: "old" },
  payload: { worktree: "/captured", state: "ready" },
};

function Surface({ text }: { text: string }) {
  return (
    <ChatSessionContext.Provider value="s">
      <MarkdownProjectRootProvider
        projectPath="/main"
        projectRoots={["/unrelated"]}
      >
        <FileReferenceNavigationContext.Provider value={navigate}>
          <MarkdownContent text={text} referenceReplyId="reply" />
        </FileReferenceNavigationContext.Provider>
      </MarkdownProjectRootProvider>
    </ChatSessionContext.Provider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: {
      s: {
        id: "s",
        label: "History",
        harness: "codex",
        backendSessionId: null,
        providerResumeId: null,
        projectPath: "/main",
        status: "open",
        activityStatus: "working",
        messages: [
          {
            kind: "assistant",
            text: "old reply",
            itemId: "reply",
            turnId: "old",
            timestamp: "then",
          },
          { kind: "user", text: "next turn", timestamp: "now" },
        ],
        toolAnnotations: { '["turn","old"]': { worktree_history: capture } },
      },
    },
  });
});

it("opens the captured turn during a later active turn without persistence or sibling discovery", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  render(
    <Surface text={"Merged into branch master.\n\n[`source`](src/a.ts:12:3)"} />
  );
  const link = screen.getByRole("button", { name: "source" });
  link.focus();
  expect(link).toHaveFocus();

  await userEvent.click(link);

  expect(navigate).toHaveBeenCalledExactlyOnceWith({
    root: "/captured",
    path: "src/a.ts",
    line: 12,
    column: 3,
    history: { sessionId: "s", turnId: "old" },
  });
  expect(storage).not.toHaveBeenCalled();
  expect(screen.queryByText("Change file target")).not.toBeInTheDocument();
  storage.mockRestore();
});

it("leaves method names as code while recognizing dotfiles", () => {
  render(
    <Surface text={"Use `.unwrap()` and `.map`, then edit `.env.local`."} />
  );
  expect(screen.getByText(".unwrap()").tagName).toBe("CODE");
  expect(screen.getByText(".map").tagName).toBe("CODE");
  expect(screen.getByRole("button", { name: ".env.local" })).toBeEnabled();
});

it("keeps JSON formatting when a reply also contains inline code", () => {
  render(
    <Surface text={'Use `value`.\n\n{"name":"example","enabled":true}'} />
  );
  expect(screen.getByText("value").tagName).toBe("CODE");
  expect(document.querySelector("pre")?.textContent).toContain(
    '"name": "example"'
  );
});

it("keeps legacy references focusable with an explicit missing-history explanation", async () => {
  useChatStore.setState({
    sessions: {
      s: {
        ...useChatStore.getState().sessions.s,
        messages: [
          {
            kind: "assistant",
            itemId: "reply",
            text: "legacy",
            timestamp: "then",
          },
        ],
      },
    },
  });
  render(<Surface text="[source](src/a.ts)" />);
  await userEvent.click(screen.getByRole("button", { name: "source" }));

  expect(
    screen.getByRole("button", { name: "source" })
  ).toHaveAccessibleDescription(/Historical context is unavailable/);
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ history: { sessionId: "s", turnId: null } })
  );
});

it("preserves root-level file anchors without allowing executable URI schemes", async () => {
  render(<Surface text="[build](Makefile:12:3) [unsafe](javascript:alert)" />);
  await userEvent.click(screen.getByRole("button", { name: "build" }));
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ path: "Makefile", line: 12, column: 3 })
  );
  expect(
    screen.queryByRole("button", { name: "unsafe" })
  ).not.toBeInTheDocument();
  expect(screen.getByText("unsafe")).not.toHaveAttribute("href");
});

it("never assigns an uncaptured old reply to today's checkout", async () => {
  const session = useChatStore.getState().sessions.s;
  useChatStore.setState({
    sessions: {
      s: {
        ...session,
        toolAnnotations: {},
        association: {
          ticketId: null,
          ticketTitle: null,
          worktreePath: "/later",
          branch: "later",
          lastProcessedAt: null,
          processedAtCount: 0,
          awaitingWorktree: null,
          recentWorktrees: [],
        },
      },
    },
  });
  render(<Surface text="[source](src/a.ts)" />);
  await userEvent.click(screen.getByRole("button", { name: "source" }));
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      root: null,
      history: { sessionId: "s", turnId: "old" },
    })
  );
});

it("retains the established WebKit click-recovery attributes without per-link live announcements", () => {
  render(<Surface text="[source](src/a.ts:12:3)" />);
  const link = screen.getByRole("button", { name: "source" });
  expect(link).toHaveAttribute("data-actionable-reference", "file");
  expect(link).toHaveAttribute("data-file-path", "src/a.ts");
  expect(link).toHaveAttribute("data-file-line", "12");
  expect(link).toHaveAttribute("data-file-column", "3");
  expect(link.querySelector("span")).toHaveClass("pointer-events-none");
});

it("announces missing context through the focused action rather than a transcript of live regions", () => {
  const session = useChatStore.getState().sessions.s;
  useChatStore.setState({
    sessions: { s: { ...session, toolAnnotations: {} } },
  });
  render(<Surface text="[one](a.ts) [two](b.ts) [three](c.ts)" />);
  expect(screen.queryAllByRole("status")).toHaveLength(0);
  for (const button of screen.getAllByRole("button"))
    expect(button).toHaveAccessibleDescription(
      /Historical context is unavailable/
    );
});

it("matches a generated model of association changes, origin delivery, capture delivery and clicks", async () => {
  await hegel.testAsync(
    async (tc) => {
      const original = useChatStore.getState().sessions.s;
      const session = {
        ...original,
        toolAnnotations: {},
        association: {
          ticketId: null,
          ticketTitle: null,
          worktreePath: "/later",
          branch: "later",
          lastProcessedAt: null,
          processedAtCount: 0,
          awaitingWorktree: null,
          recentWorktrees: [],
        },
      };
      useChatStore.setState({ sessions: { s: session } });
      const view = render(<Surface text="[source](src/a.ts)" />);
      let expectedRoot: string | null = null;
      try {
        for (const op of tc.draw(
          gs.arrays(gs.integers({ minValue: 0, maxValue: 3 }), {
            minSize: 1,
            maxSize: 12,
          })
        )) {
          const current = useChatStore.getState().sessions.s;
          if (op === 0) {
            act(() =>
              useChatStore.setState({
                sessions: {
                  s: {
                    ...current,
                    association: {
                      ...session.association,
                      worktreePath: "/unrelated",
                    },
                  },
                },
              })
            );
          } else if (op === 1 || op === 2) {
            const kind = op === 1 ? "worktree_origin" : "worktree_history";
            act(() =>
              useChatStore
                .getState()
                .applyToolAnnotation("s", {
                  ...capture,
                  kind,
                  payload: { worktree: "/original", state: "ready" },
                })
            );
            expectedRoot = "/original";
          } else {
            navigate.mockClear();
            fireEvent.click(view.getByRole("button", { name: "source" }));
            expect(navigate).toHaveBeenCalledWith(
              expect.objectContaining({
                root: expectedRoot,
                history: { sessionId: "s", turnId: "old" },
              })
            );
          }
          navigate.mockClear();
          fireEvent.click(view.getByRole("button", { name: "source" }));
          expect(navigate).toHaveBeenCalledTimes(1);
          expect(navigate).toHaveBeenCalledWith(
            expect.objectContaining({
              root: expectedRoot,
              history: { sessionId: "s", turnId: "old" },
            })
          );
        }
      } finally {
        view.unmount();
        cleanup();
      }
    },
    { seed: 0x51eff010, testCases: 40 }
  );
});
