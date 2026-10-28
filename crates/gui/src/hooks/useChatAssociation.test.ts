import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type JsonValue } from "../bindings";
import { useChatStore, type ChatMessage } from "../stores/chatStore";
import { getProjectScopeGeneration } from "../stores/projectScopedStores";
import {
  noteRecordingTarget,
  useChatAssociation,
  useChatAssociationDriver,
} from "./useChatAssociation";

vi.mock("../bindings", () => ({
  commands: {
    resolveChatAssociation: vi.fn(),
    getCurrentProjectPath: vi.fn(),
    setLocalChatRecordingWorktree: vi.fn(),
  },
}));
vi.mock("../stores/projectScopedStores", () => ({
  getProjectScopeGeneration: vi.fn(() => 0),
}));
const TICKET = { id: "f6f6bf5e-2ca1-4e50-bcfa-9e08944eaa78", title: "Retry" };
vi.mock("../utils/chatAssociation/candidates", () => ({
  cachedAssociationCandidates: () => [TICKET],
}));

const resolve = vi.mocked(commands.resolveChatAssociation);
const setTarget = vi.mocked(commands.setLocalChatRecordingWorktree);
/** The global driver plus what a chat window reads. */
const useDriven = (sessionId: string) => {
  useChatAssociationDriver(sessionId);
  return useChatAssociation(sessionId);
};
const reply = (data: object) =>
  resolve.mockResolvedValueOnce({
    status: "ok",
    data: {
      selection: { kind: "keep" },
      worktrees: [],
      create_worktree: false,
      diagnostic: null,
      ...data,
    },
  } as never);
const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;
const user = (text: string, n: number): ChatMessage => ({
  kind: "user",
  text,
  timestamp: at(n),
});
const tool = (input: string, n: number): ChatMessage => ({
  kind: "tool_call",
  toolName: "Bash",
  toolId: `t${n}`,
  input,
  timestamp: at(n),
});
const toolResult = (result: string, n: number): ChatMessage => ({
  kind: "tool_result",
  toolId: `t${n}`,
  result,
  isError: false,
  timestamp: at(n),
});
const SELECT = { selection: { kind: "ticket", id: TICKET.id } };
const main = { path: "/p", branch: "master" };
const created = {
  path: "/p/.claude/worktrees/f6f6bf5e-codex-retry-status",
  branch: "worktree-f6f6bf5e-codex-retry-status",
};

function seed(
  messages: ChatMessage[],
  association: unknown = null,
  runtime: object = {}
) {
  const patch = (id: string, value: object) =>
    useChatStore.setState((s) => ({
      sessions: { ...s.sessions, [id]: { ...s.sessions[id], ...value } },
    }));
  useChatStore.setState({
    sessions: {
      s1: { id: "s1", projectPath: "/p", messages, association, ...runtime },
    },
    setSessionAssociation: (id: string, value: unknown) =>
      patch(id, { association: value as JsonValue }),
    setSessionAssociationDiagnostic: (id: string, value: string | null) =>
      patch(id, { associationDiagnostic: value }),
  } as never);
}
const setRuntime = (value: object) =>
  act(() =>
    useChatStore.setState((s) => ({
      sessions: { ...s.sessions, s1: { ...s.sessions.s1, ...value } },
    }))
  );
const push = (message: ChatMessage) =>
  act(() =>
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        s1: {
          ...s.sessions.s1,
          messages: [...s.sessions.s1.messages, message],
        },
      },
    }))
  );

