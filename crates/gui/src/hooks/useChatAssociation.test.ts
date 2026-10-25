import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type JsonValue } from "../bindings";
import { useChatStore, type ChatMessage } from "../stores/chatStore";
import { useChatAssociation } from "./useChatAssociation";

vi.mock("../bindings", () => ({
  commands: { resolveChatAssociation: vi.fn(), getCurrentProjectPath: vi.fn() },
}));
const TICKET = { id: "f6f6bf5e-2ca1-4e50-bcfa-9e08944eaa78", title: "Retry" };
vi.mock("../utils/chatAssociation/candidates", () => ({
  cachedAssociationCandidates: () => [TICKET],
}));

const resolve = vi.mocked(commands.resolveChatAssociation);
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

function seed(messages: ChatMessage[], association: unknown = null) {
  useChatStore.setState({
    sessions: { s1: { id: "s1", projectPath: "/p", messages, association } },
    setSessionAssociation: (id: string, value: unknown) =>
      useChatStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [id]: { ...s.sessions[id], association: value as JsonValue },
        },
      })),
  } as never);
}
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
    const { result } = renderHook(() => useChatAssociation("s1"));
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
    const { result } = renderHook(() => useChatAssociation("s1"));
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
    const { result } = renderHook(() => useChatAssociation("s1"));
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
    renderHook(() => useChatAssociation("s1"));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    expect(resolve.mock.calls[0][0].candidate_project_root).toBe("/p");
  });

  it("drops a result when a newer user message arrives meanwhile", async () => {
    let release!: (value: never) => void;
    resolve.mockReturnValueOnce(new Promise((r) => (release = r)) as never);
    seed([user("implement f6f6bf5e", 1)]);
    const { result } = renderHook(() => useChatAssociation("s1"));
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

  it("processes events sharing a timestamp once each, and not again after reload", async () => {
    reply({});
    reply({ worktrees: [created] });
    seed([tool("ls /p", 1), tool(`ls ${created.path}`, 1)]);
    const first = renderHook(() => useChatAssociation("s1"));
    await waitFor(() =>
      expect(first.result.current.record.processedAtCount).toBe(2)
    );
    expect(first.result.current.record.recentWorktrees).toEqual([created]);
    first.unmount();

    const again = renderHook(() => useChatAssociation("s1"));
    await act(async () => undefined);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(again.result.current.record.recentWorktrees).toEqual([created]);
  });
});
