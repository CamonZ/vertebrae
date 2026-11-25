import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createMockTask, render } from "../test/test-utils";
import { commands } from "../bindings";
import { queryClient } from "../query/queryClient";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import {
  resetWorktreePrChecksStore,
  useWorktreePrChecksStore,
} from "../stores/worktreePrChecksStore";
import { resetWorktreePrStore, worktreePrKey } from "../stores/worktreePrStore";
import { chatPrTargets, isWatchedEntity } from "../utils/prPollTargets";
import { PrPollTargets } from "./PrPollTargets";

vi.mock("../bindings", () => ({
  commands: {
    getTask: vi.fn(),
    pollWorktreePrs: vi.fn(),
    getWorktreePublishedHead: vi.fn(),
  },
}));

const getTask = vi.mocked(commands.getTask);
const poll = vi.mocked(commands.pollWorktreePrs);

function session(
  id: string,
  association: Record<string, unknown> | null,
  overrides: Partial<ChatSession> = {}
): ChatSession {
  return {
    id,
    label: id,
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    association: association && {
      ticketTitle: null,
      lastProcessedAt: null,
      processedAtCount: 0,
      awaitingWorktree: null,
      recentWorktrees: [],
      ...association,
    },
    ...overrides,
  } as ChatSession;
}

const SESSIONS = {
  open: session("open", {
    ticketId: "aaaaaaaa-0000",
    worktreePath: "/wt/open",
    branch: "ticket/open",
  }),
  done: session("done", {
    ticketId: "bbbbbbbb-0000",
    worktreePath: "/wt/done",
    branch: "ticket/done",
  }),
  archived: session("archived", {
    ticketId: "cccccccc-0000",
    worktreePath: "/wt/archived",
    branch: "ticket/archived",
  }),
  sameBranch: session("same-branch", {
    ticketId: "aaaaaaaa-0000",
    worktreePath: "/wt/open",
    branch: "ticket/open",
  }),
  creationDefault: session("default", {
    ticketId: "dddddddd-0000",
    worktreePath: "/project",
    branch: "main",
    defaultWorktree: true,
  }),
  noTicket: session("no-ticket", {
    ticketId: null,
    worktreePath: "/wt/loose",
    branch: "loose",
  }),
  noBranch: session("no-branch", {
    ticketId: "eeeeeeee-0000",
    worktreePath: "/wt/detached",
    branch: null,
  }),
  discussion: session(
    "discussion",
    { ticketId: "ffffffff-0000", worktreePath: "/wt/d", branch: "d" },
    {
      discussion: {
        worktreePath: "/wt/d",
        reviewThreadId: "thread-1",
        parentChatId: "open",
      },
    } as Partial<ChatSession>
  ),
};

describe("chatPrTargets", () => {
  it("takes one target per associated worktree branch", () => {
    expect(chatPrTargets({ sessions: SESSIONS })).toEqual([
      {
        worktreePath: "/wt/archived",
        branch: "ticket/archived",
        entityId: "cccccccc-0000",
      },
      {
        worktreePath: "/wt/done",
        branch: "ticket/done",
        entityId: "bbbbbbbb-0000",
      },
      {
        worktreePath: "/wt/open",
        branch: "ticket/open",
        entityId: "aaaaaaaa-0000",
      },
    ]);
  });

  it("keeps unknown entities and drops finished or archived ones", () => {
    expect(isWatchedEntity(undefined)).toBe(true);
    expect(isWatchedEntity(undefined, true)).toBe(false);
    expect(isWatchedEntity(createMockTask())).toBe(true);
    expect(
      isWatchedEntity(createMockTask({ completed_at: "2026-11-20T10:00:00Z" }))
    ).toBe(false);
    expect(isWatchedEntity(createMockTask({ archived: true }))).toBe(false);
  });
});

describe("PrPollTargets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    getTask.mockImplementation(async (id) => ({
      status: "ok",
      data: createMockTask({
        id,
        completed_at: id.startsWith("bbbb") ? "2026-11-20T10:00:00Z" : null,
        archived: id.startsWith("cccc"),
      }),
    }));
    poll.mockImplementation(async (targets) => ({
      status: "ok",
      data: {
        results: targets.map((target) => ({
          ...target,
          result: { status: "not_linked" as const },
        })),
        holdOffSecs: null,
      },
    }));
    useChatStore.setState({ sessions: SESSIONS });
  });

  afterEach(() => {
    resetWorktreePrChecksStore();
    resetWorktreePrStore();
  });

  it("polls the worktrees of chats on unfinished tickets only", async () => {
    const view = render(<PrPollTargets />);
    await vi.waitFor(() => expect(poll).toHaveBeenCalled());
    // Nothing is asked before the tickets are known to be unfinished.
    expect(poll).toHaveBeenCalledExactlyOnceWith([
      { worktreePath: "/wt/open", branch: "ticket/open" },
    ]);
    expect(Object.keys(useWorktreePrChecksStore.getState().entries)).toEqual([
      worktreePrKey("/wt/open", "ticket/open"),
    ]);

    view.unmount();
    await act(async () => {});
    expect(useWorktreePrChecksStore.getState().entries).toEqual({});
  });
});