describe("useChatAssociation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectScopeGeneration).mockReturnValue(0);
    setTarget.mockResolvedValue({ status: "ok", data: null } as never);
    vi.mocked(commands.getCurrentProjectPath).mockResolvedValue({
      status: "ok",
      data: "/p",
    } as never);
  });

  it("binds the worktree a requested creation reveals, then stops asking (conversation 2f611cd8)", async () => {
    reply({ ...SELECT, create_worktree: true, worktrees: [main] });
    seed([
      user(
        `Let's check the ${TICKET.id}, is what needs to be done clear? Let's create a worktree for it`,
        1
      ),
    ]);
    const { result } = renderHook(() => useDriven("s1"));
    await waitFor(() => expect(result.current.record.ticketId).toBe(TICKET.id));
    expect(result.current.record.awaitingWorktree).toEqual(["/p"]);
    expect(resolve.mock.calls[0][0]).toMatchObject({
      ticket_id: null,
      worktree_path: null,
    });

    reply({ worktrees: [main] }); // inspecting the main checkout is not the new worktree
    push(tool("vtb show f6f6bf5e", 2));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(result.current.record.worktreePath).toBeNull();

    reply({ worktrees: [created] });
    push(
      toolResult(
        `Created worktree at “${created.path}” on branch “${created.branch}”.`,
        3
      )
    );
    await waitFor(() =>
      expect(result.current.record.worktreePath).toBe(created.path)
    );
    expect(result.current.record.awaitingWorktree).toBeNull();

    push(user("ok, let's implement the ticket in the worktree", 4));
    push(tool(`cat ${created.path}/a.rs`, 5));
    await waitFor(() =>
      expect(result.current.record.lastProcessedAt).toBe(at(5))
    );
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("attaches a worktree touched before the ticket was known", async () => {
    reply({ worktrees: [created] });
    seed([tool(`ls ${created.path}`, 1)]);
    const { result } = renderHook(() => useDriven("s1"));
    await waitFor(() =>
      expect(result.current.record.recentWorktrees).toEqual([created])
    );
    expect(result.current.record.worktreePath).toBeNull();

    reply(SELECT);
    push(user("implement f6f6bf5e", 2));
    await waitFor(() =>
      expect(result.current.record.worktreePath).toBe(created.path)
    );
  });

  it("skips a failed decision with a diagnostic so later events progress", async () => {
    reply({ diagnostic: "Decision request timed out." });
    seed([user("implement f6f6bf5e", 1)]);
    const { result } = renderHook(() => useDriven("s1"));
    await waitFor(() =>
      expect(result.current.diagnostic).toBe("Decision request timed out.")
    );
    expect(result.current.record.lastProcessedAt).toBe(at(1));

    reply(SELECT);
    push(user("implement f6f6bf5e", 2));
    await waitFor(() => expect(result.current.record.ticketId).toBe(TICKET.id));
    expect(result.current.diagnostic).toBeNull();
  });

  it("sends the selected project's path, not its slug, as the cache root", async () => {
    reply({});
    seed([user("implement f6f6bf5e", 1)]);
    renderHook(() => useDriven("s1"));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    expect(resolve.mock.calls[0][0].candidate_project_root).toBe("/p");
  });

  it("drops a result when a newer user message arrives meanwhile", async () => {
    let release!: (value: never) => void;
    resolve.mockReturnValueOnce(new Promise((r) => (release = r)) as never);
    seed([user("implement f6f6bf5e", 1)]);
    const { result } = renderHook(() => useDriven("s1"));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    push(user("actually never mind", 2));
    reply({});
    reply({});
    release({
      status: "ok",
      data: {
        ...SELECT,
        worktrees: [],
        create_worktree: false,
        diagnostic: null,
      },
    } as never);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(3));
    expect(result.current.record.ticketId).toBeNull();
  });

  it("keeps an ambiguous pair of newly touched worktrees unbound", async () => {
    reply({ ...SELECT, create_worktree: true, worktrees: [main] });
    seed([user("implement f6f6bf5e in a new worktree", 1)]);
    const { result } = renderHook(() => useDriven("s1"));
    await waitFor(() => expect(result.current.record.ticketId).toBe(TICKET.id));
    reply({
      worktrees: [created, { path: "/other/f6f6bf5e", branch: "f6f6bf5e" }],
    });
    push(tool("git worktree list", 2));
    await waitFor(() =>
      expect(result.current.record.lastProcessedAt).toBe(at(2))
    );
    expect(result.current.record.worktreePath).toBeNull();
    expect(result.current.record.awaitingWorktree).toEqual(["/p"]);
  });

  it.each(["root", "generation"])(
    "drops a late response after %s changes",
    async (change) => {
      let release!: (value: never) => void;
      resolve.mockReturnValueOnce(new Promise((r) => (release = r)) as never);
      seed([user("implement f6f6bf5e", 1)]);
      const { result } = renderHook(() => useDriven("s1"));
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      reply({});
      if (change === "generation") {
        vi.mocked(getProjectScopeGeneration).mockReturnValue(1);
      } else {
        act(() =>
          useChatStore.setState((s) => ({
            sessions: {
              ...s.sessions,
              s1: { ...s.sessions.s1, projectPath: "/other" },
            },
          }))
        );
      }
      await act(async () =>
        release({
          status: "ok",
          data: {
            ...SELECT,
            worktrees: [],
            create_worktree: false,
            diagnostic: null,
          },
        } as never)
      );
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
      expect(result.current.record.ticketId).toBeNull();
    }
  );

  it("processes events sharing a timestamp once each, and not again after reload", async () => {
    reply({});
    reply({ worktrees: [created] });
    seed([tool("ls /p", 1), tool(`ls ${created.path}`, 1)]);
    const first = renderHook(() => useDriven("s1"));
    await waitFor(() =>
      expect(first.result.current.record.processedAtCount).toBe(2)
    );
    expect(first.result.current.record.recentWorktrees).toEqual([created]);
    first.unmount();

    const again = renderHook(() => useDriven("s1"));
    await act(async () => undefined);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(again.result.current.record.recentWorktrees).toEqual([created]);
  });
  it("pushes a live runtime's new worktree, never the target it was created with", async () => {
    noteRecordingTarget("local-s1-1", null);
    reply({ worktrees: [created] });
    seed(
      [],
      {
        ticketId: TICKET.id,
        ticketTitle: TICKET.title,
        worktreePath: null,
        branch: null,
        lastProcessedAt: null,
        processedAtCount: 0,
        awaitingWorktree: null,
        recentWorktrees: [],
      },
      { backendSessionId: "local-s1-1", lifecycle: "idle" }
    );
    const { result } = renderHook(() => useDriven("s1"));
    await act(async () => undefined);
    expect(setTarget).not.toHaveBeenCalled();

    push(tool(`ls ${created.path}`, 1));
    await waitFor(() =>
      expect(result.current.record.worktreePath).toBe(created.path)
    );
    await waitFor(() =>
      expect(setTarget).toHaveBeenCalledWith("local-s1-1", created.path)
    );
    expect(setTarget).toHaveBeenCalledTimes(1);
  });

  it("holds the target while the runtime starts, then sends it to the new runtime", async () => {
    const bound = {
      ticketId: TICKET.id,
      ticketTitle: TICKET.title,
      worktreePath: created.path,
      branch: created.branch,
      lastProcessedAt: null,
      processedAtCount: 0,
      awaitingWorktree: null,
      recentWorktrees: [],
    };
    seed([], bound, { backendSessionId: "local-s1-2", lifecycle: "starting" });
    renderHook(() => useDriven("s1"));
    await act(async () => undefined);
    expect(setTarget).not.toHaveBeenCalled();

    setRuntime({ lifecycle: "idle" });
    await waitFor(() =>
      expect(setTarget).toHaveBeenCalledWith("local-s1-2", created.path)
    );
  });

  it("drops a target result that arrives after the runtime was replaced", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let release!: (value: never) => void;
    setTarget.mockReturnValueOnce(new Promise((r) => (release = r)) as never);
    const bound = {
      ticketId: null,
      ticketTitle: null,
      worktreePath: created.path,
      branch: null,
      lastProcessedAt: null,
      processedAtCount: 0,
      awaitingWorktree: null,
      recentWorktrees: [],
    };
    seed([], bound, { backendSessionId: "local-s1-3", lifecycle: "idle" });
    renderHook(() => useDriven("s1"));
    await waitFor(() => expect(setTarget).toHaveBeenCalledTimes(1));
    setRuntime({ backendSessionId: null, lifecycle: "closed" });
    await act(async () =>
      release({
        status: "error",
        error: { SessionNotFound: "local-s1-3" },
      } as never)
    );

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the previous target and records the diagnostic when resolving throws", async () => {
    const bound = {
      ticketId: null,
      ticketTitle: null,
      worktreePath: created.path,
      branch: created.branch,
      lastProcessedAt: null,
      processedAtCount: 0,
      awaitingWorktree: null,
      recentWorktrees: [],
    };
    noteRecordingTarget("local-s1-4", created.path);
    resolve.mockRejectedValueOnce(new Error("IPC unavailable"));
    seed([user("implement something else", 1)], bound, {
      backendSessionId: "local-s1-4",
      lifecycle: "idle",
    });
    const { result } = renderHook(() => useDriven("s1"));

    await waitFor(() =>
      expect(result.current.diagnostic).toBe("IPC unavailable")
    );
    expect(result.current.record.worktreePath).toBe(created.path);
    expect(result.current.record.lastProcessedAt).toBe(at(1));
    expect(setTarget).not.toHaveBeenCalled();
  });

  it("lets a window correct the record the global driver keeps", async () => {
    reply({ worktrees: [created] });
    seed([tool(`ls ${created.path}`, 1)]);
    const driver = renderHook(() => useChatAssociationDriver("s1"));
    const view = renderHook(() => useChatAssociation("s1"));
    await waitFor(() =>
      expect(view.result.current.record.recentWorktrees).toEqual([created])
    );

    act(() => view.result.current.correct("f6f6bf5e"));

    expect(view.result.current.record.ticketId).toBe(TICKET.id);
    expect(view.result.current.record.worktreePath).toBe(created.path);
    expect(view.result.current.diagnostic).toBeNull();
    driver.unmount();
  });
});
