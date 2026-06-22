/**
 * chatMessagesToThread — PURE adapter: chatStore `ChatMessage[]` → canonical
 * `Thread` for the unified <Thread> primitive (chat surface).
 *
 * This mirrors the OLD `groupChatMessages` branch-for-branch so the local
 * claude-subprocess chat renders through the SAME recursive Thread primitive as
 * Traces, differing only by capability flags
 * (mode="bare" reveal="shallow" interactive showHead={false}).
 *
 * Grouping contract (1:1 with the prior machinery):
 *   · session_start / session_end → dropped (no row).
 *   · user                        → opens a new Turn with a UserMessage
 *                                   {role:'human', label:'You'}.
 *   · assistant                   → pushes an AgentMessage{speaker:'Claude'}
 *                                   into the open turn (a headless turn opens if
 *                                   none); `isPartial` → `streaming`.
 *   · tool_call                   → a ToolMessage{status:'pending'} pushed into
 *                                   the ACTIVE AgentMessage.tools (a headless
 *                                   agent opens if a tool arrives first). `Bash`
 *                                   → kind:'shell' with the command as `cmd`.
 *   · tool_result                 → MERGED into the matching pending ToolMessage
 *                                   by toolId (status ok/err, body=result).
 *   · error / warning             → a terminal ErrorMessage{title}.
 *   · permission_request          → SKIPPED here; ChatWindow renders the
 *                                   interactive PermissionRequestTurn as a
 *                                   sibling of <Thread>.
 *
 * Tools are NESTED under the AgentMessage (the chat layout), each wired to a
 * collapse toggle via the `collapsed` Set + `onToggleTool`.
 *
 * Returns ONE Thread{id:'local-chat-thread'} — rendered depth=0, no head.
 */

import type { ChatMessage } from "../../stores/chatStore";
import type {
  AgentMessage,
  ErrorMessage,
  Thread,
  ToolMessage,
  Turn,
  UserMessage,
} from "../thread/types";

export interface ChatThreadOptions {
  /** Toggle a tool body's collapsed state (interactive surfaces). */
  onToggleTool?: (toolId: string) => void;
  /**
   * Optional set of tool ids whose bodies are currently COLLAPSED. When omitted,
   * tools start collapsed and the row self-toggles on click (uncontrolled).
   */
  collapsed?: Set<string>;
  /**
   * Whether the chat is awaiting a response (last message was the user). Carried
   * for parity with the caller; not consumed here (the ThinkingIndicator is a
   * sibling of <Thread>). Present so the option bag matches the call site.
   */
  isWaiting?: boolean;
}

/** Stable thread id for the single local-chat thread. */
export const LOCAL_CHAT_THREAD_ID = "local-chat-thread";

export function chatMessagesToThread(
  messages: readonly ChatMessage[],
  opts: ChatThreadOptions
): Thread {
  const { onToggleTool, collapsed } = opts;

  const turns: Turn[] = [];
  let curTurn: Turn | null = null;
  let activeAgent: AgentMessage | null = null;

  // Per-call monotonic counters → stable React keys / selection ids.
  let turnSeq = 0;
  let agentSeq = 0;
  let errSeq = 0;

  const openTurn = (): Turn => {
    const t: Turn = { id: `chat-turn-${turnSeq++}`, messages: [] };
    turns.push(t);
    return t;
  };

  const openAgent = (): AgentMessage => {
    if (!curTurn) curTurn = openTurn();
    const am: AgentMessage = {
      evt: `chat-agent-${agentSeq++}`,
      type: "agent",
      speaker: "Claude",
      tools: [],
      prose: "",
    };
    curTurn.messages.push(am);
    activeAgent = am;
    return am;
  };

  for (const m of messages) {
    switch (m.kind) {
      case "session_start":
      case "session_end":
        continue;

      case "user": {
        // A human turn closes any open agent and starts a fresh turn.
        activeAgent = null;
        curTurn = openTurn();
        const um: UserMessage = {
          evt: `chat-user-${turnSeq}`,
          type: "user",
          role: "human",
          label: "You",
          text: m.text,
        };
        curTurn.messages.push(um);
        continue;
      }

      case "assistant": {
        if (!curTurn) curTurn = openTurn();
        const am: AgentMessage = {
          evt: `chat-agent-${agentSeq++}`,
          type: "agent",
          speaker: "Claude",
          model: undefined,
          streaming: m.isPartial,
          prose: m.text,
          tools: [],
        };
        curTurn.messages.push(am);
        activeAgent = am;
        continue;
      }

      case "tool_call": {
        // A tool may arrive before any assistant prose — open a headless agent
        // so the tool has a container.
        const agent = activeAgent ?? openAgent();
        const isShell = m.toolName === "Bash";
        const tool: ToolMessage = {
          evt: m.toolId,
          type: "tool",
          status: "pending",
          // Collapsed by default; self-toggles on click. Honours an external
          // Set/onToggle if a caller supplies one.
          collapsed: collapsed ? collapsed.has(m.toolId) : true,
          onToggle: onToggleTool ? () => onToggleTool(m.toolId) : undefined,
        };
        if (isShell) {
          tool.kind = "shell";
          tool.cmd = extractShellCommand(m.input);
        } else {
          tool.kind = "fn";
          tool.name = m.toolName;
        }
        (agent.tools ??= []).push(tool);
        continue;
      }

      case "tool_result": {
        // Merge into the matching PENDING ToolMessage by toolId.
        const slot = findPendingTool(activeAgent, m.toolId);
        if (slot) {
          slot.status = m.isError ? "err" : "ok";
          slot.error = m.isError || undefined;
          slot.body = m.result;
        }
        continue;
      }

      case "error": {
        // Terminal error row — its own headless turn so it stands alone.
        activeAgent = null;
        const turn = openTurn();
        curTurn = turn;
        const err: ErrorMessage = {
          evt: `chat-error-${errSeq++}`,
          type: "error",
          title: m.message,
        };
        turn.messages.push(err);
        continue;
      }

      case "warning": {
        activeAgent = null;
        const turn = openTurn();
        curTurn = turn;
        const err: ErrorMessage = {
          evt: `chat-warning-${errSeq++}`,
          type: "error",
          title: m.message,
        };
        turn.messages.push(err);
        continue;
      }

      case "permission_request":
        // Rendered as an interactive sibling of <Thread> by ChatWindow.
        continue;
    }
  }

  return { id: LOCAL_CHAT_THREAD_ID, turns };
}

/** Find the still-pending ToolMessage with this id in the active agent's tools. */
function findPendingTool(
  agent: AgentMessage | null,
  toolId: string
): ToolMessage | undefined {
  if (!agent?.tools) return undefined;
  return agent.tools.find((t) => t.evt === toolId && t.status === "pending");
}

/**
 * Pull a human-readable shell command out of a tool_call `input` string. The
 * input is a JSON blob like `{"command":"ls -la"}`; fall back to the raw input
 * when it isn't parseable or carries no `command`.
 */
function extractShellCommand(input: string): string {
  try {
    const parsed = JSON.parse(input) as { command?: unknown };
    if (typeof parsed.command === "string" && parsed.command.length > 0) {
      return parsed.command;
    }
  } catch {
    // Not JSON — fall through to the raw input.
  }
  return input;
}
