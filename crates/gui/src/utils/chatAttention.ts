import type { ChatMessage, ChatSession } from "../stores/chatStore";
import { localChatActivityStatus } from "./localChatActivity";

/**
 * Attention states of a chat, in priority order (ticket 1f3f5cc0, decision
 * record 49d12c2c §3). One presentation is shared by the pane header, the
 * history row and the launcher, so a state looks the same wherever a chat
 * appears.
 */
export type ChatAttentionState =
  | "blocked"
  | "error"
  | "needs-you"
  | "your-turn"
  | "running"
  | "idle"
  | "closed";

export interface ChatAttention {
  state: ChatAttentionState;
  /** Short reason, e.g. "Permission: Bash"; null when the label suffices. */
  reason: string | null;
  /** When the chat entered this state (ISO); orders the jump list. */
  since: string | null;
}

export type ChatAttentionTone = "accent" | "err" | "mute" | "ok" | "hollow";

export interface ChatAttentionPresentation {
  readonly label: string;
  /** Dot treatment; `null` draws no dot (idle). */
  readonly tone: ChatAttentionTone | null;
  /** Counts toward "N need you" and the jump order. */
  readonly needsUser: boolean;
}

/**
 * Accent for blocked and needs-you, err (no glow) for error, a muted dot for
 * your-turn, the ok dot with the running glow for running (glow means
 * running, nothing else), no dot for idle and a hollow faint dot for closed.
 */
export const CHAT_ATTENTION: Readonly<
  Record<ChatAttentionState, ChatAttentionPresentation>
> = {
  blocked: { label: "Blocked", tone: "accent", needsUser: true },
  error: { label: "Error", tone: "err", needsUser: true },
  "needs-you": { label: "Needs you", tone: "accent", needsUser: true },
  "your-turn": { label: "Your turn", tone: "mute", needsUser: false },
  running: { label: "Running", tone: "ok", needsUser: false },
  idle: { label: "Idle", tone: null, needsUser: false },
  closed: { label: "Closed", tone: "hollow", needsUser: false },
};

export const NEEDS_YOU_REASON = "Asked you something";

/** Accessible text for a chat's state, e.g. "Blocked: Permission: Bash". */
export function chatAttentionText(attention: ChatAttention): string {
  const { label } = CHAT_ATTENTION[attention.state];
  return attention.reason ? `${label}: ${attention.reason}` : label;
}

/** The turn-end decision recorded for one completed root turn. */
export type TurnDecision =
  /** A live completion is being judged; shows as your-turn meanwhile. */
  | "asking"
  | "needs_you"
  | "your_turn"
  /** Replayed history with no stored answer: nothing to show. */
  | "undecided";

/** Per-chat attention record kept beside the chat store. */
export interface ChatAttentionRecord {
  /** Decisions keyed by completed-turn identity. */
  decisions: Readonly<Record<string, TurnDecision>>;
  /** The latest completed turn the user has viewed. */
  viewedTurnKey: string | null;
}

/** A completed root turn: the user message it answered and its last reply. */
export interface CompletedTurn {
  /** Stable across live delivery and provider replay. */
  key: string;
  /** The turn's last root assistant message (may be empty). */
  message: string;
  endedAt: string;
}

/** Deterministic signals read from the transcript; no model involved. */
export interface ChatTurnSignals {
  /** Pending permission/question/plan request in the current turn. */
  blocked: { reason: string; since: string } | null;
  /** Latest successful root turn not followed by a user message. */
  completedTurn: CompletedTurn | null;
  /** The turn ended without success (cancelled or failed). */
  endedUnsuccessfully: boolean;
}

const isRoot = (message: ChatMessage) =>
  !("parentToolUseId" in message && message.parentToolUseId);

/** FNV-1a 64-bit, hex: a compact local identity, not a security boundary. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function permissionReason(toolName: string) {
  return toolName === "ExitPlanMode" ? "Plan" : `Permission: ${toolName}`;
}

const signalCache = new WeakMap<readonly ChatMessage[], ChatTurnSignals>();

/**
 * Reads the current turn's deterministic signals. Only root messages count:
 * child-thread work never blocks or completes the chat. Requests followed by
 * a turn end are stale (the runtime that asked is gone).
 */
