import { useEffect, useRef } from "react";
import { commands } from "../bindings";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import { useChatAttentionStore } from "../stores/chatAttentionStore";
import {
  chatTurnSignals,
  type CompletedTurn,
  type TurnDecision,
} from "../utils/chatAttention";
import { localChatActivityStatus } from "../utils/localChatActivity";

/** What to do about a chat's latest completed root turn. */
export type TurnAttentionPlan =
  | { kind: "skip" }
  /** Live completion: one decision-model question at most. */
  | { kind: "ask"; turn: CompletedTurn }
  /** Replayed history: reuse a stored answer, never ask. */
  | { kind: "lookup"; turn: CompletedTurn };

/**
 * Decides whether a completed root turn warrants the turn-end check. No
 * question for child threads, discussions, cancelled or failed turns, turns
 * with a deterministic signal, queued follow-ups, or turns already decided.
 * `live` means this runtime was observed running the turn; anything else is
 * history replay.
 */
export function planTurnAttention(
  session: ChatSession,
  decisions: Readonly<Record<string, TurnDecision>>,
  viewedTurnKey: string | null,
  live: boolean
): TurnAttentionPlan {
  if (session.discussion || session.providerChild) return { kind: "skip" };
  const signals = chatTurnSignals(session.messages);
  const turn = signals.completedTurn;
  if (!turn || turn.key in decisions) return { kind: "skip" };
  if (signals.blocked || session.lifecycle === "error") return { kind: "skip" };
  if (session.gate) return { kind: "skip" };
  if (!live) return viewedTurnKey === turn.key ? { kind: "skip" } : { kind: "lookup", turn };
  // A queued message starts the next turn at once: the user already replied.
  if ((session.queuedMessages?.length ?? 0) > 0) return { kind: "skip" };
  return { kind: "ask", turn };
}

const decisionOf = {
  needs_you: "needs_you",
  your_turn: "your_turn",
  undecided: "undecided",
} as const satisfies Record<string, TurnDecision>;

/**
 * Runs the turn-end check for one chat: asks when a live root turn completes
 * without a deterministic signal, and looks up stored answers for replayed
 * history. Failures never surface to the user; the chat shows your-turn.
 */
export function useChatAttentionDriver(sessionId: string) {
  const messages = useChatStore((s) => s.sessions[sessionId]?.messages);
  const working = useChatStore((s) => {
    const session = s.sessions[sessionId];
    return !!session && localChatActivityStatus(session) === "working";
  });
  const replayLoading = useChatStore(
    (s) => !!s.sessions[sessionId]?.providerReplay?.loading
  );
  const sawWorking = useRef(false);

  useEffect(() => {
    if (working) sawWorking.current = true;
  }, [working]);

  useEffect(
    () => () => useChatAttentionStore.getState().forgetSession(sessionId),
    [sessionId]
  );

  useEffect(() => {
    if (!messages || working || replayLoading) return;
    const session = useChatStore.getState().sessions[sessionId];
    if (!session) return;
    const attention = useChatAttentionStore.getState();
    const plan = planTurnAttention(
      session,
      attention.decisions[sessionId] ?? {},
      attention.viewed[sessionId] ?? null,
      sawWorking.current
    );
    // The run is consumed by the turn it completed, which may arrive after
    // the lifecycle settles.
    if (plan.kind === "skip") return;
    sawWorking.current = false;

    const { turn } = plan;
    const record = (decision: TurnDecision) =>
      useChatAttentionStore
        .getState()
        .setTurnDecision(sessionId, turn.key, decision);
    record(plan.kind === "ask" ? "asking" : "undecided");

    void commands
      .classifyChatTurnAttention({
        project_path: session.projectPath ?? null,
        session_id: sessionId,
        turn_key: turn.key,
        message: turn.message,
        allow_inference: plan.kind === "ask",
      })
      .then((result) => {
        if (result.status === "ok") record(decisionOf[result.data]);
        else {
          console.info("[chat_attention] turn check unavailable", {
            sessionId,
            error: result.error.message,
          });
          if (plan.kind === "ask") record("your_turn");
        }
      })
      .catch((error: unknown) => {
        console.info("[chat_attention] turn check failed", { sessionId, error });
        if (plan.kind === "ask") record("your_turn");
      });
  }, [messages, working, replayLoading, sessionId]);
}