export function chatTurnSignals(
  messages: readonly ChatMessage[]
): ChatTurnSignals {
  const cached = signalCache.get(messages);
  if (cached) return cached;

  let blocked: ChatTurnSignals["blocked"] = null;
  let end: Extract<ChatMessage, { kind: "session_end" }> | null = null;
  let lastAssistant: string | null = null;
  let userText: string | null = null;
  let sawEnd = false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!isRoot(message)) continue;
    if (message.kind === "user") {
      userText = message.text;
      break;
    }
    if (message.kind === "session_end") {
      // Only the newest end describes the current turn.
      if (!sawEnd) end = message;
      sawEnd = true;
      continue;
    }
    if (!sawEnd && !blocked) {
      if (
        message.kind === "permission_request" &&
        message.requestId &&
        (message.status ?? "pending") === "pending"
      )
        blocked = {
          reason: permissionReason(message.toolName),
          since: message.timestamp,
        };
      else if (message.kind === "user_question" && message.status === "pending")
        blocked = { reason: "Question", since: message.timestamp };
    }
    if (
      sawEnd &&
      end &&
      lastAssistant === null &&
      message.kind === "assistant" &&
      !message.isPartial
    )
      lastAssistant = message.text;
  }

  const completedTurn =
    end?.successful === true
      ? {
          key: fnv1a64(
            [
              userText ?? "",
              lastAssistant ?? "",
              end.durationMs,
              end.numTurns,
            ].join("\u0000")
          ),
          message: lastAssistant ?? "",
          endedAt: end.timestamp,
        }
      : null;

  const signals: ChatTurnSignals = {
    blocked,
    completedTurn,
    endedUnsuccessfully: !!end && end.successful !== true,
  };
  signalCache.set(messages, signals);
  return signals;
}

type AttentionSession = Pick<
  ChatSession,
  | "messages"
  | "status"
  | "lifecycle"
  | "activeTurn"
  | "compactionActive"
  | "backgroundWork"
  | "gate"
  | "gateStatus"
  | "updatedAt"
>;

const IDLE: ChatAttention = { state: "idle", reason: null, since: null };

/**
 * The chat's attention state. Deterministic signals win over the turn-end
 * decision; your-turn and needs-you clear once the latest turn is viewed and
 * whenever the user replies (a newer user message leaves no completed turn).
 */
export function deriveChatAttention(
  session: AttentionSession,
  record: ChatAttentionRecord | undefined
): ChatAttention {
  const signals = chatTurnSignals(session.messages);
  const working = localChatActivityStatus(session as ChatSession) === "working";
  const closed = session.status === "closed" || session.lifecycle === "closed";

  if (signals.blocked && !closed) return { state: "blocked", ...signals.blocked };
  const gatePhase = session.gate ? session.gateStatus?.phase : null;
  if (
    !working &&
    !closed &&
    (gatePhase === "drafting" || gatePhase === "rejected")
  )
    return {
      state: "blocked",
      reason: "Gate",
      since: session.gateStatus?.waitingSince ?? null,
    };
  if (session.lifecycle === "error")
    return { state: "error", reason: null, since: session.updatedAt ?? null };

  const turn = signals.completedTurn;
  if (turn && !working && record?.viewedTurnKey !== turn.key) {
    const decision = record?.decisions[turn.key];
    if (decision === "needs_you")
      return { state: "needs-you", reason: NEEDS_YOU_REASON, since: turn.endedAt };
    if (decision === "your_turn" || decision === "asking")
      return { state: "your-turn", reason: null, since: turn.endedAt };
  }

  if (working) return { state: "running", reason: null, since: null };
  if (closed) return { state: "closed", reason: null, since: null };
  return IDLE;
}

const JUMP_PRIORITY: Readonly<Partial<Record<ChatAttentionState, number>>> = {
  blocked: 0,
};

/**
 * The "next chat needing you" order over chats needing the user (blocked,
 * error, needs-you): blocked first, then oldest; ties keep input order.
 */
export function chatAttentionJumpOrder<
  T extends { id: string; attention: ChatAttention },
>(chats: readonly T[]): T[] {
  return chats
    .map((chat, index) => ({ chat, index }))
    .filter(({ chat }) => CHAT_ATTENTION[chat.attention.state].needsUser)
    .sort(
      (a, b) =>
        (JUMP_PRIORITY[a.chat.attention.state] ?? 1) -
          (JUMP_PRIORITY[b.chat.attention.state] ?? 1) ||
        (a.chat.attention.since ?? "").localeCompare(
          b.chat.attention.since ?? ""
        ) ||
        a.index - b.index
    )
    .map(({ chat }) => chat);
}

/** The jump target after `currentId`, wrapping; null when nothing waits. */
export function nextChatNeedingYou<
  T extends { id: string; attention: ChatAttention },
>(chats: readonly T[], currentId: string | null): T | null {
  const order = chatAttentionJumpOrder(chats);
  if (order.length === 0) return null;
  const at = order.findIndex((chat) => chat.id === currentId);
  return order[(at + 1) % order.length];
}
